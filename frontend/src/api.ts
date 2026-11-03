export interface User {
  id: string;
  email: string;
  name: string;
  credit_usd: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface ChatDetail {
  chat: ChatSummary;
  messages: { role: string; content: string; created_at: string }[];
}

export interface UsageLog {
  id: number;
  chat_id: string | null;
  chat_title: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  estimated: number;
  created_at: string;
}

export interface UsageSummary {
  credit_usd: number;
  spent_usd: number;
  logs: UsageLog[];
}

export interface ChatResult {
  chat_id: string;
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

export async function fetchChats(): Promise<ChatSummary[]> {
  const data = await request<{ chats: ChatSummary[] }>("/api/chats");
  return data.chats;
}

export async function fetchChatDetail(chatId: string): Promise<ChatDetail> {
  return request<ChatDetail>(`/api/chats/${encodeURIComponent(chatId)}`);
}

export async function fetchUsage(): Promise<UsageSummary> {
  return request<UsageSummary>("/api/usage");
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

/** POST /api/chat with stream:true. Resolves with the chat id (X-Chat-Id). */
export async function streamChat(
  chatId: string | null,
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
    body: JSON.stringify({ chat_id: chatId, message, model, stream: true }),
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
  chatId: string | null,
  message: string,
  model: string,
): Promise<ChatResult> {
  return request<ChatResult>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ chat_id: chatId, message, model, stream: false }),
  });
}

/** Called after an SSE stream ends: persists the reply, logs usage, deducts credit. */
export async function finishChat(
  chatId: string,
  content: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null,
): Promise<ChatResult> {
  return request<ChatResult>("/api/chat/finish", {
    method: "POST",
    body: JSON.stringify({ chat_id: chatId, content, usage }),
  });
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 6 : 4)}`;
}
