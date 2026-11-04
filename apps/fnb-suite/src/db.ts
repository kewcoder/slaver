import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Schema for one client deployment (one SQLite file per client).
// All money is integer IDR. stock_qty NULL = unlimited.
const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  price_idr   INTEGER NOT NULL CHECK (price_idr >= 0),
  stock_qty   INTEGER CHECK (stock_qty IS NULL OR stock_qty >= 0),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS addons (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_idr   INTEGER NOT NULL CHECK (price_idr >= 0),
  stock_qty   INTEGER CHECK (stock_qty IS NULL OR stock_qty >= 0),
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tables (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  capacity  INTEGER NOT NULL CHECK (capacity > 0),
  status    TEXT NOT NULL DEFAULT 'available'
            CHECK (status IN ('available','occupied','reserved','cleaning')),
  -- Last observation from the AI camera. Advisory only: it never overrides status.
  observed_status  TEXT CHECK (observed_status IS NULL OR observed_status IN ('empty','occupied','unknown')),
  observed_at      TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,
  table_id       TEXT NOT NULL REFERENCES tables(id),
  customer_name  TEXT NOT NULL,
  phone          TEXT NOT NULL,
  starts_at      TEXT NOT NULL,
  party_size     INTEGER NOT NULL CHECK (party_size > 0),
  deposit_idr    INTEGER NOT NULL DEFAULT 0 CHECK (deposit_idr >= 0),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','confirmed','cancelled','no_show')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL DEFAULT '',
  order_count      INTEGER NOT NULL DEFAULT 0,
  total_spent_idr  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promotions (
  id                 TEXT PRIMARY KEY,
  code               TEXT UNIQUE,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value              INTEGER NOT NULL CHECK (value > 0),
  min_subtotal_idr   INTEGER NOT NULL DEFAULT 0,
  starts_at          TEXT,
  ends_at            TEXT,
  max_uses           INTEGER,
  used_count         INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1,
  CHECK (kind <> 'percent' OR value <= 100)
);

CREATE TABLE IF NOT EXISTS carts (
  id           TEXT PRIMARY KEY,
  promo_code   TEXT,
  customer_id  TEXT REFERENCES customers(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id     TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id),
  addon_id    TEXT REFERENCES addons(id),
  qty         INTEGER NOT NULL CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS orders (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  customer_id       TEXT REFERENCES customers(id),
  fulfillment       TEXT NOT NULL CHECK (fulfillment IN ('dine_in','pickup','delivery')),
  table_id          TEXT REFERENCES tables(id),
  pickup_at         TEXT,
  address           TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  subtotal_idr      INTEGER NOT NULL,
  discount_idr      INTEGER NOT NULL DEFAULT 0,
  delivery_fee_idr  INTEGER NOT NULL DEFAULT 0,
  total_idr         INTEGER NOT NULL,
  promo_code        TEXT,
  status            TEXT NOT NULL DEFAULT 'pending_payment'
                    CHECK (status IN ('pending_payment','paid','preparing','ready','completed','cancelled')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Line snapshots: later price/name changes do not alter past orders.
CREATE TABLE IF NOT EXISTS order_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        TEXT NOT NULL REFERENCES products(id),
  addon_id          TEXT REFERENCES addons(id),
  product_name      TEXT NOT NULL,
  addon_name        TEXT,
  unit_price_idr    INTEGER NOT NULL,
  addon_price_idr   INTEGER NOT NULL DEFAULT 0,
  qty               INTEGER NOT NULL CHECK (qty > 0),
  line_total_idr    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  method        TEXT NOT NULL CHECK (method IN ('cash','qris','transfer','card')),
  amount_idr    INTEGER NOT NULL,
  change_idr    INTEGER NOT NULL DEFAULT 0,
  paid_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Accounts and team. One deployment = one business (team). Roles: owner > manager > cashier.
CREATE TABLE IF NOT EXISTS team (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id  TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  PRIMARY KEY (team_id, user_id)
);

-- Session tokens are stored hashed (sha256). Raw token is returned once at login.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);

-- Ad campaigns: AI or template drafts, scheduled, then shown on the store.
CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  cta          TEXT NOT NULL DEFAULT '',
  product_id   TEXT REFERENCES products(id),
  promo_code   TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','live','ended')),
  starts_at    TEXT,
  ends_at      TEXT,
  generated_by TEXT NOT NULL DEFAULT 'template',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
