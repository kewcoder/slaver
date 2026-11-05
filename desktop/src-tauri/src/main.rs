#![cfg_attr(not(debug_assertions), windows_subsystem = "windows_subsystem")]

mod local;

use tauri::Manager;

// Slaver server the desktop talks to: same data, same flow as the web.
// Only running + staging-preview execute on this machine.
fn server_url() -> String {
    let raw = std::env::var("SLAVER_SERVER_URL").unwrap_or_else(|_| "https://slaver.fly.dev".to_string());
    raw.trim_end_matches('/').to_string()
}

fn data_root(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path().app_data_dir().expect("app data dir").join("slaver-local")
}

/// JS bridge for the web UI: window.SlaverLocal.{...}.
const INIT_JS: &str = r#"
window.SlaverLocal = (() => {
  const invoke = window.__TAURI__.core.invoke;
  return {
    deps: () => invoke("deps"),
    runApp: (a) => invoke("run_app", a),
    stopApp: (key) => invoke("stop_app", { key }),
    appStatus: (key) => invoke("app_status", { key }),
    appLogs: (key, tail) => invoke("app_logs", { key, tail }),
    tunnelStart: (port) => invoke("tunnel_start", { port }),
    tunnelStop: () => invoke("tunnel_stop"),
    tunnelStatus: () => invoke("tunnel_status"),
  };
})();
// External links stay outside the app window.
document.addEventListener("click", (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
  if (a && a.href) { e.preventDefault(); window.__TAURI__.core.invoke("open_url", { url: a.href }); }
});
"#;

#[tauri::command]
fn deps() -> local::Deps {
    local::check_deps()
}

#[tauri::command]
async fn run_app(app: tauri::AppHandle, key: String, clone_url: String, jwt: String, branch: String) -> Result<local::RunInfo, String> {
    local::run_app(data_root(&app), key, clone_url, jwt, branch).await
}

#[tauri::command]
async fn stop_app(key: String) -> Result<local::RunInfo, String> {
    local::stop_app(&key).await
}

#[tauri::command]
fn app_status(key: String) -> local::RunInfo {
    local::app_status(&key)
}

#[tauri::command]
fn app_logs(key: String, tail: Option<u16>) -> Vec<String> {
    local::app_logs(&key, tail.unwrap_or(80) as usize)
}

#[tauri::command]
async fn tunnel_start(port: u16) -> Result<local::TunnelInfo, String> {
    local::tunnel_start(port).await
}

#[tauri::command]
async fn tunnel_stop() -> local::TunnelInfo {
    local::tunnel_stop().await
}

#[tauri::command]
fn tunnel_status() -> local::TunnelInfo {
    local::tunnel_status()
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

fn main() {
    let url = server_url();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            deps,
            run_app,
            stop_app,
            app_status,
            app_logs,
            tunnel_start,
            tunnel_stop,
            tunnel_status,
            open_url,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Wait until the server answers, then open the real SPA.
                // Same UI, same data as the web version — no loader screen.
                let client = reqwest_client();
                for _ in 0..120 {
                    if client.get(format!("{url}/ping")).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
                let _win = tauri::WebviewWindowBuilder::new(&handle, "main", tauri::WebviewUrl::External(url.parse().expect("server url")))
                    .title("Slaver Desktop")
                    .initialization_script(INIT_JS)
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(1000.0, 640.0)
                    .build()
                    .expect("main window");
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gagal membangun Slaver Desktop")
        .run(|_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                // Local child processes die with the app.
            }
        });
}

fn reqwest_client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().expect("http client")
}
