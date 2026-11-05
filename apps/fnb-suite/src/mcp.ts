import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as d from "./domain.ts";
import * as acc from "./accounts.ts";
import * as ads from "./ads.ts";
import * as cam from "./camera.ts";
import { checkForUpdates, type UpdateCheckConfig } from "./update.ts";
import { APP_VERSION } from "./version.ts";
import type { AiConfig } from "./ai.ts";
import { DomainError, FULFILLMENTS, ORDER_STATUSES, PAYMENT_METHODS, TABLE_STATUSES } from "./domain.ts";
import { can, type Role } from "./accounts.ts";

// The MCP server is the only interface. Each tool declares the minimum role it
// needs; tools above the caller's role are not registered, so they do not show
// up in tools/list at all.
//   public  : setup_status/setup_create_owner (one-time first-visit setup),
//             menu, tables, cart, checkout, store banners, login
//   cashier : orders, payments, table status, customers, camera check
//   manager : catalog admin, promotions, settings, ads, reports
//   owner   : team members

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

// Expected failures become MCP tool errors; anything else is a bug and propagates.
function safe<A>(fn: (args: A) => unknown | Promise<unknown>) {
  return async (args: A): Promise<Result> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      if (e instanceof DomainError) return { content: [{ type: "text", text: e.message }], isError: true };
      throw e;
    }
  };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const customerInput = z.object({
  name: z.string().min(1),
  phone: z.string().min(6),
  email: z.string().email().optional(),
  address: z.string().optional(),
});

export interface McpOptions {
  role: Role;
  userId: string | null;
  token: string | null; // bearer token used for this request (for logout)
  ai: AiConfig | null;
  update?: UpdateCheckConfig | null; // update-check source (UPDATE_CHECK_URL)
}

export function createMcpServer(db: Database, opts: McpOptions) {
  const server = new McpServer({ name: "fnb-suite", version: APP_VERSION });
  const role = opts.role;

  // Registers the tool only if the caller's role is at least `min`.
  // The handler receives args typed by zod at runtime; typed loosely here.
  const reg = (min: Exclude<Role, "public">, name: string, cfg: any, handler: (args: any) => unknown) => {
    if (can(role, min)) server.registerTool(name, cfg, safe(handler) as any);
  };
  const pub = (name: string, cfg: any, handler: (args: any) => unknown) => {
    server.registerTool(name, cfg, safe(handler) as any);
  };

  // ---------- First-visit setup (no login needed, one-time only) ----------

  pub("setup_status", {
    title: "Setup status",
    description: "Whether this deployment still needs first-visit setup (true when no owner account exists yet).",
    inputSchema: {},
  }, () => ({ needs_setup: !acc.hasOwner(db) }));

  pub("setup_create_owner", {
    title: "Set up shop owner",
    description:
      "First-visit setup: create the shop, the owner account, and the shop name. Works only once; afterwards it refuses. Returns a session token for the new owner.",
    inputSchema: {
      business: z.string().min(1).max(120).describe("Shop/business name"),
      name: z.string().min(1).max(120).describe("Owner display name"),
      email: z.string().describe("Owner login email"),
      password: z.string().min(8).describe("Owner password (min 8 characters)"),
    },
  }, async (args) => {
    if (acc.hasOwner(db)) throw new DomainError("This shop is already set up. Ask an owner to add you via team_member_add.");
    const business = args.business.trim();
    const name = args.name.trim();
    if (!business) throw new DomainError("Business name is required.");
    if (!name) throw new DomainError("Owner name is required.");
    acc.ensureTeam(db, business);
    const member = await acc.addMember(db, { email: args.email, name, password: args.password, role: "owner" });
    d.setSetting(db, "shop_name", business);
    const session = await acc.login(db, args.email, args.password);
    return { business, owner: member, token: session.token, expires_at: session.expires_at };
  });

  // ---------- Public ----------

  pub("auth_login", {
    title: "Log in",
    description: "Log in with email and password. Returns a session token to send as Authorization: Bearer <token>.",
    inputSchema: { email: z.string(), password: z.string() },
  }, ({ email, password }) => acc.login(db, email, password));

  pub("shop_info", {
    title: "Shop info",
    description: "Shop name, address, opening hours, and delivery fee.",
    inputSchema: {},
  }, () => d.publicShopInfo(db));

  pub("catalog_list", {
    title: "List menu",
    description: "Active products with price, add-ons, and units still available.",
    inputSchema: { category: z.string().optional() },
  }, ({ category }) => d.listCatalog(db, category));

  pub("promo_list", {
    title: "List active promotions",
    description: "Currently running promotions (names and rules, not codes).",
    inputSchema: {},
  }, () => d.listActivePromotions(db));

  pub("ad_banners", {
    title: "Live ad banners",
    description: "Campaigns that are live right now, for the store front.",
    inputSchema: {},
  }, () => ads.liveBanners(db));

  pub("table_availability", {
    title: "Check table availability",
    description: "Tables with status and capacity. Pass party_size to see only tables that fit.",
    inputSchema: { party_size: z.number().int().positive().optional() },
  }, ({ party_size }) => d.listTables(db, party_size));

  pub("booking_request", {
    title: "Request table booking",
    description: "Request a table for a future time. Pending until the shop confirms. Deposit set by the shop.",
    inputSchema: {
      table_id: z.string(),
      customer_name: z.string().min(1),
      phone: z.string().min(6),
      starts_at: z.string().describe("ISO 8601 with timezone"),
      party_size: z.number().int().positive(),
    },
  }, (args) => {
    if (Date.parse(args.starts_at) <= Date.now()) throw new DomainError("starts_at must be in the future.");
    return d.createBooking(db, { ...args, deposit_idr: d.getSettingNumber(db, "booking_deposit_idr", 0) });
  });

  pub("cart_create", {
    title: "Create cart",
    description: "Create an empty cart. Returns cart_id for the other cart tools.",
    inputSchema: {},
  }, () => d.createCart(db));

  pub("cart_add_item", {
    title: "Add item to cart",
    description: "Add a product, optionally with one add-on. Rejects if stock is insufficient.",
    inputSchema: {
      cart_id: z.string(),
      product_id: z.string(),
      qty: z.number().int().positive(),
      addon_id: z.string().optional(),
    },
  }, (args) => d.addToCart(db, args));

  pub("cart_remove_item", {
    title: "Remove item from cart",
    description: "Remove one line using its cart_item_id.",
    inputSchema: { cart_id: z.string(), cart_item_id: z.number().int() },
  }, ({ cart_id, cart_item_id }) => d.removeFromCart(db, cart_id, cart_item_id));

  pub("cart_apply_promo", {
    title: "Apply promo code",
    description: "Apply a promo code, or pass null to clear it. Rejects invalid codes with the reason.",
    inputSchema: { cart_id: z.string(), code: z.string().nullable() },
  }, ({ cart_id, code }) => d.applyPromo(db, cart_id, code));

  pub("cart_get", {
    title: "Get cart",
    description: "Cart lines, subtotal, discount, and total in IDR.",
    inputSchema: { cart_id: z.string() },
  }, ({ cart_id }) => d.priceCart(db, cart_id));

  pub("order_place", {
    title: "Place order (checkout)",
    description:
      "Turn a cart into an order. Stock is checked and reserved atomically. The order waits for payment. dine_in needs table_id; delivery needs customer name, phone, and address.",
    inputSchema: {
      cart_id: z.string(),
      fulfillment: z.enum(FULFILLMENTS),
      table_id: z.string().optional(),
      pickup_at: z.string().optional().describe("ISO 8601, for pickup"),
      address: z.string().optional(),
      note: z.string().max(300).optional(),
      customer: customerInput.optional(),
    },
  }, (args) => d.placeOrder(db, args));

  pub("order_status", {
    title: "Order status",
    description: "Status, totals, and items of an order by order id.",
    inputSchema: { order_id: z.string() },
  }, ({ order_id }) => {
    const o = d.getOrder(db, order_id);
    return {
      id: o.id,
      status: o.status,
      fulfillment: o.fulfillment,
      total_idr: o.total_idr,
      items: o.items.map((i: any) => ({ name: i.product_name, addon: i.addon_name, qty: i.qty })),
    };
  });

  // ---------- Session ----------

  reg("cashier", "auth_me", {
    title: "Current user",
    description: "The signed-in user and role.",
    inputSchema: {},
  }, () => {
    const u = opts.userId ? acc.currentUser(db, opts.userId) : null;
    return { role, user: u, via: opts.userId ? "session" : "admin_token" };
  });

  reg("cashier", "auth_logout", {
    title: "Log out",
    description: "End the current session. The admin token cannot be logged out.",
    inputSchema: {},
  }, () => {
    if (!opts.userId || !opts.token) throw new DomainError("No session to end.");
    return acc.logout(db, opts.token);
  });

  // ---------- Cashier: orders, payments, tables, customers, camera ----------

  reg("cashier", "order_get", {
    title: "Get order",
    description: "Full order with items and payments.",
    inputSchema: { order_id: z.string() },
  }, ({ order_id }) => d.getOrder(db, order_id));

  reg("cashier", "order_list", {
    title: "List orders",
    description: "Recent orders, optionally filtered by status or date (YYYY-MM-DD, shop time).",
    inputSchema: { status: z.enum(ORDER_STATUSES).optional(), date: isoDate.optional() },
  }, (args) => d.listOrders(db, args));

  reg("cashier", "order_pay", {
    title: "Record payment",
    description:
      "Mark a pending order as paid. For cash, pass amount_received_idr; change is calculated. For other methods, confirm the payment first.",
    inputSchema: {
      order_id: z.string(),
      method: z.enum(PAYMENT_METHODS),
      amount_received_idr: z.number().int().nonnegative().optional(),
    },
  }, (args) => d.payOrder(db, args));

  reg("cashier", "order_set_status", {
    title: "Set order status",
    description: "Move an order forward: paid -> preparing -> ready -> completed. Cancelling restores stock and promo usage.",
    inputSchema: { order_id: z.string(), status: z.enum(ORDER_STATUSES) },
  }, (args) => d.setOrderStatus(db, args));

  reg("cashier", "table_set_status", {
    title: "Set table status",
    description: "Set a table to available, occupied, reserved, or cleaning.",
    inputSchema: { table_id: z.string(), status: z.enum(TABLE_STATUSES) },
  }, ({ table_id, status }) => d.setTableStatus(db, table_id, status));

  reg("cashier", "booking_list", {
    title: "List bookings",
    description: "Bookings, optionally for one date (YYYY-MM-DD).",
    inputSchema: { date: isoDate.optional() },
  }, ({ date }) => d.listBookings(db, date));

  reg("cashier", "booking_create", {
    title: "Create booking",
    description: "Book a table for a start time. Rejects over-capacity or double bookings.",
    inputSchema: {
      table_id: z.string(),
      customer_name: z.string().min(1),
      phone: z.string().min(6),
      starts_at: z.string().describe("ISO 8601, e.g. 2026-11-04T19:00:00+07:00"),
      party_size: z.number().int().positive(),
      deposit_idr: z.number().int().nonnegative().optional(),
    },
  }, (args) => d.createBooking(db, args));

  reg("cashier", "customer_upsert", {
    title: "Create or update customer",
    description: "Create or update a customer. Matched by phone number.",
    inputSchema: customerInput,
  }, (args) => d.upsertCustomer(db, args));

  reg("cashier", "customer_get", {
    title: "Get customer",
    description: "Look up a customer by id or phone.",
    inputSchema: { id: z.string().optional(), phone: z.string().optional() },
  }, (args) => d.getCustomer(db, args));

  reg("cashier", "customer_list", {
    title: "List customers",
    description: "Customers sorted by total spend. Optional search by name or phone.",
    inputSchema: { query: z.string().optional() },
  }, ({ query }) => d.listCustomers(db, query));

  reg("cashier", "table_camera_check", {
    title: "AI camera: check tables",
    description:
      "Send a photo of the dining area (base64 JPEG/PNG or data URL). The vision model reports per table whether it looks empty. Stored as an observation; status is not changed automatically.",
    inputSchema: {
      image: z.string().describe("base64 or data URL of the photo"),
      mime: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
      table_ids: z.array(z.string()).optional().describe("Limit to these tables; default all"),
    },
  }, (args) => cam.checkTables(db, opts.ai, args));

  // ---------- Manager: catalog, promotions, settings, ads, reports ----------

  reg("manager", "product_upsert", {
    title: "Create or update product",
    description: "Create a product, or update it when id is given. stock_qty null = unlimited. Price in IDR.",
    inputSchema: {
      id: z.string().optional(),
      name: z.string().min(1),
      description: z.string().optional(),
      category: z.string().optional(),
      price_idr: z.number().int().nonnegative(),
      stock_qty: z.number().int().nonnegative().nullable().optional(),
      active: z.boolean().optional(),
    },
  }, (args) => d.upsertProduct(db, args));

  reg("manager", "addon_upsert", {
    title: "Create or update add-on",
    description: "Create or update an add-on for a product. stock_qty null = unlimited.",
    inputSchema: {
      id: z.string().optional(),
      product_id: z.string(),
      name: z.string().min(1),
      price_idr: z.number().int().nonnegative(),
      stock_qty: z.number().int().nonnegative().nullable().optional(),
    },
  }, (args) => d.upsertAddon(db, args));

  reg("manager", "stock_adjust", {
    title: "Adjust stock",
    description: "Restock (positive delta) or consume/waste (negative delta).",
    inputSchema: { product_id: z.string(), delta: z.number().int() },
  }, ({ product_id, delta }) => d.adjustStock(db, product_id, delta));

  reg("manager", "table_upsert", {
    title: "Create or update table",
    description: "Create a table or update its name/capacity.",
    inputSchema: { id: z.string().optional(), name: z.string().min(1), capacity: z.number().int().positive() },
  }, (args) => d.upsertTable(db, args));

  reg("manager", "promotion_upsert", {
    title: "Create or update promotion",
    description: "Percent (1-100) or fixed IDR discount. Optional code, minimum subtotal, validity window, and usage limit.",
    inputSchema: {
      id: z.string().optional(),
      code: z.string().nullable().optional(),
      name: z.string().min(1),
      kind: z.enum(["percent", "fixed"]),
      value: z.number().int().positive(),
      min_subtotal_idr: z.number().int().nonnegative().optional(),
      starts_at: z.string().nullable().optional(),
      ends_at: z.string().nullable().optional(),
      max_uses: z.number().int().positive().nullable().optional(),
      active: z.boolean().optional(),
    },
  }, (args) => d.upsertPromotion(db, args));

  reg("manager", "promotion_list", {
    title: "List promotions",
    description: "All promotions including codes and usage counts.",
    inputSchema: {},
  }, () => d.listPromotions(db));

  reg("manager", "setting_set", {
    title: "Set shop setting",
    description: "Set a shop setting, e.g. shop_name, shop_address, shop_hours, delivery_fee_idr.",
    inputSchema: { key: z.string(), value: z.string() },
  }, ({ key, value }) => d.setSetting(db, key, value));

  reg("manager", "sales_summary", {
    title: "Daily sales summary",
    description: "Revenue, order count, payment mix, and top products for one shop-local date (YYYY-MM-DD).",
    inputSchema: { date: isoDate },
  }, ({ date }) => d.salesSummary(db, date));

  reg("manager", "update_status", {
    title: "Check for updates",
    description:
      "Compare the running app version against UPDATE_CHECK_URL. Returns whether an update is available. Disabled when no check URL is configured.",
    inputSchema: { refresh: z.boolean().optional().describe("Ignore the cache and check again now") },
  }, (args) => checkForUpdates(opts.update ?? {}, { refresh: args.refresh }));

  reg("manager", "ad_generate", {
    title: "Generate ad copy",
    description:
      "Draft ad copy for a product or promo code. Uses the AI provider if configured, otherwise a template. Always starts as a draft for review.",
    inputSchema: {
      product_id: z.string().optional(),
      promo_code: z.string().optional(),
      goal: z.string().max(200).optional(),
      tone: z.string().max(60).optional(),
    },
  }, (args) => ads.generateCampaign(db, opts.ai, args));

  reg("manager", "ad_update", {
    title: "Edit ad copy",
    description: "Change title, body, or call-to-action of a campaign that is not live.",
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      cta: z.string().optional(),
    },
  }, (args) => ads.updateCampaignText(db, args));

  reg("manager", "ad_schedule", {
    title: "Schedule ad",
    description: "Set when a campaign goes live on the store, and optionally when it ends (ISO 8601).",
    inputSchema: {
      id: z.string(),
      starts_at: z.string(),
      ends_at: z.string().nullable().optional(),
    },
  }, (args) => ads.scheduleCampaign(db, args));

  reg("manager", "ad_set_status", {
    title: "Unschedule or end ad",
    description: "Move a campaign back to draft, or end it now.",
    inputSchema: { id: z.string(), status: z.enum(["draft", "ended"]) },
  }, (args) => ads.setCampaignStatus(db, args));

  reg("manager", "ad_list", {
    title: "List ad campaigns",
    description: "Campaigns, optionally filtered by status.",
    inputSchema: { status: z.enum(ads.CAMPAIGN_STATUSES).optional() },
  }, ({ status }) => ads.listCampaigns(db, status));

  // ---------- Owner: team ----------

  reg("owner", "team_member_list", {
    title: "List team members",
    description: "Accounts in the team with roles.",
    inputSchema: {},
  }, () => acc.listMembers(db));

  reg("owner", "team_member_add", {
    title: "Add team member",
    description: "Create an account in the team with a role (manager or cashier; owner is not added this way).",
    inputSchema: {
      email: z.string(),
      name: z.string().min(1),
      password: z.string().min(8),
      role: z.enum(["manager", "cashier"]),
    },
  }, (args) => acc.addMember(db, args));

  reg("owner", "team_member_deactivate", {
    title: "Deactivate team member",
    description: "Disable an account and end its sessions.",
    inputSchema: { user_id: z.string() },
  }, ({ user_id }) => acc.deactivateMember(db, user_id));

  return server;
}
