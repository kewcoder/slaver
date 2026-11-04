import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMe, fetchTeams, fetchUpdates, setToken, setUserLang, type Team, type User } from "./api";
import { Brand, Icon, ThemeToggle, type IconName } from "./ui";
import { AuthView } from "./AuthView";
import { SettingsView } from "./SettingsView";
import { LangProvider, translate, useLang, type Lang, type StringsKey } from "./i18n";
import AppsView from "./AppsView";
import PublishView from "./PublishView";
import MarketView from "./MarketView";

type View = "apps" | "market" | "publish" | "settings";

const TEAM_KEY = "slaver_team";

function readTeam(): string | null {
  try {
    return localStorage.getItem(TEAM_KEY);
  } catch {
    return null;
  }
}

function AppShell() {
  const { lang, t, setLang: setUILang } = useLang();
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamIdState] = useState<string | null>(readTeam);
  const [view, setView] = useState<View>(() => (new URLSearchParams(window.location.search).get("view") === "publish" ? "publish" : "apps"));
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [langBusy, setLangBusy] = useState(false);
  const [updateCount, setUpdateCount] = useState(0);

  const setTeamId = useCallback((id: string | null) => {
    setTeamIdState(id);
    try {
      if (id) localStorage.setItem(TEAM_KEY, id);
      else localStorage.removeItem(TEAM_KEY);
    } catch {
      /* storage unavailable: selection lasts for this visit */
    }
  }, []);

  const loadTeams = useCallback(async () => {
    const list = await fetchTeams();
    setTeams(list);
    // Keep the remembered team when it is still ours; else prefer a shared team over the personal one.
    setTeamIdState((cur) => {
      const keep = cur && list.some((x) => x.id === cur) ? cur : (list.find((x) => !x.personal) ?? list[0])?.id ?? null;
      return keep;
    });
  }, []);

  useEffect(() => {
    fetchMe()
      .then(setUser)
      .catch(() => {
        setToken(null);
        setUser(null);
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (user) void loadTeams().catch(() => {});
  }, [user, loadTeams]);

  // Creator updates for owned apps: a badge only; nothing changes until the team syncs.
  useEffect(() => {
    if (!teamId) return setUpdateCount(0);
    let alive = true;
    const check = () => fetchUpdates(teamId).then((u) => alive && setUpdateCount(u.length)).catch(() => {});
    void check();
    const h = window.setInterval(check, 5 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, [teamId, view]);

  function goTo(next: View) {
    setView(next);
    setTeamMenuOpen(false);
    setUserMenuOpen(false);
  }

  function pickTeam(id: string) {
    setTeamId(id);
    setTeamMenuOpen(false);
  }

  async function switchLang(l: Lang) {
    if (l === lang || langBusy) return;
    setLangBusy(true);
    try {
      setUILang(l);
      setUser(await setUserLang(l));
    } catch {
      /* keep the local choice even if saving fails */
    } finally {
      setLangBusy(false);
    }
  }

  function logout() {
    setUserMenuOpen(false);
    setToken(null);
    setUser(null);
    setTeams([]);
  }

  if (checking) return <div className="flex min-h-screen items-center justify-center bg-bg text-muted">{t("common.loading")}</div>;
  if (!user) return <AuthView onAuth={setUser} />;

  const activeTeam = teams.find((x) => x.id === teamId);
  const navItems: { id: View; icon: IconName; label: string; badge?: number }[] = [
    { id: "apps", icon: "home", label: t("nav.apps"), badge: updateCount },
    { id: "market", icon: "market", label: t("nav.market") },
    { id: "publish", icon: "upload", label: t("nav.publish") },
  ];
  const pageMeta: Record<View, { title: string; sub: string }> = {
    apps: { title: t("apps.title"), sub: activeTeam?.name ?? t("shell.workspace") },
    market: { title: t("market.title"), sub: t("shell.marketSub") },
    publish: { title: t("pub.title"), sub: t("shell.publishSub") },
    settings: { title: t("settings.title"), sub: activeTeam?.name ?? t("shell.workspace") },
  };

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg">
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line bg-sidebar/95 px-3 backdrop-blur-xl sm:px-5">
        <div className="mr-2 hidden sm:block"><Brand /></div>
        <div className="sm:hidden"><Brand compact /></div>
        <nav className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto">
          {navItems.map((item) => {
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => goTo(item.id)}
                title={item.badge ? t("upd.navBadge", { n: item.badge }) : undefined}
                className={`relative flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-semibold ${active ? "bg-surface-2 text-accent-text" : "text-muted hover:bg-hover hover:text-fg"}`}
              >
                <Icon name={item.icon} size={17} />
                <span className="hidden sm:inline">{item.label}</span>
                {!!item.badge && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-black text-black">{item.badge}</span>}
              </button>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setTeamMenuOpen((v) => !v)}
              title={activeTeam?.name ? t("nav.changeTeam", { name: activeTeam.name }) : t("nav.pickTeam")}
              className="flex max-w-[180px] items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-sm font-semibold text-fg-2 hover:bg-hover hover:text-fg"
            >
              <span className="truncate">{activeTeam?.name ?? t("nav.pickTeam")}</span>
              <Icon name="chevron" size={14} className="shrink-0 text-subtle" />
            </button>
            {teamMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setTeamMenuOpen(false)} />
                <div className="surface-raised absolute right-0 top-11 z-50 w-64 overflow-hidden rounded-xl">
                  <div className="panel-title border-b border-line px-3 py-2.5">{t("nav.teamsTitle")}</div>
                  <div className="max-h-64 overflow-y-auto p-1.5">
                    {teams.map((team) => (
                      <button
                        key={team.id}
                        type="button"
                        onClick={() => pickTeam(team.id)}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-hover ${team.id === teamId ? "bg-accent/[0.07]" : ""}`}
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-xs font-black text-accent-text">{team.name.slice(0, 1).toUpperCase()}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-fg">{team.name}</span>
                          <span className="block text-[11px] text-subtle">{team.role}</span>
                        </span>
                        {team.id === teamId && <Icon name="check" size={15} className="text-accent" />}
                      </button>
                    ))}
                    {teams.length === 0 && <p className="px-3 py-2 text-xs text-subtle">{t("nav.noTeam")}</p>}
                  </div>
                </div>
              </>
            )}
          </div>
          <ThemeToggle />
          <div className="hidden rounded-lg border border-line p-0.5 text-[10px] font-bold sm:flex" title={t("settings.langTitle")}>
            {(["en", "id"] as const).map((l) => (
              <button
                key={l}
                type="button"
                disabled={langBusy}
                onClick={() => switchLang(l)}
                className={`rounded-md px-2 py-1.5 uppercase disabled:opacity-40 ${lang === l ? "bg-surface-2 text-accent-text" : "text-subtle hover:text-fg"}`}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setUserMenuOpen((v) => !v)}
              title={user.email}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface-2 text-sm font-bold text-accent-text hover:bg-hover"
            >
              {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
            </button>
            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div className="surface-raised absolute right-0 top-12 z-50 w-60 overflow-hidden rounded-xl">
                  <div className="border-b border-line px-3 py-2">
                    <div className="truncate text-sm font-semibold text-fg">{user.name || user.email}</div>
                    <div className="truncate text-[11px] text-subtle">{user.email}</div>
                  </div>
                  <div className="p-1">
                    <button type="button" onClick={() => goTo("settings")} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-hover hover:text-fg">
                      <Icon name="settings" size={16} /> {t("nav.settings")}
                    </button>
                    <button type="button" onClick={logout} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-hover hover:text-red-300">
                      <Icon name="logout" size={16} /> {t("settings.logout")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-line px-4 py-3 sm:px-6">
          <h1 className="text-base font-bold text-fg">{pageMeta[view].title}</h1>
          <p className="truncate text-xs text-muted">{pageMeta[view].sub}</p>
        </div>
        <main className="flex-1 overflow-y-auto">
          {view === "apps" ? (
            <AppsView teamId={teamId} teamName={activeTeam?.name} onGoMarket={() => goTo("market")} />
          ) : view === "market" ? (
            <MarketView teamId={teamId} onGoPublish={() => goTo("publish")} />
          ) : view === "publish" ? (
            <PublishView teamId={teamId} teamRole={activeTeam?.role ?? ""} onGoMarket={() => goTo("market")} />
          ) : (
            <SettingsView
              user={user}
              teams={teams}
              teamId={teamId}
              onPickTeam={(id) => setTeamId(id)}
              onTeamsChanged={loadTeams}
              onLogout={logout}
              onUserChanged={setUser}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem("slaver_lang") === "id" ? "id" : "en"));
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("slaver_lang", l);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(
    () => ({ lang, setLang, t: (key: StringsKey, vars?: Record<string, string | number>) => translate(lang, key, vars) }),
    [lang, setLang],
  );
  return (
    <LangProvider value={value}>
      <AppShell />
    </LangProvider>
  );
}
