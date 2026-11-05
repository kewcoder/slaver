import { APP_VERSION } from "./version.ts";

// Update check: compares the running version against a JSON document at
// UPDATE_CHECK_URL, e.g. {"version":"0.5.0","notes":"...","url":"..."}.
// Host it anywhere (a file in the release repo, a marketplace endpoint).
// Unset URL = check disabled; the admin banner simply never shows.

export interface UpdateCheckConfig {
  url?: string;
  ttlMs?: number;
}

export interface UpdateStatus {
  configured: boolean;
  current: string;
  latest: string | null;
  update_available: boolean;
  checked_at: string | null;
  notes?: string;
  url?: string;
  error?: string;
}

const DEFAULT_TTL_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 10_000;

// In-memory cache (per URL) so every admin page load does not hit the network.
const cache = new Map<string, { at: number; status: UpdateStatus }>();

export function clearUpdateCache() {
  cache.clear();
}

// Numeric dot-separated compare. Returns negative/0/positive.
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".");
  const pb = b.replace(/^v/i, "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    const va = Number.isFinite(na) ? na : 0;
    const vb = Number.isFinite(nb) ? nb : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

export async function checkForUpdates(
  cfg: UpdateCheckConfig,
  opts?: { refresh?: boolean },
): Promise<UpdateStatus> {
  const url = cfg.url?.trim() ?? "";
  if (!url) {
    return { configured: false, current: APP_VERSION, latest: null, update_available: false, checked_at: null };
  }
  const ttl = cfg.ttlMs ?? DEFAULT_TTL_MS;
  const hit = cache.get(url);
  if (!opts?.refresh && hit && Date.now() - hit.at < ttl) return hit.status;

  const fail = (error: string): UpdateStatus => {
    // Serve the last good result (marked stale) rather than nothing.
    if (hit) return { ...hit.status, error };
    return { configured: true, current: APP_VERSION, latest: null, update_available: false, checked_at: null, error };
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return fail(`Update check HTTP ${res.status}.`);
    const body = (await res.json()) as { version?: unknown; notes?: unknown; url?: unknown };
    const latest = typeof body.version === "string" ? body.version.trim() : "";
    if (!latest) return fail("Update check returned no version.");
    const status: UpdateStatus = {
      configured: true,
      current: APP_VERSION,
      latest,
      update_available: compareVersions(latest, APP_VERSION) > 0,
      checked_at: new Date().toISOString(),
      notes: typeof body.notes === "string" ? body.notes : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
    };
    cache.set(url, { at: Date.now(), status });
    return status;
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "Update check timed out." : `Update check failed: ${e instanceof Error ? e.message : String(e)}`;
    return fail(msg);
  }
}
