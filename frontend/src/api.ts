export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
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

/** Stream assistant tokens for a chat completion. Calls onToken per delta, onDone at [DONE]. */
export async function streamChat(
  messages: ChatMessage[],
  model: string,
  onToken: (delta: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const token = getToken();
  const res = await fetch("/api/chat", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages, model, stream: true }),
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
    // Parse SSE frames: events separated by blank line.
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        const text = line.startsWith(":") ? "" : line.replace(/^data:\s?/, "");
        if (!line.startsWith("data:") || text === "") continue;
        if (text === "[DONE]") return;
        try {
          const evt = JSON.parse(text) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = evt.choices?.[0]?.delta?.content ?? "";
          if (delta) onToken(delta);
        } catch {
          // Ignore non-JSON frames (e.g. keep-alive comments).
        }
      }
    }
  }
}
