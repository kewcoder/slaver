import type { Database } from "bun:sqlite";
import { DomainError } from "./domain.ts";

// Accounts, team membership, and sessions. One deployment = one team (business).
// Roles: owner > manager > cashier. "public" means no valid credential.

export type Role = "public" | "cashier" | "manager" | "owner";
const RANK: Record<Role, number> = { public: 0, cashier: 1, manager: 2, owner: 3 };

export function can(role: Role, need: Exclude<Role, "public">): boolean {
  return RANK[role] >= RANK[need];
}

export const TEAM_ID = "team_main";
const SESSION_DAYS = 30;

const one = (db: Database, sql: string, p: Record<string, unknown> = {}) =>
  (db.query(sql).get(p as any) as any) ?? null;

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new DomainError("Invalid email.");
  return e;
}

export function ensureTeam(db: Database, name: string) {
  const t = one(db, "SELECT id, name FROM team WHERE id = $id", { $id: TEAM_ID });
  if (t) return t;
  db.query("INSERT INTO team (id, name) VALUES ($id, $n)").run({ $id: TEAM_ID, $n: name });
  return { id: TEAM_ID, name };
}

export function getTeam(db: Database) {
  return one(db, "SELECT id, name FROM team WHERE id = $id", { $id: TEAM_ID });
}

export async function addMember(
  db: Database,
  input: { email: string; name: string; password: string; role: Exclude<Role, "public"> },
) {
  if (input.password.length < 8) throw new DomainError("Password must be at least 8 characters.");
  if (!getTeam(db)) throw new DomainError("Team not set up yet.");
  const email = normalizeEmail(input.email);
  if (one(db, "SELECT id FROM users WHERE email = $e", { $e: email })) {
    throw new DomainError("Email already registered.");
  }
  const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
  const hash = await Bun.password.hash(input.password);
  return db.transaction(() => {
    db.query("INSERT INTO users (id, email, name, password_hash) VALUES ($id, $e, $n, $h)").run({
      $id: id,
      $e: email,
      $n: input.name,
      $h: hash,
    });
    db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($t, $u, $r)").run({
      $t: TEAM_ID,
      $u: id,
      $r: input.role,
    });
    return { id, email, role: input.role };
  })();
}

export function listMembers(db: Database) {
  return db
    .query(
      `SELECT u.id, u.email, u.name, u.active, tm.role FROM team_members tm
       JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $t ORDER BY tm.role, u.email`,
    )
    .all({ $t: TEAM_ID });
}

export function deactivateMember(db: Database, userId: string) {
  return db.transaction(() => {
    const r = db.query("UPDATE users SET active = 0 WHERE id = $id").run({ $id: userId });
    if (r.changes === 0) throw new DomainError("User not found.");
    db.query("DELETE FROM sessions WHERE user_id = $id").run({ $id: userId });
    return { id: userId, active: false };
  })();
}

// Returns a raw session token (shown once). Only its hash is stored.
export async function login(db: Database, email: string, password: string) {
  const generic = new DomainError("Wrong email or password.");
  let user: any = null;
  try {
    user = one(db, "SELECT * FROM users WHERE email = $e", { $e: normalizeEmail(email) });
  } catch {
    throw generic;
  }
  if (!user || !user.active) {
    // Spend comparable time to avoid user enumeration by timing.
    await Bun.password.verify(password, "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").catch(() => false);
    throw generic;
  }
  if (!(await Bun.password.verify(password, user.password_hash))) throw generic;

  const member = one(db, "SELECT role FROM team_members WHERE user_id = $u AND team_id = $t", {
    $u: user.id,
    $t: TEAM_ID,
  });
  if (!member) throw generic;

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.query("DELETE FROM sessions WHERE expires_at < $now").run({ $now: new Date().toISOString() });
  db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($h, $u, $x)").run({
    $h: sha256(token),
    $u: user.id,
    $x: expires,
  });
  return { token, expires_at: expires, user: { id: user.id, email: user.email, name: user.name, role: member.role as Role } };
}

export function logout(db: Database, token: string) {
  db.query("DELETE FROM sessions WHERE token_hash = $h").run({ $h: sha256(token) });
  return { ok: true };
}

// Resolves a bearer credential to a role. ADMIN_TOKEN is the break-glass owner key.
export function resolveAuth(
  db: Database,
  bearer: string | null,
  adminToken: string,
): { role: Role; userId: string | null } {
  if (!bearer) return { role: "public", userId: null };
  if (adminToken && constantTimeEqual(bearer, adminToken)) return { role: "owner", userId: null };
  const row = one(
    db,
    `SELECT s.user_id, s.expires_at, u.active, tm.role FROM sessions s
     JOIN users u ON u.id = s.user_id
     JOIN team_members tm ON tm.user_id = s.user_id AND tm.team_id = $t
     WHERE s.token_hash = $h`,
    { $h: sha256(bearer), $t: TEAM_ID },
  );
  if (!row || !row.active || Date.parse(row.expires_at) < Date.now()) return { role: "public", userId: null };
  return { role: row.role as Role, userId: row.user_id };
}

export function currentUser(db: Database, userId: string) {
  return one(db, "SELECT id, email, name FROM users WHERE id = $id", { $id: userId });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
