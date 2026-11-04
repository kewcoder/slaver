import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The admin UI talks to the app only through MCP. Auth is an account session token.
export type Role = "cashier" | "manager" | "owner";
export interface Session {
  token: string;
  role: Role;
  user: { id: string; email: string; name: string };
}

let client: Client | null = null;
const TOKEN_KEY = "fnb-admin-session";

function connectWith(token: string | null): Promise<Client> {
  return (async () => {
    const c = new Client({ name: "fnb-admin", version: "0.3.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", location.origin), {
        requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
      }),
    );
    return c;
  })();
}

export async function login(email: string, password: string): Promise<Session> {
  const anon = await connectWith(null);
  const r: any = await anon.callTool({ name: "auth_login", arguments: { email, password } });
  await anon.close();
  const text: string = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(text);
  const data = JSON.parse(text);
  localStorage.setItem(TOKEN_KEY, data.token);
  return restore(data.token) as Promise<Session>;
}

// Re-open a saved session. Returns null if it is no longer valid.
export async function restore(token?: string): Promise<Session | null> {
  const t = token ?? localStorage.getItem(TOKEN_KEY);
  if (!t) return null;
  try {
    const c = await connectWith(t);
    const r: any = await c.callTool({ name: "auth_me", arguments: {} });
    if (r.isError) throw new Error(r.content[0].text);
    const me = JSON.parse(r.content[0].text);
    if (!me.user || me.role === "public") throw new Error("no session");
    client = c;
    return { token: t, role: me.role, user: me.user };
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    client = null;
    return null;
  }
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  client?.close().catch(() => {});
  client = null;
}

export async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!client) throw new Error("Belum login.");
  const r: any = await client.callTool({ name, arguments: args });
  const text: string = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

export const rupiah = (n: number | null | undefined) => "Rp " + Number(n ?? 0).toLocaleString("id-ID");

// Date (YYYY-MM-DD) in the shop's business timezone.
export function shopToday(offsetHours = 7): string {
  return new Date(Date.now() + offsetHours * 3600_000).toISOString().slice(0, 10);
}

// Wall-clock value from <input type="datetime-local"> in the shop timezone -> ISO string.
export const toIso = (local: string, offsetHours = 7) =>
  new Date(Date.parse(local + ":00Z") - offsetHours * 3600_000).toISOString();

// HH:MM in the shop timezone. created_at values are UTC strings from SQLite;
// ISO strings with an explicit offset are used as-is.
export function clock(ts: string, offsetHours = 7): string {
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
  const d = new Date(Date.parse(iso) + offsetHours * 3600_000);
  return d.toISOString().slice(11, 16);
}
