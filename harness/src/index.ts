import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  DB: D1Database;
  JWT_SECRET: string;
}

/** One sandbox per agent run: an isolated Linux container with /workspace. */
export class Sandbox extends DurableObject<Env> {
  private container() {
    const c = this.ctx.container;
    if (!c) throw new Error("The container binding is not configured.");
    return c;
  }

  async ensureRunning(): Promise<void> {
    const c = this.container();
    if (!c.running) {
      c.start({ image: c.images.sandbox, enableInternet: true });
    }
    for (let i = 0; i < 40; i++) {
      try {
        const proc = await c.exec(["/bin/true"], {});
        await proc.output();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error("The sandbox container did not start in time.");
  }

  async runCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const c = this.container();
    const proc = await c.exec(["/bin/bash", "-lc", command], { cwd });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        proc.output(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            try {
              proc.kill();
            } catch {
              /* already exited */
            }
            reject(new Error(`Command timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
        }),
      ]);
      const td = new TextDecoder();
      return { stdout: td.decode(out.stdout), stderr: td.decode(out.stderr), exitCode: out.exitCode };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async readFile(path: string): Promise<string> {
    const files = new Files(this.container());
    const res = await files.readFile(path);
    return new TextDecoder().decode(await res.arrayBuffer());
  }

  async writeFile(path: string, content: string): Promise<void> {
    const files = new Files(this.container());
    await files.writeFile(path, content);
  }
}

// ---------- auth (same HS256 JWT the Rust backend signs) ----------

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyJwt(secret: string, token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// ---------- http helpers ----------

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...CORS,
  };
}

function send(writer: WritableStreamDefaultWriter<Uint8Array>, type: string, data: unknown): Promise<void> {
  const enc = new TextEncoder();
  return writer.write(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
}

async function bearerSub(req: Request, env: Env): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return verifyJwt(env.JWT_SECRET, auth.slice(7).trim());
}

// ---------- provider + pricing (mirrors the Rust backend) ----------

interface Provider {
  preset: string;
  baseUrl: string;
  apiKey: string;
}

function normalizeBaseUrl(raw: string): string {
  let s = raw.trim();
  for (;;) {
    const t = s.replace(/\/+$/, "");
    if (t.endsWith("/chat/completions")) {
      s = t.slice(0, -"/chat/completions".length);
      continue;
    }
    return t;
  }
}

async function teamProvider(db: D1Database, teamId: string, userId: string): Promise<Provider> {
  const member = await db
    .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
    .bind(teamId, userId)
    .first<{ role: string }>();
  if (!member) throw new Error("You are not on that team.");
  const team = await db
    .prepare("SELECT provider, provider_base_url, provider_api_key FROM teams WHERE id = ?")
    .bind(teamId)
    .first<{ provider: string; provider_base_url: string; provider_api_key: string }>();
  if (!team) throw new Error("Team not found.");
  const baseUrl = team.provider_base_url.trim()
    ? normalizeBaseUrl(team.provider_base_url)
    : "";
  const apiKey = (team.provider_api_key || "").trim();
  const local = /localhost|127\.0\.0\.1|192\.168\.|10\.|\.local/.test(baseUrl);
  if (!apiKey && !local) throw new Error("No model key is set for this team — add it in Teams settings.");
  if (!baseUrl) throw new Error("This provider needs a base URL — set it in Teams settings.");
  return { preset: (team.provider || "custom").trim() || "custom", baseUrl, apiKey };
}

// Per-1M-token prices for known Go models (input, output). Unknown models are
// logged with estimated cost so usage stays visible.
const GO_PRICES: Record<string, [number, number]> = {
  "glm-5.3-flash": [0.15, 0.5],
  "glm-5.3": [1.4, 4.4],
  "glm-5.2": [1.4, 4.4],
  "kimi-k2.7-code": [0.95, 4.0],
  "kimi-k3": [3.0, 15.0],
  "deepseek-v4.1-flash": [0.3, 1.2],
  "deepseek-v4-pro": [1.32, 3.96],
  "qwen3.8-flash": [0.15, 0.47],
  "qwen3.8-max": [2.0, 6.0],
  "muse-spark-1.3-contributor": [0.1, 0.2],
  "muse-spark-1.2-contributor": [0.1, 0.2],
};

async function recordUsage(
  db: D1Database,
  userId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  const rate = GO_PRICES[model];
  const cost = rate
    ? (promptTokens * rate[0] + completionTokens * rate[1]) / 1_000_000
    : (promptTokens + completionTokens * 2) / 1_000_000;
  const estimated = rate ? 0 : 1;
  await db
    .prepare(
      "INSERT INTO usage_logs (user_id, slavebot_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, estimated, audio_seconds) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0)",
    )
    .bind(userId, `${model} (harness)`, promptTokens, completionTokens, promptTokens + completionTokens, cost, estimated)
    .run()
    .catch(() => {});
}

// ---------- upstream chat (chat/completions, with /responses fallback) ----------

interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

interface Completion {
  text: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
}

function upstreamHeaders(prov: Provider, session: string): Headers {
  const h = new Headers();
  h.set("Content-Type", "application/json");
  if (prov.apiKey) h.set("Authorization", `Bearer ${prov.apiKey}`);
  h.set("HTTP-Referer", "https://slaver.app");
  h.set("X-Title", "Slaver harness");
  if (prov.baseUrl.includes("opencode.ai")) h.set("x-opencode-session", session.slice(0, 128));
  return h;
}

function extractResponsesText(v: unknown): string | null {
  const items = (v as { output?: unknown[] })?.output;
  if (!Array.isArray(items)) return null;
  let out = "";
  for (const item of items) {
    const it = item as { type?: string; content?: unknown[] };
    if (it.type !== "message" || !Array.isArray(it.content)) continue;
    for (const c of it.content) {
      const cc = c as { type?: string; text?: string };
      if ((cc.type === "output_text" || cc.type === "text") && typeof cc.text === "string") {
        if (out) out += "\n";
        out += cc.text;
      }
    }
  }
  return out.trim() ? out : null;
}

async function callChat(
  prov: Provider,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  session: string,
): Promise<Completion> {
  const headers = upstreamHeaders(prov, session);
  const payload = { model, messages, tools, tool_choice: "auto" as const };
  let res = await fetch(`${prov.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  let data: unknown = null;
  let via: "chat" | "responses" = "chat";
  if ((res.status === 400 || res.status === 404) && prov.baseUrl.includes("opencode.ai")) {
    // Responses-only models (e.g. muse-spark-*) — retry via /responses.
    const r = await fetch(`${prov.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        tools: tools.map((t) => ({
          type: "function",
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }),
    });
    if (r.ok) {
      res = r;
      via = "responses";
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = "";
    try {
      const v = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = v.error?.message || v.message || "";
    } catch {
      detail = text.slice(0, 300);
    }
    throw new Error(`Model API error (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  data = await res.json();
  const d = data as {
    choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    output?: { type?: string; name?: string; arguments?: string; call_id?: string }[];
    usage?: { prompt_tokens?: number; input_tokens?: number; completion_tokens?: number; output_tokens?: number };
  };
  let text = "";
  const toolCalls: ToolCall[] = [];
  if (via === "chat") {
    const msg = d.choices?.[0]?.message;
    text = (typeof msg?.content === "string" ? msg.content : "") || "";
    for (const tc of msg?.tool_calls || []) {
      toolCalls.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments || "{}" });
    }
  } else {
    text = extractResponsesText(d) || "";
    for (const item of d.output || []) {
      if (item.type === "function_call" && item.name) {
        toolCalls.push({ id: item.call_id || `call_${Math.random().toString(36).slice(2)}`, name: item.name, args: item.arguments || "{}" });
      }
    }
  }
  const usage = d.usage || {};
  return {
    text,
    toolCalls,
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}

// ---------- tools (executed inside the Sandbox container) ----------

const WORKSPACE = "/workspace";

function confined(path: string): string {
  let p = path.trim();
  if (!p) throw new Error("path is required.");
  if (!p.startsWith("/")) p = `${WORKSPACE}/${p}`;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const clean = `/${parts.join("/")}`;
  if (clean !== WORKSPACE && !clean.startsWith(`${WORKSPACE}/`)) {
    throw new Error("Only /workspace is writable in this harness.");
  }
  return clean;
}

function truncate(s: string, max = 12_000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "exec",
      description: "Run a shell command in the sandbox (Debian Linux, /workspace is the project dir). Use for building, testing, git, listing files, installing packages. Long commands time out after 120s.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command, e.g. ls -la or npm test" },
          workdir: { type: "string", description: "Working directory, defaults to /workspace" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the sandbox. Paths are relative to /workspace unless absolute.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write (create or overwrite) a text file in the sandbox. Parent dirs are created. Paths are relative to /workspace unless absolute.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are Slaver Harness, a coding agent like Codex/Claude Code running inside an isolated Debian Linux sandbox. The project lives in /workspace.

Rules:
- Explore before changing: list files, read the relevant code first.
- Make small, verifiable edits; run the project's own checks (build, tests, typecheck) after changes.
- Prefer minimal diffs; do not reformat unrelated code.
- If a command fails, read the error and adapt — don't repeat the same failing command.
- When done, summarize what changed and how it was verified.`;

const MAX_STEPS = 12;

// ---------- run endpoints ----------

async function startRun(req: Request, env: Env): Promise<Response> {
  const userId = await bearerSub(req, env);
  if (!userId) return json({ error: "Unauthorized." }, 401);
  let body: { team_id?: string; model?: string; prompt?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  const teamId = (body.team_id || "").trim();
  const model = (body.model || "").trim();
  const prompt = (body.prompt || "").trim();
  if (!teamId || !model || !prompt) {
    return json({ error: "team_id, model, and prompt are required." }, 400);
  }
  if (prompt.length > 8000) return json({ error: "prompt must be 1..8000 characters." }, 400);
  let prov: Provider;
  try {
    prov = await teamProvider(env.DB, teamId, userId);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Provider unavailable." }, 400);
  }

  const runId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO runs (id, user_id, team_id, model, prompt, status) VALUES (?, ?, ?, ?, ?, 'running')",
  )
    .bind(runId, userId, teamId, model, prompt)
    .run();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (type: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      try {
        await runAgent(env, { runId, userId, teamId, model, prompt, prov }, emit, req.signal);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Run failed.";
        emit("error", { message: msg });
        await env.DB.prepare("UPDATE runs SET status = 'error' WHERE id = ?").bind(runId).run().catch(() => {});
        await env.DB.prepare("INSERT INTO run_steps (run_id, kind, name, output) VALUES (?, 'error', '', ?)")
          .bind(runId, msg)
          .run()
          .catch(() => {});
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

interface RunCtx {
  runId: string;
  userId: string;
  teamId: string;
  model: string;
  prompt: string;
  prov: Provider;
}

async function runAgent(
  env: Env,
  ctx: RunCtx,
  emit: (type: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const sbx = env.Sandbox.getByName(`run-${ctx.runId}`);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: ctx.prompt },
  ];
  const session = `slaver-harness-${ctx.runId}`;
  emit("run", { run_id: ctx.runId, model: ctx.model });

  let stepCount = 0;
  await env.DB.prepare("INSERT INTO run_steps (run_id, kind, name, output) VALUES (?, 'prompt', '', ?)")
    .bind(ctx.runId, ctx.prompt)
    .run()
    .catch(() => {});

  try {
    await sbx.ensureRunning();
    await sbx.runCommand("mkdir -p /workspace && ls -la /workspace", "/", 30_000);
  } catch (e) {
    throw new Error(`Sandbox unavailable: ${e instanceof Error ? e.message : e}`);
  }

  let totalPrompt = 0;
  let totalCompletion = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) throw new Error("Run stopped by user.");
    stepCount++;
    emit("step", { n: stepCount });
    let done: Completion;
    try {
      done = await callChat(ctx.prov, ctx.model, messages, TOOL_DEFS, session);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "Model call failed.");
    }
    totalPrompt += done.promptTokens;
    totalCompletion += done.completionTokens;

    const assistantMsg: ChatMessage = { role: "assistant", content: done.text || "" };
    if (done.toolCalls.length > 0) {
      assistantMsg.tool_calls = done.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    messages.push(assistantMsg);

    if (done.text.trim()) {
      emit("text", { text: done.text });
      await env.DB.prepare("INSERT INTO run_steps (run_id, kind, name, output) VALUES (?, 'text', '', ?)")
        .bind(ctx.runId, done.text.slice(0, 8000))
        .run()
        .catch(() => {});
    }

    if (done.toolCalls.length === 0) break;

    for (const tc of done.toolCalls) {
      if (signal.aborted) throw new Error("Run stopped by user.");
      let args: Record<string, string>;
      try {
        args = JSON.parse(tc.args) as Record<string, string>;
      } catch {
        args = {};
      }
      emit("tool_call", { name: tc.name, args });
      let output: string;
      try {
        if (tc.name === "exec") {
          const command = (args.command || "").trim();
          if (!command) throw new Error("command is required.");
          if (command.length > 4000) throw new Error("command too long (max 4000 chars).");
          const workdir = args.workdir ? confined(args.workdir) : WORKSPACE;
          const res = await sbx.runCommand(command, workdir, 120_000);
          output = `exit=${res.exitCode}\n${truncate((res.stdout || "") + (res.stderr ? `\n[stderr]\n${res.stderr}` : ""))}`;
        } else if (tc.name === "read_file") {
          const path = confined(args.path || "");
          try {
            output = truncate(await sbx.readFile(path));
          } catch (e) {
            throw new Error(`Cannot read ${path}: ${e instanceof Error ? e.message : e}`);
          }
        } else if (tc.name === "write_file") {
          const path = confined(args.path || "");
          const dir = path.split("/").slice(0, -1).join("/") || "/";
          const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
          await sbx.runCommand(`mkdir -p ${quoted}`, "/", 15_000);
          try {
            await sbx.writeFile(path, args.content || "");
          } catch (e) {
            throw new Error(`Cannot write ${path}: ${e instanceof Error ? e.message : e}`);
          }
          output = `Wrote ${path} (${(args.content || "").length} chars).`;
        } else {
          throw new Error(`Unknown tool: ${tc.name}`);
        }
      } catch (e) {
        output = `ERROR: ${e instanceof Error ? e.message : e}`;
      }
      emit("tool_result", { name: tc.name, output: output.slice(0, 4000) });
      await env.DB.prepare("INSERT INTO run_steps (run_id, kind, name, output) VALUES (?, 'tool', ?, ?)")
        .bind(ctx.runId, tc.name, `${tc.name} ${truncate(JSON.stringify(args), 500)}\n${output}`.slice(0, 8000))
        .run()
        .catch(() => {});
      messages.push({ role: "tool", content: output, tool_call_id: tc.id });
    }
  }

  await recordUsage(env.DB, ctx.userId, ctx.model, totalPrompt, totalCompletion);
  await env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(ctx.runId).run().catch(() => {});
  emit("done", { steps: stepCount, prompt_tokens: totalPrompt, completion_tokens: totalCompletion });
}

async function listRuns(req: Request, env: Env): Promise<Response> {
  const userId = await bearerSub(req, env);
  if (!userId) return json({ error: "Unauthorized." }, 401);
  const url = new URL(req.url);
  const teamId = url.searchParams.get("team_id") || "";
  const rows = teamId
    ? await env.DB.prepare("SELECT id, team_id, model, substr(prompt,1,120) AS prompt, status, created_at FROM runs WHERE user_id = ? AND team_id = ? ORDER BY id DESC LIMIT 20")
        .bind(userId, teamId)
        .all()
    : await env.DB.prepare("SELECT id, team_id, model, substr(prompt,1,120) AS prompt, status, created_at FROM runs WHERE user_id = ? ORDER BY id DESC LIMIT 20")
        .bind(userId)
        .all();
  return json({ runs: rows.results || [] });
}

async function runDetail(req: Request, env: Env, runId: string): Promise<Response> {
  const userId = await bearerSub(req, env);
  if (!userId) return json({ error: "Unauthorized." }, 401);
  const run = await env.DB.prepare("SELECT id, team_id, model, prompt, status, created_at FROM runs WHERE id = ? AND user_id = ?")
    .bind(runId, userId)
    .first();
  if (!run) return json({ error: "Run not found." }, 404);
  const steps = await env.DB.prepare("SELECT kind, name, output, created_at FROM run_steps WHERE run_id = ? ORDER BY id ASC LIMIT 200")
    .bind(runId)
    .all();
  return json({ run, steps: steps.results || [] });
}

// ---------- router ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/api/runs") return await startRun(req, env);
      if (req.method === "GET" && url.pathname === "/api/runs") return await listRuns(req, env);
      const m = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9-]+)$/);
      if (req.method === "GET" && m) return await runDetail(req, env, m[1]);
      if (req.method === "GET" && url.pathname === "/api/health") return json({ ok: true });
      return json({ error: "Not found." }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Internal error." }, 500);
    }
  },
};
