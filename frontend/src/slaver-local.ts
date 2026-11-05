/// Bridge to the Tauri desktop shell. The web UI is identical everywhere;
/// when `window.SlaverLocal` exists (desktop), running + staging-preview
/// execute on the user's machine instead of a rented server.
///
/// NOTE: invoke() argument keys are snake_case to match the Rust commands.

export interface LocalRunInfo {
  running: boolean;
  url: string | null;
  port: number | null;
}

export interface LocalTunnel {
  running: boolean;
  url: string | null;
  mode: string | null;
  started_at: string | null;
}

interface SlaverLocalApi {
  deps(): Promise<{ bun: { found: boolean }; git: { found: boolean }; cloudflared: { found: boolean } }>;
  runApp(a: { key: string; clone_url: string; jwt: string; branch: string }): Promise<LocalRunInfo>;
  stopApp(key: string): Promise<LocalRunInfo>;
  appStatus(key: string): Promise<LocalRunInfo>;
  appLogs(key: string, tail?: number): Promise<string[]>;
  tunnelStart(port: number): Promise<LocalTunnel>;
  tunnelStop(): Promise<LocalTunnel>;
  tunnelStatus(): Promise<LocalTunnel>;
}

function api(): SlaverLocalApi | null {
  return (window as unknown as { SlaverLocal?: SlaverLocalApi }).SlaverLocal ?? null;
}

export const isDesktop = () => api() !== null;

export const localDeps = () => api()!.deps();
export const localRunApp = (a: { key: string; cloneUrl: string; jwt: string; branch: string }) =>
  api()!.runApp({ key: a.key, clone_url: a.cloneUrl, jwt: a.jwt, branch: a.branch });
export const localStopApp = (key: string) => api()!.stopApp(key);
export const localAppStatus = (key: string) => api()!.appStatus(key);
export const localAppLogs = (key: string, tail = 80) => api()!.appLogs(key, tail);
export const localTunnelStart = (port: number) => api()!.tunnelStart(port);
export const localTunnelStop = () => api()!.tunnelStop();
export const localTunnelStatus = () => api()!.tunnelStatus();
