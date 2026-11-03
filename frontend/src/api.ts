export interface User {
  id: string;
  email: string;
  name: string;
  credit_usd: number;
}

export interface SlaveBot {
  id: string;
  name: string;
  title: string;
  model: string;
  memory: string;
  avatar_key: string;
  created_at: string;
  updated_at: string;
}

export interface BotDetail {
  slavebot: SlaveBot;
  messages: { role: string; content: string; created_at: string }[];
}

export interface SummaryRow {
  id: number;
  period: string;
  period_key: string;
  content: string;
  created_at: string;
}

export interface Summaries {
  daily: SummaryRow[];
  weekly: SummaryRow[];
  monthly: SummaryRow[];
}

export interface UsageLog {
  id: number;
  slavebot_id: string | null;
  slavebot_name: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  estimated: number;
  audio_seconds: number;
  created_at: string;
}

export interface UsageSummary {
  credit_usd: number;
  spent_usd: number;
  logs: UsageLog[];
}

export interface ChatResult {
  slavebot_id: string;
  reply?: string;
  usage: { prompt_tokens: number; completion_tokens: number; estimated?: boolean };
  cost_usd: number;
  credit_usd: number;
}

const TOKEN_KEY = "slaver_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

export async function fetchModels(): Promise<
  { id: string; label: string; default?: boolean }[]
> {
  const data = await request<{ models: { id: string; label: string; default?: boolean }[] }>(
    "/api/models",
  );
  return data.models;
}

export async function register(
  email: string,
  password: string,
  name: string,
): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
  setToken(data.token);
  return data;
}

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setToken(data.token);
  return data;
}

export async function fetchMe(): Promise<User> {
  const data = await request<{ user: User }>("/api/me");
  return data.user;
}

export async function fetchBots(): Promise<SlaveBot[]> {
  const data = await request<{ slavebots: SlaveBot[] }>("/api/slavebots");
  return data.slavebots;
}

export async function createBot(model: string): Promise<SlaveBot> {
  const data = await request<{ slavebot: SlaveBot }>("/api/slavebots", {
    method: "POST",
    body: JSON.stringify({ model }),
  });
  return data.slavebot;
}

export async function fetchBotDetail(botId: string): Promise<BotDetail> {
  return request<BotDetail>(`/api/slavebots/${encodeURIComponent(botId)}`);
}

export async function updateBot(
  botId: string,
  patch: { name?: string; memory?: string; model?: string },
): Promise<SlaveBot> {
  const data = await request<{ slavebot: SlaveBot }>(
    `/api/slavebots/${encodeURIComponent(botId)}`,
    { method: "PUT", body: JSON.stringify(patch) },
  );
  return data.slavebot;
}

export async function fetchUsage(): Promise<UsageSummary> {
  return request<UsageSummary>("/api/usage");
}

export async function fetchSummaries(botId: string): Promise<Summaries> {
  return request<Summaries>(`/api/summaries?slavebot_id=${encodeURIComponent(botId)}`);
}

export async function runSummary(botId: string): Promise<{ summary: SummaryRow | null; note?: string }> {
  return request("/api/summaries/run", {
    method: "POST",
    body: JSON.stringify({ slavebot_id: botId }),
  });
}

export async function uploadAvatar(botId: string, file: File): Promise<void> {
  const token = getToken();
  const form = new FormData();
  form.append("avatar", file);
  const res = await fetch(`/api/slavebots/${encodeURIComponent(botId)}/avatar`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Avatar upload failed (${res.status}).`);
  }
}

export function avatarUrl(botId: string): string {
  return `/api/slavebots/${encodeURIComponent(botId)}/avatar`;
}

export interface StreamHandlers {
  onToken: (delta: string) => void;
  onUsage?: (usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }) => void;
  signal: AbortSignal;
}

/** POST /api/chat with stream:true. Resolves with the bot id (X-Chat-Id). */
export async function streamChat(
  botId: string,
  message: string,
  model: string,
  handlers: StreamHandlers,
): Promise<string> {
  const token = getToken();
  const res = await fetch("/api/chat", {
    method: "POST",
    signal: handlers.signal,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ slavebot_id: botId, message, model, stream: true }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Chat failed (${res.status}).`);
  }
  if (!res.body) throw new Error("This browser does not support streaming responses.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const text = line.replace(/^data:\s?/, "");
        if (text === "" || text === "[DONE]") continue;
        try {
          const evt = JSON.parse(text) as {
            choices?: { delta?: { content?: string } }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };
          const delta = evt.choices?.[0]?.delta?.content ?? "";
          if (delta) handlers.onToken(delta);
          if (evt.usage) handlers.onUsage?.(evt.usage);
        } catch {
          // Ignore non-JSON frames (e.g. keep-alive comments).
        }
      }
    }
  }
  return res.headers.get("X-Chat-Id") ?? "";
}

/** Non-streaming chat: single call, reply + cost inline. */
export async function plainChat(
  botId: string,
  message: string,
  model: string,
): Promise<ChatResult> {
  return request<ChatResult>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ slavebot_id: botId, message, model, stream: false }),
  });
}

/** Called after an SSE stream ends: persists the reply, logs usage, deducts credit. */
export async function finishChat(
  botId: string,
  content: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null,
): Promise<ChatResult> {
  return request<ChatResult>("/api/chat/finish", {
    method: "POST",
    body: JSON.stringify({ slavebot_id: botId, content, usage }),
  });
}

export interface TranscribeResult {
  transcript: string;
  audio_seconds: number;
  estimated?: boolean;
  cost_usd: number;
  credit_usd: number;
}

/** POST /api/voice/transcribe — multipart upload of a WAV clip. */
export async function transcribeVoice(audio: Blob): Promise<TranscribeResult> {
  const token = getToken();
  const form = new FormData();
  form.append("audio", audio, "audio.wav");
  const res = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as TranscribeResult & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Transcription failed (${res.status}).`);
  }
  return data;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 6 : 4)}`;
}
