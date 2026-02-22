#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
#[cfg(target_family = "unix")]
use std::{env, os::unix::net::UnixStream};
#[cfg(target_os = "windows")]
use std::{env, fs::OpenOptions};
use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager,
};

/* ── Structs ── */

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct Session {
  session_id: String,
  cli: String,
  cwd: String,
  status: String,
  started_at: String,
  interactive_bot_id: Option<String>,
  interactive_bot_connected: Option<bool>,
  push_bot_id: Option<String>,
  push_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonSession {
  session_id: String,
  cli: String,
  cwd: String,
  status: String,
  started_at: String,
  interactive_bot_id: Option<String>,
  interactive_bot_connected: Option<bool>,
  push_bot_id: Option<String>,
  push_enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BotWarning {
  bot_id: String,
  message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatusPayload {
  daemon_pid: i64,
  active_sessions: i64,
  sessions: Vec<DaemonSession>,
  warnings: Option<Vec<BotWarning>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
  payload: DaemonStatusPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStopPayload {
  ok: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStopResponse {
  payload: DaemonStopPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct GuiStatus {
  running: bool,
  daemon_pid: Option<i64>,
  active_sessions: i64,
  sessions: Vec<Session>,
  warnings: Vec<BotWarning>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct DaemonLockFile {
  pid: i64,
  ipc: String,
}

/* ── Generic IPC response wrappers ── */

#[derive(Debug, Deserialize)]
struct GenericOkPayload {
  ok: bool,
  error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GenericOkResponse {
  payload: GenericOkPayload,
}

/* ── Helpers ── */

fn get_home_dir() -> Option<String> {
  env::var("USERPROFILE")
    .ok()
    .or_else(|| env::var("HOME").ok())
}

fn get_lock_file_path() -> Option<PathBuf> {
  let home = get_home_dir()?;
  Some(PathBuf::from(home).join(".felay").join("daemon.json"))
}

fn default_ipc_path() -> Option<String> {
  #[cfg(target_os = "windows")]
  {
    Some(String::from("\\\\.\\pipe\\felay"))
  }
  #[cfg(target_family = "unix")]
  {
    let home = get_home_dir()?;
    Some(format!("{home}/.felay/daemon.sock"))
  }
}

fn read_lock_file() -> Option<DaemonLockFile> {
  let lock_path = get_lock_file_path()?;
  let lock_text = fs::read_to_string(lock_path).ok()?;
  serde_json::from_str::<DaemonLockFile>(&lock_text).ok()
}

fn get_ipc_path() -> Option<String> {
  read_lock_file()
    .map(|lock| lock.ipc)
    .or_else(default_ipc_path)
}

/// Send a JSON-line request to the daemon and read one JSON-line reply.
/// Returns the raw JSON Value of the full response.
#[cfg(target_os = "windows")]
fn ipc_request(ipc_path: &str, request: &str) -> Option<Value> {
  let mut pipe = OpenOptions::new().read(true).write(true).open(ipc_path).ok()?;
  pipe.write_all(request.as_bytes()).ok()?;
  pipe.write_all(b"\n").ok()?;
  pipe.flush().ok()?;

  // Windows named pipes opened via OpenOptions don't support set_read_timeout directly,
  // so we wrap with a timeout on the entire read phase via a spawned thread.
  let (tx, rx) = std::sync::mpsc::channel();
  let handle = thread::spawn(move || {
    let mut line = String::new();
    let mut reader = BufReader::new(pipe);
    if reader.read_line(&mut line).is_ok() {
      let _ = tx.send(line);
    }
  });
  let line = rx.recv_timeout(Duration::from_secs(10)).ok()?;
  let _ = handle.join();

  serde_json::from_str::<Value>(line.trim()).ok()
}

#[cfg(target_family = "unix")]
fn ipc_request(ipc_path: &str, request: &str) -> Option<Value> {
  let mut socket = UnixStream::connect(ipc_path).ok()?;
  socket
    .set_read_timeout(Some(Duration::from_secs(10)))
    .ok()?;
  socket.write_all(request.as_bytes()).ok()?;
  socket.write_all(b"\n").ok()?;
  socket.flush().ok()?;

  let mut line = String::new();
  let mut reader = BufReader::new(socket);
  reader.read_line(&mut line).ok()?;

  serde_json::from_str::<Value>(line.trim()).ok()
}

fn ipc_request_typed<T: for<'de> Deserialize<'de>>(ipc_path: &str, request: &str) -> Option<T> {
  let value = ipc_request(ipc_path, request)?;
  serde_json::from_value::<T>(value).ok()
}

/* ── Platform-specific status/stop using new generic helper ── */

fn request_daemon_status(ipc_path: &str) -> Option<DaemonStatusPayload> {
  let resp = ipc_request_typed::<DaemonStatus>(ipc_path, r#"{"type":"status_request"}"#)?;
  Some(resp.payload)
}

fn send_stop_request(ipc_path: &str) -> bool {
  ipc_request_typed::<DaemonStopResponse>(ipc_path, r#"{"type":"stop_request"}"#)
    .map(|r| r.payload.ok)
    .unwrap_or(false)
}

fn daemon_stop() -> bool {
  let Some(ipc_path) = get_ipc_path() else {
    return false;
  };
  send_stop_request(&ipc_path)
}

/* ── Tauri commands ── */

#[tauri::command]
fn read_daemon_status() -> GuiStatus {
  let Some(ipc_path) = get_ipc_path() else {
    return GuiStatus {
      running: false,
      daemon_pid: None,
      active_sessions: 0,
      sessions: vec![],
      warnings: vec![],
    };
  };

  let Some(status) = request_daemon_status(&ipc_path) else {
    return GuiStatus {
      running: false,
      daemon_pid: None,
      active_sessions: 0,
      sessions: vec![],
      warnings: vec![],
    };
  };

  GuiStatus {
    running: true,
    daemon_pid: Some(status.daemon_pid),
    active_sessions: status.active_sessions,
    sessions: status
      .sessions
      .into_iter()
      .map(|s| Session {
        session_id: s.session_id,
        cli: s.cli,
        cwd: s.cwd,
        status: s.status,
        started_at: s.started_at,
        interactive_bot_id: s.interactive_bot_id,
        interactive_bot_connected: s.interactive_bot_connected,
        push_bot_id: s.push_bot_id,
        push_enabled: s.push_enabled,
      })
      .collect(),
    warnings: status.warnings.unwrap_or_default(),
  }
}

#[tauri::command]
fn list_bots() -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "interactive": [], "push": [] });
  };

  let req = r#"{"type":"list_bots_request"}"#;
  if let Some(value) = ipc_request(&ipc_path, req) {
    // The response has { type, payload: { interactive, push } }
    if let Some(payload) = value.get("payload") {
      return payload.clone();
    }
  }
  serde_json::json!({ "interactive": [], "push": [] })
}

#[tauri::command]
fn save_bot(bot_type: String, config: Value) -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = if bot_type == "interactive" {
    serde_json::json!({
      "type": "save_bot_request",
      "payload": { "botType": "interactive", "interactive": config }
    })
  } else {
    serde_json::json!({
      "type": "save_bot_request",
      "payload": { "botType": "push", "push": config }
    })
  };

  let req_str = serde_json::to_string(&req).unwrap_or_default();
  if let Some(resp) = ipc_request_typed::<GenericOkResponse>(&ipc_path, &req_str) {
    serde_json::json!({ "ok": resp.payload.ok, "error": resp.payload.error })
  } else {
    serde_json::json!({ "ok": false, "error": "no response from daemon" })
  }
}

#[tauri::command]
fn delete_bot(bot_type: String, bot_id: String) -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = serde_json::json!({
    "type": "delete_bot_request",
    "payload": { "botType": bot_type, "botId": bot_id }
  });
  let req_str = serde_json::to_string(&req).unwrap_or_default();

  if let Some(resp) = ipc_request_typed::<GenericOkResponse>(&ipc_path, &req_str) {
    serde_json::json!({ "ok": resp.payload.ok, "error": resp.payload.error })
  } else {
    serde_json::json!({ "ok": false, "error": "no response from daemon" })
  }
}

#[tauri::command]
fn bind_bot(session_id: String, bot_type: String, bot_id: String) -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = serde_json::json!({
    "type": "bind_bot_request",
    "payload": { "sessionId": session_id, "botType": bot_type, "botId": bot_id }
  });
  let req_str = serde_json::to_string(&req).unwrap_or_default();

  if let Some(resp) = ipc_request_typed::<GenericOkResponse>(&ipc_path, &req_str) {
    serde_json::json!({ "ok": resp.payload.ok, "error": resp.payload.error })
  } else {
    serde_json::json!({ "ok": false, "error": "no response from daemon" })
  }
}

#[tauri::command]
fn unbind_bot(session_id: String, bot_type: String) -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = serde_json::json!({
    "type": "unbind_bot_request",
    "payload": { "sessionId": session_id, "botType": bot_type }
  });
  let req_str = serde_json::to_string(&req).unwrap_or_default();

  if let Some(resp) = ipc_request_typed::<GenericOkResponse>(&ipc_path, &req_str) {
    serde_json::json!({ "ok": resp.payload.ok, "error": resp.payload.error })
  } else {
    serde_json::json!({ "ok": false, "error": "no response from daemon" })
  }
}

#[tauri::command]
fn test_bot(bot_type: String, bot_id: String) -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = serde_json::json!({
    "type": "test_bot_request",
    "payload": { "botType": bot_type, "botId": bot_id }
  });
  let req_str = serde_json::to_string(&req).unwrap_or_default();

  if let Some(resp) = ipc_request_typed::<GenericOkResponse>(&ipc_path, &req_str) {
    serde_json::json!({ "ok": resp.payload.ok, "error": resp.payload.error })
  } else {
    serde_json::json!({ "ok": false, "error": "no response from daemon" })
  }
}

#[tauri::command]
fn get_config() -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!(null);
  };

  let req = r#"{"type":"get_config_request"}"#;
  if let Some(value) = ipc_request(&ipc_path, req) {
    if let Some(payload) = value.get("payload") {
      return payload.clone();
    }
  }
  serde_json::json!(null)
}

#[tauri::command]
fn save_config(config: Value) -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = serde_json::json!({
    "type": "save_config_request",
    "payload": config
  });
  let req_str = serde_json::to_string(&req).unwrap_or_default();

  if let Some(resp) = ipc_request_typed::<GenericOkResponse>(&ipc_path, &req_str) {
    serde_json::json!({ "ok": resp.payload.ok, "error": resp.payload.error })
  } else {
    serde_json::json!({ "ok": false, "error": "no response from daemon" })
  }
}

/* ── Window helpers ── */

fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

/* ── Start daemon from GUI ── */

/// Check whether the daemon is currently reachable via IPC.
fn is_daemon_running() -> bool {
  let Some(ipc_path) = get_ipc_path() else {
    return false;
  };
  request_daemon_status(&ipc_path).is_some()
}

/// Resolve the path to the daemon executable.
/// Looks next to the current exe first, then in the Tauri resource directory.
fn find_daemon_exe(app: &AppHandle) -> Result<PathBuf, String> {
  let exe_dir = std::env::current_exe()
    .map_err(|e| e.to_string())?
    .parent()
    .ok_or_else(|| "cannot determine exe dir".to_string())?
    .to_path_buf();

  let daemon_name = if cfg!(target_os = "windows") {
    "felay-daemon.exe"
  } else {
    "felay-daemon"
  };

  // 1. Next to the GUI executable (production install layout)
  let candidate = exe_dir.join(daemon_name);
  if candidate.exists() {
    return Ok(candidate);
  }

  // 2. Tauri resource directory
  if let Ok(resource_dir) = app.path().resource_dir() {
    let candidate = resource_dir.join(daemon_name);
    if candidate.exists() {
      return Ok(candidate);
    }
  }

  Err(format!("daemon not found: {}", daemon_name))
}

/// Spawn the daemon process in detached mode.
fn spawn_daemon(daemon_path: &std::path::Path) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x00000008;
    std::process::Command::new(daemon_path)
      .creation_flags(DETACHED_PROCESS)
      .spawn()
      .map_err(|e| e.to_string())?;
  }

  #[cfg(not(target_os = "windows"))]
  {
    std::process::Command::new(daemon_path)
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .map_err(|e| e.to_string())?;
  }

  Ok(())
}

#[tauri::command]
fn start_daemon(app: AppHandle) -> Value {
  // If daemon is already running, return immediately
  if is_daemon_running() {
    return serde_json::json!({ "ok": true, "already_running": true });
  }

  let daemon_path = match find_daemon_exe(&app) {
    Ok(p) => p,
    Err(e) => return serde_json::json!({ "ok": false, "error": e }),
  };

  match spawn_daemon(&daemon_path) {
    Ok(_) => serde_json::json!({ "ok": true }),
    Err(e) => serde_json::json!({ "ok": false, "error": e }),
  }
}

#[tauri::command]
fn check_codex_config() -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!(null);
  };

  let req = r#"{"type":"check_codex_config_request"}"#;
  if let Some(value) = ipc_request(&ipc_path, req) {
    if let Some(payload) = value.get("payload") {
      return payload.clone();
    }
  }
  serde_json::json!(null)
}

#[tauri::command]
fn open_codex_config_file() -> Value {
  let Some(home) = get_home_dir() else {
    return serde_json::json!({ "ok": false, "error": "cannot determine home directory" });
  };
  let config_path = PathBuf::from(&home).join(".codex").join("config.toml");

  if !config_path.exists() {
    // Create the file so the user can edit it
    let codex_dir = PathBuf::from(&home).join(".codex");
    if !codex_dir.exists() {
      return serde_json::json!({ "ok": false, "error": "~/.codex/ 目录不存在，请先安装 Codex" });
    }
    if let Err(e) = fs::write(&config_path, "") {
      return serde_json::json!({ "ok": false, "error": format!("无法创建 config.toml: {}", e) });
    }
  }

  let result = {
    #[cfg(target_os = "windows")]
    {
      std::process::Command::new("cmd")
        .args(["/c", "start", "", &config_path.to_string_lossy()])
        .spawn()
    }
    #[cfg(target_os = "macos")]
    {
      std::process::Command::new("open")
        .arg(&config_path)
        .spawn()
    }
    #[cfg(target_os = "linux")]
    {
      std::process::Command::new("xdg-open")
        .arg(&config_path)
        .spawn()
    }
  };

  match result {
    Ok(_) => serde_json::json!({ "ok": true }),
    Err(e) => serde_json::json!({ "ok": false, "error": format!("无法打开文件: {}", e) }),
  }
}

#[tauri::command]
fn setup_codex_config() -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = r#"{"type":"setup_codex_config_request"}"#;
  if let Some(resp) = ipc_request_typed::<GenericOkResponse>(&ipc_path, req) {
    serde_json::json!({ "ok": resp.payload.ok, "error": resp.payload.error })
  } else {
    serde_json::json!({ "ok": false, "error": "no response from daemon" })
  }
}

#[tauri::command]
fn check_claude_config() -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!(null);
  };

  let req = r#"{"type":"check_claude_config_request"}"#;
  if let Some(value) = ipc_request(&ipc_path, req) {
    if let Some(payload) = value.get("payload") {
      return payload.clone();
    }
  }
  serde_json::json!(null)
}

#[tauri::command]
fn setup_claude_config() -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = r#"{"type":"setup_claude_config_request"}"#;
  if let Some(resp) = ipc_request_typed::<GenericOkResponse>(&ipc_path, req) {
    serde_json::json!({ "ok": resp.payload.ok, "error": resp.payload.error })
  } else {
    serde_json::json!({ "ok": false, "error": "no response from daemon" })
  }
}

#[tauri::command]
fn open_claude_config_file() -> Value {
  let Some(home) = get_home_dir() else {
    return serde_json::json!({ "ok": false, "error": "cannot determine home directory" });
  };
  let config_path = PathBuf::from(&home).join(".claude").join("settings.json");

  if !config_path.exists() {
    let claude_dir = PathBuf::from(&home).join(".claude");
    if !claude_dir.exists() {
      return serde_json::json!({ "ok": false, "error": "~/.claude/ 目录不存在，请先安装 Claude Code" });
    }
    if let Err(e) = fs::write(&config_path, "{}") {
      return serde_json::json!({ "ok": false, "error": format!("无法创建 settings.json: {}", e) });
    }
  }

  let result = {
    #[cfg(target_os = "windows")]
    {
      std::process::Command::new("cmd")
        .args(["/c", "start", "", &config_path.to_string_lossy()])
        .spawn()
    }
    #[cfg(target_os = "macos")]
    {
      std::process::Command::new("open")
        .arg(&config_path)
        .spawn()
    }
    #[cfg(target_os = "linux")]
    {
      std::process::Command::new("xdg-open")
        .arg(&config_path)
        .spawn()
    }
  };

  match result {
    Ok(_) => serde_json::json!({ "ok": true }),
    Err(e) => serde_json::json!({ "ok": false, "error": format!("无法打开文件: {}", e) }),
  }
}

/// Auto-start the daemon on app launch.
/// Spawns the daemon if not already running, then waits up to ~6 seconds
/// for it to become reachable. Runs on a background thread so the UI is
/// not blocked.
fn auto_start_daemon(app: &AppHandle) {
  if is_daemon_running() {
    println!("[gui] daemon already running, skipping auto-start");
    return;
  }

  let daemon_path = match find_daemon_exe(app) {
    Ok(p) => p,
    Err(e) => {
      println!("[gui] auto-start skipped: {}", e);
      return;
    }
  };

  println!("[gui] auto-starting daemon from {:?}", daemon_path);

  if let Err(e) = spawn_daemon(&daemon_path) {
    println!("[gui] failed to auto-start daemon: {}", e);
    return;
  }

  // Wait for the daemon to become reachable (up to ~6 seconds)
  for _ in 0..20 {
    thread::sleep(Duration::from_millis(300));
    if is_daemon_running() {
      println!("[gui] daemon is now running");
      return;
    }
  }

  println!("[gui] daemon auto-start: timeout waiting for daemon to become reachable");
}

/* ── Entry point ── */

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      read_daemon_status,
      list_bots,
      save_bot,
      delete_bot,
      bind_bot,
      unbind_bot,
      test_bot,
      get_config,
      save_config,
      start_daemon,
      check_codex_config,
      setup_codex_config,
      open_codex_config_file,
      check_claude_config,
      setup_claude_config,
      open_claude_config_file,
    ])
    .setup(|app| {
      // Auto-start daemon on a background thread so UI is not blocked
      let app_handle = app.handle().clone();
      thread::spawn(move || {
        auto_start_daemon(&app_handle);
      });

      let open = MenuItem::with_id(app, "open", "打开面板", true, None::<&str>)?;
      let sessions_item =
        MenuItem::with_id(app, "sessions", "活跃会话: 0", false, None::<&str>)?;
      let status_item =
        MenuItem::with_id(app, "status", "Daemon: 读取状态", false, None::<&str>)?;
      let stop = MenuItem::with_id(app, "stop", "停止 Daemon", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

      let menu = Menu::with_items(app, &[&open, &sessions_item, &status_item, &stop, &quit])?;

      // Clone menu items for background status polling thread
      let sessions_clone = sessions_item.clone();
      let status_clone = status_item.clone();

      thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(5));

        let ipc_path = match get_ipc_path() {
          Some(p) => p,
          None => {
            let _ = status_clone.set_text("Daemon: 未运行");
            let _ = sessions_clone.set_text("活跃会话: 0");
            continue;
          }
        };

        match request_daemon_status(&ipc_path) {
          Some(payload) => {
            let _ = status_clone.set_text("Daemon: 运行中");
            let _ =
              sessions_clone.set_text(format!("活跃会话: {}", payload.active_sessions));
          }
          None => {
            let _ = status_clone.set_text("Daemon: 未运行");
            let _ = sessions_clone.set_text("活跃会话: 0");
          }
        }
      });

      TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
          "open" => show_main_window(app),
          "stop" => {
            if daemon_stop() {
              println!("[gui] stop daemon requested");
            } else {
              println!("[gui] daemon stop request failed");
            }
          }
          "quit" => app.exit(0),
          _ => {}
        })
        .on_tray_icon_event(|tray, event| {
          if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
          } = event
          {
            show_main_window(tray.app_handle());
          }
        })
        .build(app)?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
