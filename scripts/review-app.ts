// AI review for an app submitted under apps/<name>/.
//
// Submitting an app = opening a pull request that adds or changes apps/<name>/.
// This script runs in CI (.github/workflows/app-review.yml) and posts feedback as
// a PR comment. It also runs locally before you submit:
//
//   bun scripts/review-app.ts apps/<name>            # print report
//   bun scripts/review-app.ts apps/<name> --no-ai    # static checks only
//   bun scripts/review-app.ts --changed --base origin/main --pr 12   # CI mode
//
// Static checks always run. The AI review runs when MODEL_API_KEY is set, using
// Meta Model API (Muse Spark). Files that look like they hold secrets are never sent.
// Exit code 1 only when a static "must fix" check fails (e.g. a leaked key).

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

export type Level = "must" | "suggest" | "ok";
export interface Check {
  level: Level;
  name: string;
  detail: string;
}
export interface AiReview {
  score: number | null;
  summary: string;
  strengths: string[];
  must_fix: string[];
  suggestions: string[];
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".astro", "data", "coverage"]);
const IGNORED_FILES = new Set(["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".toml", ".sh", ".sql", ".env", ".example", ""]);
const MAX_TEXT_BYTES = 1_000_000;
const MAX_FILE_BYTES = 5_000_000;

// Patterns that look like credentials. Matching files are reported and withheld from the AI.
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "hard-coded API key assignment", re: /\b(?:MODEL_API_KEY|API_KEY|SECRET|TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_\-]{24,}["']?/ },
];

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(join(dir, e.name));
      } else if (!IGNORED_FILES.has(e.name)) {
        out.push(relative(root, join(dir, e.name)));
      }
    }
  }
  await walk(root);
  return out.sort();
}

function isText(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return TEXT_EXT.has(extname(base)) || base.startsWith(".");
}

export function staticChecks(root: string, files: string[], contents: Map<string, string>): Check[] {
  const checks: Check[] = [];
  const has = (p: string) => files.includes(p);
  const readme = contents.get("README.md") ?? "";

  // Secrets: must fix.
  const leaks: string[] = [];
  for (const f of files) {
    const text = contents.get(f);
    if (text === undefined) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(text)) leaks.push(`${f} (${p.name})`);
  }
  if (leaks.length) checks.push({ level: "must", name: "Secrets", detail: `Kemungkinan kredensial di: ${leaks.join(", ")}. Pindahkan ke environment variable dan rotasi key.` });
  else checks.push({ level: "ok", name: "Secrets", detail: "Tidak ada kredensial yang terlihat di file." });

  // Committed local data or env files: must fix.
  const committedEnv = files.filter((f) => /(^|\/)\.env$/.test(f));
  const committedDb = files.filter((f) => /\.db(-wal|-shm)?$/.test(f));
  if (committedEnv.length || committedDb.length) {
    checks.push({ level: "must", name: "Data lokal", detail: `Jangan commit .env atau database: ${[...committedEnv, ...committedDb].join(", ")}.` });
  } else checks.push({ level: "ok", name: "Data lokal", detail: "Tidak ada .env atau database yang ikut." });

  // Big files: must fix.
  const big: string[] = [];
  for (const f of files) {
    const s = contents.get(`__size__${f}`);
    if (s && Number(s) > MAX_FILE_BYTES) big.push(f);
  }
  if (big.length) checks.push({ level: "must", name: "Ukuran file", detail: `File lebih dari 5 MB: ${big.join(", ")}.` });

  // README with install steps.
  if (!has("README.md")) checks.push({ level: "must", name: "README", detail: "Tambahkan README.md dengan cara install dan menjalankan." });
  else if (readme.length < 400 || !/install|instal|jalan|run|start/i.test(readme)) {
    checks.push({ level: "suggest", name: "README", detail: "README perlu langkah install dan menjalankan yang jelas (perintah yang bisa di-copy)." });
  } else checks.push({ level: "ok", name: "README", detail: "README dengan langkah install dan menjalankan." });

  // Ignore rules.
  const gi = contents.get(".gitignore") ?? "";
  if (!has(".gitignore") || !/node_modules/.test(gi)) {
    checks.push({ level: "suggest", name: ".gitignore", detail: "Tambahkan .gitignore yang mengabaikan node_modules, data, dan .env." });
  } else checks.push({ level: "ok", name: ".gitignore", detail: "Ada .gitignore dengan node_modules." });

  // Tests.
  const hasTests = files.some((f) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.test\.[jt]sx?$/.test(f));
  checks.push(hasTests
    ? { level: "ok", name: "Tes", detail: "Ada tes otomatis." }
    : { level: "suggest", name: "Tes", detail: "Belum ada tes otomatis. Tambahkan minimal satu tes untuk alur utama." });

  // Deploy story.
  const hasDeploy = has("Dockerfile") || has("docker-compose.yml") || has("compose.yaml");
  checks.push(hasDeploy
    ? { level: "ok", name: "Deploy", detail: "Ada Dockerfile atau docker-compose." }
    : { level: "suggest", name: "Deploy", detail: "Tambahkan Dockerfile supaya mudah dijalankan di server sendiri." });

  // Meta models (informational; hackathon track rule).
  const usesMeta = /muse-|api\.meta\.ai|Meta Model API|MODEL_API_KEY/i.test([...contents.values()].join("\n"));
  checks.push(usesMeta
    ? { level: "ok", name: "Model Meta", detail: "Menggunakan Meta Model API / model Muse." }
    : { level: "suggest", name: "Model Meta", detail: "Tidak terlihat pemakaian Meta Model API (wajib untuk track hackathon)." });

  return checks;
}

export async function readContents(root: string, files: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const f of files) {
    const abs = join(root, f);
    const st = await stat(abs);
    m.set(`__size__${f}`, String(st.size));
    if (st.size > MAX_TEXT_BYTES || !isText(f)) continue;
    m.set(f, await readFile(abs, "utf8"));
  }
  return m;
}

// Files safe to send to the model: text, small, and free of secret patterns.
export function safeForAi(files: string[], contents: Map<string, string>): string[] {
  return files.filter((f) => {
    const t = contents.get(f);
    if (t === undefined) return false;
    return !SECRET_PATTERNS.some((p) => p.re.test(t));
  });
}

export function buildAiPrompt(name: string, files: string[], contents: Map<string, string>) {
  const tree = files.slice(0, 200).join("\n");
  const pick = (re: RegExp) => files.filter((f) => re.test(f) && safeForAi([f], contents).length).slice(0, 6);
  const sources = [...new Set([...pick(/^README\.md$/), ...pick(/^package\.json$/), ...pick(/(^|\/)src\/(server|index|main|app)\.[jt]sx?$/), ...pick(/^src\//)])].slice(0, 8);
  const body = sources
    .map((f) => `--- ${f} ---\n${(contents.get(f) ?? "").slice(0, 4000)}`)
    .join("\n\n");
  return [
    {
      role: "system" as const,
      content:
        "Kamu reviewer aplikasi untuk marketplace open source. Nilai aplikasi dan beri feedback yang spesifik dan bisa langsung dikerjakan, dalam Bahasa Indonesia. " +
        "Fokus: kejelasan README dan kemudahan install, kualitas kode, keamanan (secret, input, auth), kemampuan customize, dan tes. " +
        'Jawab JSON: {"score": 0-10, "summary": "1-2 kalimat", "strengths": [], "must_fix": [], "suggestions": []}. ' +
        "Maksimal 4 item per daftar. Jangan mengarang file yang tidak ada di daftar.",
    },
    {
      role: "user" as const,
      content: `Aplikasi: ${name}\n\nDaftar file:\n${tree}\n\nIsi file terpilih:\n${body}`,
    },
  ];
}

export async function aiReview(name: string, files: string[], contents: Map<string, string>, opts: { apiKey: string; baseUrl?: string; model?: string }): Promise<AiReview> {
  const res = await fetch(`${(opts.baseUrl ?? "https://api.meta.ai/v1").replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: opts.model ?? "muse-spark-1.3",
      messages: buildAiPrompt(name, safeForAi(files, contents), contents),
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Meta Model API returned ${res.status}`);
  const body: any = await res.json();
  const text: string = body?.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(text);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 4) : []);
  return {
    score: typeof parsed.score === "number" ? Math.max(0, Math.min(10, parsed.score)) : null,
    summary: String(parsed.summary ?? ""),
    strengths: list(parsed.strengths),
    must_fix: list(parsed.must_fix),
    suggestions: list(parsed.suggestions),
  };
}

const ICON: Record<Level, string> = { must: "❌", suggest: "⚠️", ok: "✅" };

export function renderReport(name: string, checks: Check[], ai: AiReview | null, aiError: string | null): string {
  const lines: string[] = [];
  lines.push(`## Review: \`${name}\``, "");
  if (ai) {
    lines.push(`**Skor AI: ${ai.score ?? "-"}/10.** ${ai.summary}`, "");
    if (ai.strengths.length) lines.push("**Kekuatan**", ...ai.strengths.map((s) => `- ${s}`), "");
    if (ai.must_fix.length) lines.push("**Wajib diperbaiki**", ...ai.must_fix.map((s) => `- ${s}`), "");
    if (ai.suggestions.length) lines.push("**Saran**", ...ai.suggestions.map((s) => `- ${s}`), "");
  } else if (aiError) {
    lines.push(`_Review AI tidak berjalan: ${aiError}_`, "");
  } else {
    lines.push("_Review AI tidak dijalankan (MODEL_API_KEY belum diset)._", "");
  }
  lines.push("**Pemeriksaan otomatis**", "");
  for (const c of checks) lines.push(`- ${ICON[c.level]} **${c.name}**: ${c.detail}`);
  lines.push("", "_Saran otomatis. Maintainer tetap memutuskan._");
  return lines.join("\n");
}

export async function reviewApp(dir: string, opts: { ai: boolean; apiKey?: string; baseUrl?: string; model?: string }) {
  const files = await listFiles(dir);
  const contents = await readContents(dir, files);
  const checks = staticChecks(dir, files, contents);
  let ai: AiReview | null = null;
  let aiError: string | null = null;
  if (opts.ai && opts.apiKey) {
    try {
      ai = await aiReview(dir, files, contents, { apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model });
    } catch (e) {
      aiError = e instanceof Error ? e.message : String(e);
    }
  }
  const name = dir.split("/").pop() ?? dir;
  return { name, checks, ai, aiError, markdown: renderReport(name, checks, ai, aiError), failed: checks.some((c) => c.level === "must") };
}

// ---------- CLI ----------

async function changedApps(base: string): Promise<string[]> {
  const p = Bun.spawn(["git", "diff", "--name-only", `${base}...HEAD`], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const dirs = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(apps\/[^/]+)\//);
    if (m) dirs.add(m[1]);
  }
  // Deleted apps have no folder left to review.
  const existing: string[] = [];
  for (const d of [...dirs].sort()) if (await Bun.file(join(d, "package.json")).exists() || (await readdir(d).catch(() => null))) existing.push(d);
  return existing;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (k: string) => args.includes(k);
  const val = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const apiKey = process.env.MODEL_API_KEY || "";
  const ai = !flag("--no-ai");
  const valued = new Set(["--base", "--pr", "--out"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  const dirs = flag("--changed") ? await changedApps(val("--base") ?? "origin/main") : positional;
  if (dirs.length === 0) {
    console.log("No app folders to review.");
    process.exit(0);
  }
  let failed = false;
  const parts: string[] = [];
  for (const d of dirs) {
    const r = await reviewApp(d, { ai, apiKey, baseUrl: process.env.AI_BASE_URL, model: process.env.AI_TEXT_MODEL });
    parts.push(r.markdown);
    failed ||= r.failed;
  }
  const md = parts.join("\n\n---\n\n");
  console.log(md);
  const out = val("--out");
  if (out) await Bun.write(out, md);
  const pr = val("--pr");
  if (pr && process.env.GH_TOKEN) {
    const p = Bun.spawn(["gh", "pr", "comment", pr, "--body-file", "-"], { stdin: new Blob([md]), stdout: "inherit", stderr: "inherit" });
    await p.exited;
  }
  process.exit(failed ? 1 : 0);
}
