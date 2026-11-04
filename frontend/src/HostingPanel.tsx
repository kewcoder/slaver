import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectHosting,
  disconnectHosting,
  fetchHostingAccounts,
  fetchInstalls,
  startInstall,
  type HostingAccount,
  type HostingProvider,
  type Install,
} from "./api";
import { useLang, type StringsKey } from "./i18n";
import { Icon, Spinner } from "./ui";

export interface ProviderMeta {
  id: HostingProvider;
  name: string;
  mark: string;
  color: string;
  tokenUrl: string;
  refKey: StringsKey | null;
  refRequired: boolean;
  noteKey: StringsKey;
}

export const PROVIDERS: ProviderMeta[] = [
  { id: "vercel", name: "Vercel", mark: "▲", color: "bg-fg text-bg", tokenUrl: "https://vercel.com/account/tokens", refKey: "host.refVercel", refRequired: false, noteKey: "host.noteVercel" },
  { id: "netlify", name: "Netlify", mark: "◆", color: "bg-[#32e6e2] text-[#0b2b2a]", tokenUrl: "https://app.netlify.com/user/applications#personal-access-tokens", refKey: null, refRequired: false, noteKey: "host.noteNetlify" },
  { id: "cloudflare", name: "Cloudflare Pages", mark: "☁", color: "bg-[#f6821f] text-white", tokenUrl: "https://dash.cloudflare.com/profile/api-tokens", refKey: "host.refCloudflare", refRequired: true, noteKey: "host.noteCloudflare" },
  { id: "fly", name: "Fly.io", mark: "✈", color: "bg-[#7c3aed] text-white", tokenUrl: "https://fly.io/user/personal_access_tokens", refKey: "host.refFly", refRequired: false, noteKey: "host.noteFly" },
];

export function providerMeta(id: string): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export function ProviderMark({ id, size = "md" }: { id: string; size?: "sm" | "md" }) {
  const p = providerMeta(id);
  const dims = size === "sm" ? "h-7 w-7 text-xs" : "h-10 w-10 text-base";
  return <span className={`flex ${dims} shrink-0 items-center justify-center rounded-xl font-black ${p.color}`}>{p.mark}</span>;
}

export function InstallStatus({ status }: { status: Install["status"] }) {
  const { t } = useLang();
  const cls =
    status === "live"
      ? "border-accent/30 bg-accent/10 text-accent-text"
      : status === "failed"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : "border-amber-400/30 bg-amber-400/10 text-amber-200";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-bold ${cls}`}>
      {(status === "queued" || status === "running") && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {t(`install.status.${status}` as StringsKey)}
    </span>
  );
}

/** Inline form to connect one provider. */
export function ConnectHostingForm({ teamId, provider, onConnected, onCancel }: { teamId: string; provider: HostingProvider; onConnected: (a: HostingAccount) => void; onCancel?: () => void }) {
  const { t } = useLang();
  const meta = providerMeta(provider);
  const [token, setToken] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim() || busy || (meta.refRequired && !ref.trim())) return;
    setBusy(true);
    setError("");
    try {
      onConnected(await connectHosting(teamId, { provider, api_token: token.trim(), account_ref: ref.trim() }));
      setToken("");
      setRef("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("host.connectFail"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-fg/[0.08] bg-surface p-4">
      <div className="flex items-start gap-3">
        <ProviderMark id={provider} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-fg">{t("host.connectTitle", { name: meta.name })}</div>
          <p className="mt-0.5 text-xs leading-5 text-muted">
            {t("host.tokenHelp")}{" "}
            <a href={meta.tokenUrl} target="_blank" rel="noreferrer" className="font-semibold text-accent-text hover:underline">
              {t("host.getToken", { name: meta.name })} ↗
            </a>
          </p>
        </div>
      </div>
      <label className="text-xs font-semibold text-fg-2">
        {t("host.token")}
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder="••••••••" className="field mt-1.5 font-mono text-xs" />
      </label>
      {meta.refKey && (
        <label className="text-xs font-semibold text-fg-2">
          {t(meta.refKey)}
          <input value={ref} onChange={(e) => setRef(e.target.value)} autoComplete="off" className="field mt-1.5 font-mono text-xs" />
        </label>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !token.trim() || (meta.refRequired && !ref.trim())} className="btn-primary">
          {busy ? <Spinner /> : <Icon name="check" size={15} />}
          {t("host.connect")}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-secondary">
            {t("common.cancel")}
          </button>
        )}
        <span className="ml-auto text-[11px] text-subtle">{t("host.tokenSafe")}</span>
      </div>
    </form>
  );
}

/** Settings → Hosting: manage connected accounts for all providers. */
export function HostingAccountsManager({ teamId, canManage }: { teamId: string | null; canManage: boolean }) {
  const { t } = useLang();
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [adding, setAdding] = useState<HostingProvider | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!teamId) return setAccounts([]);
    try {
      setAccounts(await fetchHostingAccounts(teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("host.loadFail"));
    }
  }, [teamId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function remove(a: HostingAccount) {
    if (!teamId || !window.confirm(t("host.disconnectConfirm", { name: `${providerMeta(a.provider).name} · ${a.name}` }))) return;
    try {
      await disconnectHosting(teamId, a.provider, a.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("host.loadFail"));
    }
  }

  if (!teamId) return <p className="text-sm text-muted">{t("files.pickTeam")}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-bold text-fg">{t("host.title")}</h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t("host.body")}</p>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map((p) => {
          const mine = accounts.filter((a) => a.provider === p.id);
          return (
            <div key={p.id} className="surface flex flex-col gap-3 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <ProviderMark id={p.id} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-fg">{p.name}</div>
                  <div className="text-[11px] leading-4 text-subtle">{t(p.noteKey)}</div>
                </div>
              </div>
              {mine.map((a) => (
                <div key={a.id} className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2 text-xs">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1 truncate text-fg-2">{a.name}{a.account_ref ? ` · ${a.account_ref}` : ""}</span>
                  {canManage && (
                    <button type="button" onClick={() => remove(a)} className="text-subtle hover:text-red-300">
                      {t("host.disconnect")}
                    </button>
                  )}
                </div>
              ))}
              {canManage && adding !== p.id && (
                <button type="button" onClick={() => setAdding(p.id)} className="btn-secondary self-start px-3 py-1.5 text-xs">
                  <Icon name="plus" size={14} />
                  {mine.length ? t("host.addAnother") : t("host.connect")}
                </button>
              )}
              {adding === p.id && (
                <ConnectHostingForm
                  teamId={teamId}
                  provider={p.id}
                  onCancel={() => setAdding(null)}
                  onConnected={async () => {
                    setAdding(null);
                    await refresh();
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Modal: install (deploy) an owned app onto the team's own hosting. */
export function InstallDialog({
  teamId,
  projectId,
  projectName,
  onClose,
  onLive,
}: {
  teamId: string;
  projectId: string;
  projectName: string;
  onClose: () => void;
  onLive?: (url: string) => void;
}) {
  const { t } = useLang();
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [history, setHistory] = useState<Install[]>([]);
  const [provider, setProvider] = useState<HostingProvider | null>(null);
  const [accountId, setAccountId] = useState("");
  const [siteName, setSiteName] = useState("");
  const [current, setCurrent] = useState<Install | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  const liveFired = useRef<string>("");

  const refresh = useCallback(async () => {
    try {
      const [acc, inst] = await Promise.all([fetchHostingAccounts(teamId), fetchInstalls(teamId, projectId)]);
      setAccounts(acc);
      setHistory(inst);
      return { acc, inst };
    } catch (err) {
      setError(err instanceof Error ? err.message : t("host.loadFail"));
      return null;
    }
  }, [teamId, projectId, t]);

  useEffect(() => {
    void refresh().then((r) => {
      if (!r) return;
      const running = r.inst.find((i) => i.status === "queued" || i.status === "running");
      if (running) setCurrent(running);
      const last = r.inst.find((i) => i.status === "live") ?? r.inst[0];
      if (last) {
        setProvider(last.provider);
        setAccountId(last.account_id);
        setSiteName(last.site_name);
      } else if (r.acc[0]) {
        setProvider(r.acc[0].provider);
        setAccountId(r.acc[0].id);
      }
    });
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Poll the running install.
  useEffect(() => {
    if (!current || current.status === "live" || current.status === "failed") return;
    const h = window.setInterval(async () => {
      try {
        const list = await fetchInstalls(teamId, projectId);
        setHistory(list);
        const next = list.find((i) => i.id === current.id);
        if (next) setCurrent(next);
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => window.clearInterval(h);
  }, [current, teamId, projectId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    if (current?.status === "live" && current.url && liveFired.current !== current.id) {
      liveFired.current = current.id;
      onLive?.(current.url);
    }
  }, [current, onLive]);

  const providerAccounts = accounts.filter((a) => a.provider === provider);
  const effectiveAccount = providerAccounts.find((a) => a.id === accountId) ?? providerAccounts[0];
  const running = current && (current.status === "queued" || current.status === "running");

  function pick(p: HostingProvider) {
    setProvider(p);
    const a = accounts.find((x) => x.provider === p);
    setAccountId(a?.id ?? "");
    const prev = history.find((i) => i.provider === p && i.status === "live");
    setSiteName(prev?.site_name ?? "");
    setError("");
  }

  async function go() {
    if (!provider || !effectiveAccount || busy) return;
    setBusy(true);
    setError("");
    try {
      const row = await startInstall(projectId, provider, effectiveAccount.id, siteName.trim());
      setCurrent(row);
      setSiteName(row.site_name);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("install.fail"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t("install.title")} className="surface-raised flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl sm:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-fg/[0.07] px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent-text"><Icon name="rocket" size={20} /></span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-fg">{t("install.title")}</h3>
            <p className="truncate text-xs text-muted">{t("install.sub", { name: projectName })}</p>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label={t("common.close")}><Icon name="x" size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {current ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <ProviderMark id={current.provider} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-fg">{providerMeta(current.provider).name} · {current.site_name}</div>
                  <div className="text-[11px] text-subtle">{t("install.commit")} {current.commit_sha.slice(0, 8)}</div>
                </div>
                <InstallStatus status={current.status} />
              </div>
              {current.status === "live" && current.url && (
                <div className="rounded-xl border border-accent/25 bg-accent/[0.07] p-4">
                  <div className="text-sm font-bold text-accent-text">{t("install.liveTitle")}</div>
                  <a href={current.url} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-sm text-fg hover:underline">{current.url}</a>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <a href={current.url} target="_blank" rel="noreferrer" className="btn-primary"><Icon name="external" size={15} />{t("install.open")}</a>
                    <button type="button" onClick={onClose} className="btn-secondary">{t("install.done")}</button>
                  </div>
                </div>
              )}
              {current.status === "failed" && <p className="rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-3 text-sm text-red-200">{t("install.failedBody")}</p>}
              {running && <p className="flex items-center gap-2 text-sm text-muted"><Spinner />{t("install.wait")}</p>}
              <details open={current.status === "failed"} className="group rounded-xl border border-line">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-muted hover:text-fg">{t("install.showLog")}</summary>
                <pre ref={logRef} className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-line bg-inset p-3 font-mono text-[11.5px] leading-5 text-fg-2">
                  {current.log || "…"}
                  {running && <span className="ml-1 inline-block animate-pulse">▍</span>}
                </pre>
              </details>
              {!running && (
                <button type="button" onClick={() => setCurrent(null)} className="btn-secondary self-start">
                  {current.status === "failed" ? t("install.tryAgain") : t("install.another")}
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <div className="panel-title mb-2">{t("install.step1")}</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {PROVIDERS.map((p) => {
                    const connected = accounts.some((a) => a.provider === p.id);
                    const active = provider === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => pick(p.id)}
                        className={`flex flex-col items-center gap-2 rounded-xl border px-2 py-3 text-center ${active ? "border-accent/45 bg-accent/[0.08]" : "border-fg/[0.08] bg-surface hover:border-fg/[0.16]"}`}
                      >
                        <ProviderMark id={p.id} />
                        <span className="text-xs font-bold text-fg">{p.name}</span>
                        <span className={`text-[10px] font-semibold ${connected ? "text-accent-text" : "text-subtle"}`}>{connected ? t("host.connected") : t("host.notConnected")}</span>
                      </button>
                    );
                  })}
                </div>
                {provider && <p className="mt-2 text-xs leading-5 text-muted">{t(providerMeta(provider).noteKey)}</p>}
              </div>

              {provider && !effectiveAccount && (
                <div className="flex flex-col gap-2">
                <div className="panel-title">{t("install.stepConnect")}</div>
                <ConnectHostingForm
                  teamId={teamId}
                  provider={provider}
                  onConnected={async (a) => {
                    await refresh();
                    setAccountId(a.id);
                  }}
                />
                </div>
              )}

              {provider && effectiveAccount && (
                <div className="flex flex-col gap-3">
                  <div className="panel-title">{t("install.step2")}</div>
                  {providerAccounts.length > 1 && (
                    <label className="text-xs font-semibold text-fg-2">
                      {t("install.account")}
                      <select value={effectiveAccount.id} onChange={(e) => setAccountId(e.target.value)} className="field mt-1.5">
                        {providerAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}{a.account_ref ? ` · ${a.account_ref}` : ""}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="text-xs font-semibold text-fg-2">
                    {t("install.siteName")}
                    <input value={siteName} onChange={(e) => setSiteName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder={t("install.siteNamePh")} maxLength={40} className="field mt-1.5 font-mono text-xs" />
                    <span className="mt-1 block text-[11px] font-normal text-subtle">{t("install.siteNameHelp")}</span>
                  </label>
                  {error && <p className="text-sm text-red-300">{error}</p>}
                  <button type="button" onClick={go} disabled={busy} className="btn-primary self-start">
                    {busy ? <Spinner /> : <Icon name="rocket" size={15} />}
                    {history.some((i) => i.provider === provider && i.status === "live") ? t("install.redeploy") : t("install.go")}
                  </button>
                </div>
              )}
              {!provider && error && <p className="text-sm text-red-300">{error}</p>}
            </div>
          )}

          {history.length > 0 && !running && (
            <details className="mt-6 border-t border-line pt-4">
              <summary className="panel-title cursor-pointer select-none hover:text-fg">{t("install.history")} ({history.length})</summary>
              <ul className="mt-2 flex flex-col gap-1.5">
                {history.slice(0, 6).map((i) => (
                  <li key={i.id}>
                    <button type="button" onClick={() => setCurrent(i)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-fg/[0.04]">
                      <ProviderMark id={i.provider} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-xs text-fg-2">{i.url || i.site_name}</span>
                      <span className="hidden text-[11px] text-subtle sm:inline">{i.created_at.slice(0, 16).replace("T", " ")}</span>
                      <InstallStatus status={i.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
