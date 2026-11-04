import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The store reads and writes only through the public MCP endpoint.
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:8080/mcp";

let clientP: Promise<Client> | null = null;

function client(): Promise<Client> {
  if (!clientP) {
    clientP = (async () => {
      const c = new Client({ name: "fnb-store", version: "0.2.0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
      return c;
    })().catch((e) => {
      clientP = null; // retry on the next request
      throw e;
    });
  }
  return clientP;
}

export class StoreError extends Error {}

export async function mcp<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const c = await client();
  const r: any = await c.callTool({ name, arguments: args });
  const text: string = r.content?.[0]?.text ?? "";
  if (r.isError) throw new StoreError(text);
  return JSON.parse(text) as T;
}

export const rupiah = (n: number | null | undefined) => "Rp " + Number(n ?? 0).toLocaleString("id-ID");

// Local wall-clock value from <input type="datetime-local"> -> ISO with the shop offset.
export function localToIso(value: string, offsetHours: number): string {
  return new Date(Date.parse(value + ":00Z") - offsetHours * 3600_000).toISOString();
}

// Cart id lives in an httpOnly cookie. Recreated if the cart no longer exists.
export async function ensureCart(ctx: { cookies: any }): Promise<string> {
  const existing = ctx.cookies.get("cart")?.value;
  if (existing) {
    try {
      await mcp("cart_get", { cart_id: existing });
      return existing;
    } catch {
      // fall through and create a new one
    }
  }
  const { cart_id } = await mcp<{ cart_id: string }>("cart_create");
  ctx.cookies.set("cart", cart_id, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 7 });
  return cart_id;
}
