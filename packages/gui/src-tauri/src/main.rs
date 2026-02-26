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
  tray::{MouseButton, MouseButtonState, TrayIconEvent},
  AppHandle, Manager,
};
use tauri_plugin_dialog::DialogExt;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

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

#[derive(Debug, Serialize)]
struct UpdateInfo {
  not_modified: bool,
  etag: String,
  has_update: bool,
  current_version: String,
  latest_version: String,
  release_url: String,
  release_notes: String,
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

/// Compare two semver strings: returns true if `a` > `b`.
fn version_gt(a: &str, b: &str) -> bool {
  let parse = |s: &str| -> Vec<u64> {
    s.split('.').filter_map(|p| p.parse().ok()).collect()
  };
  let va = parse(a);
  let vb = parse(b);
  for i in 0..3 {
    let a_part = va.get(i).copied().unwrap_or(0);
    let b_part = vb.get(i).copied().unwrap_or(0);
    if a_part > b_part {
      return true;
    }
    if a_part < b_part {
      return false;
    }
  }
  false
}

/// Remove sensitive fields from a config JSON string.
fn sanitize_config(raw: &str) -> String {
  if let Ok(mut json) = serde_json::from_str::<Value>(raw) {
    sanitize_value(&mut json);
    serde_json::to_string_pretty(&json).unwrap_or_else(|_| raw.to_string())
  } else {
    raw.to_string()
  }
}

fn sanitize_value(value: &mut Value) {
  const SENSITIVE: &[&str] = &["appSecret", "encryptKey", "secret", "webhook"];
  match value {
    Value::Object(map) => {
      for (k, v) in map.iter_mut() {
        if SENSITIVE.iter().any(|s| k.contains(s)) {
          if v.is_string() && !v.as_str().unwrap_or("").is_empty() {
            *v = Value::String("***".to_string());
          }
        } else {
          sanitize_value(v);
        }
      }
    }
    Value::Array(arr) => {
      for v in arr.iter_mut() {
        sanitize_value(v);
      }
    }
    _ => {}
  }
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
fn activate_bot(bot_id: String) -> Value {
  let Some(ipc_path) = get_ipc_path() else {
    return serde_json::json!({ "ok": false, "error": "daemon not running" });
  };

  let req = serde_json::json!({
    "type": "activate_bot_request",
    "payload": { "botId": bot_id }
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

#[tauri::command]
async fn check_update(cached_etag: Option<String>) -> Result<UpdateInfo, String> {
  let current = env!("CARGO_PKG_VERSION");

  let client = reqwest::Client::builder()
    .user_agent("Felay-Updater")
    .timeout(Duration::from_secs(15))
    .build()
    .map_err(|e| e.to_string())?;

  let mut req = client.get("https://api.github.com/repos/zqq-nuli/Felay/releases/latest");

  // ETag conditional request — 304 responses don't count against rate limit
  if let Some(ref etag) = cached_etag {
    if !etag.is_empty() {
      req = req.header("If-None-Match", etag.as_str());
    }
  }

  let resp = req.send().await.map_err(|e| e.to_string())?;

  // 304 Not Modified — cached data is still valid
  if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
    return Ok(UpdateInfo {
      not_modified: true,
      etag: cached_etag.unwrap_or_default(),
      has_update: false,
      current_version: current.to_string(),
      latest_version: String::new(),
      release_url: String::new(),
      release_notes: String::new(),
    });
  }

  if !resp.status().is_success() {
    return Err(format!("GitHub API returned {}", resp.status()));
  }

  // Extract ETag from response headers before consuming the body
  let etag = resp
    .headers()
    .get("etag")
    .and_then(|v| v.to_str().ok())
    .unwrap_or("")
    .to_string();

  let json: Value = resp.json().await.map_err(|e| e.to_string())?;

  let tag = json["tag_name"].as_str().unwrap_or("v0.0.0");
  // tag_name is like "v0.1.0-beta" — extract the numeric version part
  let latest = tag
    .trim_start_matches('v')
    .split('-')
    .next()
    .unwrap_or("0.0.0");

  Ok(UpdateInfo {
    not_modified: false,
    etag,
    has_update: version_gt(latest, current),
    current_version: current.to_string(),
    latest_version: tag.to_string(),
    release_url: json["html_url"].as_str().unwrap_or("").to_string(),
    release_notes: json["body"].as_str().unwrap_or("").to_string(),
  })
}

#[tauri::command]
fn collect_logs(app: AppHandle) -> Result<String, String> {
  let home = get_home_dir().ok_or("Cannot determine home directory")?;
  let felay_dir = PathBuf::from(&home).join(".felay");

  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs();
  let default_name = format!("felay-logs-{}.zip", now);

  // Show native save-file dialog
  let save_path = app
    .dialog()
    .file()
    .set_file_name(&default_name)
    .add_filter("ZIP", &["zip"])
    .blocking_save_file()
    .ok_or("User cancelled")?;

  let save_path = save_path
    .into_path()
    .map_err(|_| "Invalid save path".to_string())?;

  let file =
    fs::File::create(&save_path).map_err(|e| format!("Cannot create file: {}", e))?;
  let mut zip = ZipWriter::new(file);
  let options =
    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

  // Collect log files
  for name in ["daemon.json", "proxy-debug.log", "proxy-hook-debug.log"] {
    let path = felay_dir.join(name);
    if path.exists() {
      if let Ok(content) = fs::read(&path) {
        zip
          .start_file(name, options)
          .map_err(|e| format!("zip start_file '{}': {}", name, e))?;
        zip
          .write_all(&content)
          .map_err(|e| format!("zip write '{}': {}", name, e))?;
      }
    }
  }

  // Sanitized config.json (sensitive fields replaced with ***)
  let config_path = felay_dir.join("config.json");
  if config_path.exists() {
    if let Ok(raw) = fs::read_to_string(&config_path) {
      let sanitized = sanitize_config(&raw);
      zip
        .start_file("config-sanitized.json", options)
        .map_err(|e| format!("zip start_file config: {}", e))?;
      zip
        .write_all(sanitized.as_bytes())
        .map_err(|e| format!("zip write config: {}", e))?;
    }
  }

  // System information
  let sysinfo = format!(
    "App Version: {}\nOS: {}\nArch: {}\nDaemon Lock Exists: {}\nTimestamp: {}",
    env!("CARGO_PKG_VERSION"),
    std::env::consts::OS,
    std::env::consts::ARCH,
    felay_dir.join("daemon.json").exists(),
    now,
  );
  zip
    .start_file("system-info.txt", options)
    .map_err(|e| format!("zip start_file sysinfo: {}", e))?;
  zip
    .write_all(sysinfo.as_bytes())
    .map_err(|e| format!("zip write sysinfo: {}", e))?;

  zip
    .finish()
    .map_err(|e| format!("Failed to finalize zip: {}", e))?;

  Ok(save_path.to_string_lossy().to_string())
}

#[tauri::command]
fn open_url(url: String) -> Value {
  // Validate URL scheme to prevent command injection
  if !url.starts_with("https://") && !url.starts_with("http://") {
    return serde_json::json!({ "ok": false, "error": "URL must start with http:// or https://" });
  }

  let result = {
    #[cfg(target_os = "windows")]
    {
      std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn()
    }
    #[cfg(target_os = "macos")]
    {
      std::process::Command::new("open").arg(&url).spawn()
    }
    #[cfg(target_os = "linux")]
    {
      std::process::Command::new("xdg-open").arg(&url).spawn()
    }
  };

  match result {
    Ok(_) => serde_json::json!({ "ok": true }),
    Err(e) => serde_json::json!({ "ok": false, "error": format!("{}", e) }),
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
      activate_bot,
      get_config,
      save_config,
      start_daemon,
      check_codex_config,
      setup_codex_config,
      open_codex_config_file,
      check_claude_config,
      setup_claude_config,
      open_claude_config_file,
      check_update,
      collect_logs,
      open_url,
    ])
    .plugin(tauri_plugin_dialog::init())
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

      let tray = app.tray_by_id("main").expect("tray icon 'main' not found");
      tray.set_menu(Some(menu))?;
      tray.on_menu_event(|app, event| match event.id.as_ref() {
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
      });
      tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
          button: MouseButton::Left,
          button_state: MouseButtonState::Up,
          ..
        } = event
        {
          show_main_window(tray.app_handle());
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
