#!/usr/bin/env node
import { program } from "commander";
import pty from "node-pty";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { nanoid } from "nanoid";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  toJsonLine,
  type SessionRegistration,
  type PtyOutputEvent,
  type SessionEndedEvent,
  type ApiProxyEvent,
} from "@felay/shared";
import { connectDaemon, requestDaemon, daemonStatus, daemonStop } from "./daemonClient.js";
import { ensureDaemonRunning, getLiveDaemonIpc } from "./daemonLifecycle.js";
import { startApiProxy, getProxyEnvConfig, resolveUpstream, writeHttpHook } from "./apiProxy.js";
import type { CheckCodexConfigResponse, SetupCodexConfigResponse, CheckClaudeConfigResponse, SetupClaudeConfigResponse } from "@felay/shared";

/**
 * Resolve a CLI name to an absolute path on Windows.
 *
 * conpty's C++ layer uses Windows SearchPath API which behaves unpredictably
 * inside pkg snapshot environments. We MUST always return an absolute path
 * so conpty never has to search for anything itself.
 *
 * Strategy (first match wins):
 *   1. Already absolute / contains path separators → return as-is
 *   2. `where` command → returns absolute paths from system PATH
 *   3. Manual PATH + PATHEXT scan → handles cases where `where` fails in pkg
 *   4. All failed → return bare name (pre-flight check will catch this)
 */
function resolveWindowsCli(cli: string): string {
  if (process.platform !== "win32") {
    return cli;
  }

  // Already a path (absolute or relative with separators) — trust it
  if (path.isAbsolute(cli) || cli.includes("\\") || cli.includes("/")) {
    return cli;
  }

  // Try `where` first — most reliable when it works
  const lookup = spawnSync("where", [cli], {
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });

  if (lookup.status === 0) {
    const lines = lookup.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Prefer .cmd/.exe over extensionless POSIX shell scripts
    const preferred = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l));
    if (preferred || lines[0]) return preferred || lines[0];
  }

  // Fallback: manually search PATH with PATHEXT extensions.
  // This handles cases where `where` fails inside pkg binaries.
  const pathExts = (process.env.PATHEXT || ".CMD;.EXE;.BAT;.COM")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  const pathDirs = (process.env.PATH || "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);

  for (const ext of pathExts) {
    for (const dir of pathDirs) {
      const full = path.join(dir, cli + ext);
      if (fs.existsSync(full)) return full;
    }
  }

  // All resolution failed — return bare name, pre-flight check will abort
  return cli;
}

function isCodexCli(cli: string): boolean {
  const base = cli.replace(/\\/g, "/").split("/").pop() || "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return name === "codex";
}

function isClaudeCli(cli: string): boolean {
  const base = cli.replace(/\\/g, "/").split("/").pop() || "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return name === "claude";
}

async function ensureCodexNotifyHook(): Promise<void> {
  try {
    const check = await requestDaemon<CheckCodexConfigResponse>({ type: "check_codex_config_request" });
    if (!check.payload.codexInstalled || check.payload.notifyConfigured) return;

    const setup = await requestDaemon<SetupCodexConfigResponse>({ type: "setup_codex_config_request" });
    if (setup.payload.ok) {
      process.stderr.write("[felay] Codex notify hook 已自动配置\n");
    } else {
      process.stderr.write(
        `[felay] Codex notify hook 配置失败: ${setup.payload.error ?? "unknown"}\n` +
        "[felay] 飞书将无法接收 Codex 的 AI 回复。请在 ~/.codex/config.toml 中手动添加:\n" +
        `[felay]   notify = ["node", "${check.payload.felayScriptPath}"]\n`
      );
    }
  } catch {
    // Daemon not reachable — skip silently, main connection will handle it
  }
}

async function ensureClaudeHook(): Promise<void> {
  try {
    const check = await requestDaemon<CheckClaudeConfigResponse>({ type: "check_claude_config_request" });
    if (!check.payload.claudeInstalled || check.payload.hookConfigured) return;

    const setup = await requestDaemon<SetupClaudeConfigResponse>({ type: "setup_claude_config_request" });
    if (setup.payload.ok) {
      process.stderr.write("[felay] Claude Code Stop hook 已自动配置\n");
    } else {
      process.stderr.write(
        `[felay] Claude Code hook 配置失败: ${setup.payload.error ?? "unknown"}\n` +
        "[felay] 飞书将无法接收 Claude Code 的 AI 回复。请在 ~/.claude/settings.json 中手动添加 hooks 配置\n"
      );
    }
  } catch {
    // Daemon not reachable — skip silently
  }
}

async function runCli(cli: string, args: string[], proxyMode: boolean = false): Promise<void> {
  const sessionId = nanoid(10);
  const cwd = process.cwd();
  const startedAt = new Date().toISOString();

  process.stderr.write(`[felay] mode: ${proxyMode ? "proxy" : "pty"}\n`);
  process.stderr.write(`[felay] ensuring daemon is running...\n`);
  await ensureDaemonRunning();
  process.stderr.write(`[felay] daemon ready\n`);

  // Auto-configure CLI-specific hooks (skip in proxy mode — proxy handles output)
  if (!proxyMode) {
    if (isCodexCli(cli)) {
      await ensureCodexNotifyHook();
    }
    if (isClaudeCli(cli)) {
      await ensureClaudeHook();
    }
  }

  // ── API proxy setup ──
  let proxyServer: { port: number; close: () => Promise<void> } | null = null;
  const proxyEnv: Record<string, string> = {};
  // Shared mutable reference for proxy → daemon socket forwarding.
  // The proxy's onMessage callback reads from this; setupSocket/handleDisconnect mutate it.
  const proxyDaemonRef: { socket: net.Socket | null; connected: boolean } = { socket: null, connected: false };

  if (proxyMode) {
    process.stderr.write(`[felay] setting up API proxy...\n`);
    const envConfig = getProxyEnvConfig(cli);
    if (!envConfig) {
      process.stderr.write(`[felay] API proxy mode is not supported for "${cli}" (only claude, codex, and gemini are supported)\n`);
      process.exit(1);
    }

    // Resolve the actual upstream URL (checks settings.json, env, default)
    const originalUpstream = resolveUpstream(envConfig.envVar, envConfig.defaultUpstream, cli);
    process.stderr.write(`[felay] proxy: ${envConfig.provider} → ${originalUpstream}\n`);

    // Debug logging to file (TUI overwrites stderr)
    const proxyLogFile = path.join(os.homedir(), ".felay", "proxy-debug.log");
    const plog = (m: string) => { try { fs.appendFileSync(proxyLogFile, `[${new Date().toISOString()}] ${m}\n`); } catch {} };

    plog(`proxy starting: envVar=${envConfig.envVar} upstream=${originalUpstream} provider=${envConfig.provider}`);

    proxyServer = await startApiProxy(
      { upstreamBaseUrl: originalUpstream, provider: envConfig.provider },
      (msg) => {
        plog(`onMessage: socketOk=${!!proxyDaemonRef.socket} connected=${proxyDaemonRef.connected} model=${msg.model} stopReason=${msg.stopReason} textLen=${msg.textContent.length} suggestion=${msg.isSuggestion}`);
        if (proxyDaemonRef.socket && proxyDaemonRef.connected) {
          const event: ApiProxyEvent = {
            type: "api_proxy_event",
            payload: { sessionId, ...msg },
          };
          try {
            proxyDaemonRef.socket.write(toJsonLine(event));
            plog(`sent api_proxy_event to daemon`);
          } catch (err) {
            plog(`failed to send event: ${err}`);
          }
        } else {
          plog(`daemon socket not connected, dropping event`);
        }
      }
    );

    const proxyUrl = `http://127.0.0.1:${proxyServer.port}`;
    process.stderr.write(`[felay] proxy ready on :${proxyServer.port}\n`);
    plog(`proxy ready on port ${proxyServer.port} → ${originalUpstream}`);

    // Set env var override (works for CLIs that respect env vars)
    proxyEnv[envConfig.envVar] = proxyUrl;

    if (envConfig.provider === "anthropic" || envConfig.provider === "google") {
      // Node.js CLIs (Claude Code, Gemini CLI): use NODE_OPTIONS hook
      // to monkey-patch fetch/http.request and redirect to local proxy.
      const hookPath = writeHttpHook(proxyUrl, originalUpstream);
      const existingNodeOptions = process.env.NODE_OPTIONS || "";
      proxyEnv.NODE_OPTIONS = `--require ${JSON.stringify(hookPath)}${existingNodeOptions ? " " + existingNodeOptions : ""}`;
      plog(`NODE_OPTIONS=${proxyEnv.NODE_OPTIONS}`);
    } else {
      // Codex is a native Rust binary — NODE_OPTIONS hook is useless.
      // Use HTTP_PROXY to intercept all HTTP requests from the native binary.
      proxyEnv.HTTP_PROXY = proxyUrl;
      proxyEnv.HTTPS_PROXY = proxyUrl;
      proxyEnv.http_proxy = proxyUrl;
      proxyEnv.https_proxy = proxyUrl;
      plog(`native binary mode: HTTP_PROXY=${proxyUrl} upstream=${originalUpstream}`);
    }
  }

  let resolvedCli = resolveWindowsCli(cli);
  let spawnArgs = args;

  process.stderr.write(`[felay] resolve: "${cli}" → "${resolvedCli}"\n`);

  if (process.platform === "win32") {
    // On Windows, .cmd/.bat files cannot be executed directly by node-pty;
    // they must be launched through cmd.exe /c.
    // Use ComSpec full path because conpty's C++ layer cannot resolve bare
    // "cmd.exe" inside a pkg snapshot environment.
    if (/\.(cmd|bat)$/i.test(resolvedCli)) {
      const comspec = process.env.ComSpec || "C:\\Windows\\system32\\cmd.exe";
      spawnArgs = ["/c", resolvedCli, ...args];
      resolvedCli = comspec;
    }

    // Pre-flight: every path passed to pty.spawn() MUST be absolute.
    // conpty's C++ SearchPath cannot resolve bare names in pkg snapshots.
    if (!path.isAbsolute(resolvedCli)) {
      const msg = [
        `[felay] fatal: '${cli}' could not be resolved to an absolute path.`,
        `  resolved: ${resolvedCli}`,
        `  PATHEXT: ${process.env.PATHEXT || "(not set)"}`,
        `  PATH dirs searched: ${(process.env.PATH || "").split(";").length}`,
        `  Ensure '${cli}' is installed and available in your PATH.`,
      ].join("\n");
      process.stderr.write(msg + "\n");
      process.exit(1);
    }

    // Verify the file actually exists on disk
    if (!fs.existsSync(resolvedCli)) {
      const msg = [
        `[felay] fatal: '${cli}' resolved to '${resolvedCli}' but the file does not exist.`,
        `  This may indicate a broken installation or stale PATH entry.`,
      ].join("\n");
      process.stderr.write(msg + "\n");
      process.exit(1);
    }
  }

  process.stderr.write(`[felay] spawn: ${resolvedCli} ${JSON.stringify(spawnArgs)}\n`);

  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)
  );

  const ptyProcess = pty.spawn(resolvedCli, spawnArgs, {
    name: "xterm-color",
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd,
    env: { ...baseEnv, ...proxyEnv },
  });

  // ── Connection state (PTY lifecycle is independent of daemon socket) ──
  let daemonSocket: net.Socket | null = null;
  let connected = false;
  let sessionEnded = false;
  let reconnecting = false;

  const reconnectConfig = {
    maxRetries: 3,
    initialInterval: 5000,
    backoffMultiplier: 2,
  };

  function registerSession(socket: net.Socket): void {
    const register: SessionRegistration = {
      type: "register_session",
      payload: { sessionId, cli, args, cwd, pid: process.pid, startedAt, proxyMode: proxyMode || undefined },
    };
    socket.write(toJsonLine(register));
  }

  function setupSocket(socket: net.Socket): void {
    daemonSocket = socket;
    connected = true;
    reconnecting = false;

    // Update shared proxy daemon reference
    proxyDaemonRef.socket = socket;
    proxyDaemonRef.connected = true;

    registerSession(socket);

    let socketBuffer = "";
    socket.on("data", (buf: Buffer) => {
      socketBuffer += buf.toString("utf8");
      const lines = socketBuffer.split("\n");
      socketBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { type?: string; payload?: { text?: string; enterRetryCount?: number; enterRetryInterval?: number; images?: string[] } };
          if (parsed.type === "feishu_input" && (parsed.payload?.text || parsed.payload?.images?.length)) {
            // Simulate character-by-character typing to avoid Codex
            // PasteBurst detection, then retry Enter a few times.
            // Workaround for Windows ConPTY bug (microsoft/terminal#19674)
            // where \r stops being translated to VK_RETURN after TUI apps
            // switch console modes.
            const text = parsed.payload.text ?? "";
            const retryCount = parsed.payload?.enterRetryCount ?? 2;
            const retryInterval = parsed.payload?.enterRetryInterval ?? 500;
            const images = parsed.payload.images;

            // Image-only message: paste paths into input box, no Enter
            if (images && images.length > 0) {
              const pasteImages = (idx: number) => {
                if (idx >= images.length) return;
                ptyProcess.write(images[idx] + " ");
                if (idx + 1 < images.length) {
                  setTimeout(() => pasteImages(idx + 1), 100);
                }
              };
              pasteImages(0);
              // If no text, we're done (just pasting images into input box)
              if (!text.trim()) return;
              // If there is text too, wait for images to settle then type it
              // (This shouldn't normally happen with the new flow)
            }

            // Text message: type character-by-character + Enter retries
            if (text.trim()) {
              const chars = [...text];
              let i = 0;
              const typeNext = () => {
                if (i < chars.length) {
                  ptyProcess.write(chars[i]);
                  i++;
                  setTimeout(typeNext, 10);
                } else {
                  for (let r = 1; r <= retryCount; r++) {
                    setTimeout(() => ptyProcess.write("\r"), retryInterval * r);
                  }
                }
              };
              typeNext();
            }
          }
        } catch {
          // ignore malformed payload
        }
      }
    });

    socket.on("error", (err: Error) => {
      process.stderr.write(`[felay] daemon connection error: ${err.message}\n`);
      handleDisconnect();
    });

    socket.on("close", () => {
      if (!sessionEnded) {
        handleDisconnect();
      }
    });
  }

  function handleDisconnect(): void {
    if (!connected || reconnecting) return;
    connected = false;
    daemonSocket = null;

    // Clear proxy daemon socket reference
    proxyDaemonRef.socket = null;
    proxyDaemonRef.connected = false;

    if (sessionEnded) return;

    process.stderr.write("[felay] daemon connection lost. PTY continues locally.\n");
    attemptReconnect(0);
  }

  function attemptReconnect(attempt: number): void {
    if (sessionEnded || connected) return;
    reconnecting = true;

    if (attempt >= reconnectConfig.maxRetries) {
      process.stderr.write(
        `[felay] reconnection failed after ${reconnectConfig.maxRetries} attempts. Feishu bridging disabled.\n`
      );
      reconnecting = false;
      return;
    }

    const delay =
      reconnectConfig.initialInterval *
      Math.pow(reconnectConfig.backoffMultiplier, attempt);

    setTimeout(async () => {
      if (sessionEnded || connected) {
        reconnecting = false;
        return;
      }

      try {
        const ipc = await getLiveDaemonIpc();
        if (!ipc) {
          process.stderr.write(
            `[felay] daemon not available, retry ${attempt + 1}/${reconnectConfig.maxRetries}\n`
          );
          attemptReconnect(attempt + 1);
          return;
        }
        const socket = await connectDaemon(ipc);
        process.stderr.write("[felay] reconnected to daemon\n");
        setupSocket(socket);
      } catch {
        process.stderr.write(
          `[felay] reconnect attempt ${attempt + 1}/${reconnectConfig.maxRetries} failed\n`
        );
        attemptReconnect(attempt + 1);
      }
    }, delay);
  }

  // ── Initial connection ──
  try {
    const ipc = await getLiveDaemonIpc();
    const socket = await connectDaemon(ipc ?? undefined);
    setupSocket(socket);
  } catch {
    process.stderr.write(
      "[felay] daemon unavailable. PTY running without Feishu bridging.\n"
    );
    attemptReconnect(0);
  }

  // ── PTY output → local terminal + daemon ──
  ptyProcess.onData((chunk) => {
    process.stdout.write(chunk);

    if (daemonSocket && connected) {
      const event: PtyOutputEvent = {
        type: "pty_output",
        payload: {
          sessionId,
          chunk,
          stream: "stdout",
          at: new Date().toISOString(),
        },
      };
      try {
        daemonSocket.write(toJsonLine(event));
      } catch {
        // Socket may have broken between the check and write
      }
    }
  });

  // ── User stdin → PTY ──
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    ptyProcess.write(data.toString("utf8"));
  });

  // ── PTY exit → session end ──
  ptyProcess.onExit(() => {
    sessionEnded = true;
    if (daemonSocket && connected) {
      const ended: SessionEndedEvent = {
        type: "session_ended",
        payload: { sessionId, at: new Date().toISOString() },
      };
      try {
        daemonSocket.write(toJsonLine(ended));
        daemonSocket.end();
      } catch {
        // best-effort
      }
    }
    if (proxyServer) {
      proxyServer.close().catch(() => {});
    }
    process.exit(0);
  });
}

async function daemonStart(): Promise<void> {
  await ensureDaemonRunning();
  const status = await daemonStatus();
  console.log(
    `[felay] daemon running pid=${status.payload.daemonPid} sessions=${status.payload.activeSessions}`
  );
}

async function daemonStatusCommand(): Promise<void> {
  try {
    const status = await daemonStatus();
    console.log(
      `[felay] daemon running pid=${status.payload.daemonPid} sessions=${status.payload.activeSessions}`
    );
    return;
  } catch {
    // fallback to lock-based check for better diagnostics
  }

  const ipc = await getLiveDaemonIpc();
  if (!ipc) {
    console.log("[felay] daemon not running");
    return;
  }

  console.log("[felay] daemon pid exists but not reachable");
}

async function daemonStopCommand(): Promise<void> {
  try {
    await daemonStop();
    console.log("[felay] daemon stopped");
    return;
  } catch {
    // fallback to lock-based check
  }

  const ipc = await getLiveDaemonIpc();
  if (!ipc) {
    console.log("[felay] daemon not running");
    return;
  }

  console.log("[felay] failed to stop daemon");
  process.exit(1);
}

// pkg embeds package.json in snapshot — read version at runtime
function getVersion(): string {
  try {
    // Try reading from the package.json (works in dev and pkg)
    const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")), "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "unknown";
  } catch {
    return "0.1.24";
  }
}

async function diagnoseCommand(): Promise<void> {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);

  log("=== Felay Diagnostics ===");
  log(`version:    ${getVersion()}`);
  log(`platform:   ${process.platform} ${process.arch}`);
  log(`node:       ${process.version}`);
  log(`os:         ${os.type()} ${os.release()}`);
  log(`cwd:        ${process.cwd()}`);
  log(`homedir:    ${os.homedir()}`);
  log(`ComSpec:    ${process.env.ComSpec ?? "(not set)"}`);
  log(`SystemRoot: ${process.env.SystemRoot ?? "(not set)"}`);
  log(`PATHEXT:    ${process.env.PATHEXT ?? "(not set)"}`);
  log(`shell:      ${process.env.SHELL ?? process.env.COMSPEC ?? "(not set)"}`);

  // PATH dirs
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  log(`PATH dirs:  ${pathDirs.length}`);

  // Check key executables
  log("");
  log("=== CLI Resolution ===");
  for (const cli of ["codex", "claude", "gemini"]) {
    const where = spawnSync("where", [cli], { encoding: "utf8", shell: true, windowsHide: true });
    if (where.status === 0) {
      const found = where.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      log(`${cli}: ${found[0]}${found.length > 1 ? ` (+${found.length - 1} more)` : ""}`);
    } else {
      log(`${cli}: NOT FOUND`);
    }
  }

  // Daemon status
  log("");
  log("=== Daemon ===");
  const lockPath = path.join(os.homedir(), ".felay", "daemon.json");
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    log(`lock file:  ${lockPath}`);
    log(`daemon pid: ${lock.pid}`);
    log(`ipc:        ${lock.ipc}`);

    // Check if daemon is alive
    try {
      const status = await daemonStatus();
      log(`status:     running (sessions=${status.payload.activeSessions})`);
    } catch {
      log(`status:     lock exists but daemon not reachable`);
    }
  } catch {
    log(`lock file:  not found`);
    log(`status:     not running`);
  }

  // Config
  log("");
  log("=== Config ===");
  const configPath = path.join(os.homedir(), ".felay", "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const botCount = config.bots?.length ?? 0;
    log(`config:     ${configPath} (${botCount} bots)`);
  } catch {
    log(`config:     not found`);
  }

  // node-pty native module
  log("");
  log("=== node-pty ===");
  try {
    // Check if pty module loaded successfully (it already imported at top)
    log(`module:     loaded OK`);
    if (process.platform === "win32") {
      // Check for conpty files
      const exeDir = path.dirname(process.execPath);
      const prebuildsDir = path.join(exeDir, "prebuilds", "win32-x64");
      const conptyDir = path.join(prebuildsDir, "conpty");
      log(`exec path:  ${process.execPath}`);
      log(`prebuilds:  ${fs.existsSync(prebuildsDir) ? "OK" : "MISSING"} (${prebuildsDir})`);
      for (const f of ["pty.node", "conpty.node"]) {
        const fp = path.join(prebuildsDir, f);
        log(`  ${f}: ${fs.existsSync(fp) ? "OK" : "MISSING"}`);
      }
      for (const f of ["conpty.dll", "OpenConsole.exe"]) {
        const fp = path.join(conptyDir, f);
        log(`  conpty/${f}: ${fs.existsSync(fp) ? "OK" : "MISSING"}`);
      }
    }
  } catch (e: any) {
    log(`module:     FAILED (${e.message})`);
  }

  // pkg snapshot detection
  log("");
  log("=== Runtime ===");
  const inSnapshot = process.execPath.includes("\\snapshot\\") || process.execPath.includes("/snapshot/");
  log(`pkg binary: ${inSnapshot ? "yes" : "no (dev mode)"}`);
  log(`execPath:   ${process.execPath}`);

  console.log(lines.join("\n"));
}

program
  .name("felay")
  .version(getVersion(), "-v, --version")
  .description("Felay — Feishu CLI Proxy");

program
  .command("run <cli> [args...]")
  .description("Run CLI in PTY and bridge to daemon")
  .option("--pty", "Use PTY output parsing instead of API proxy (fallback mode)")
  .allowUnknownOption(true)
  .action(async (cli: string, args: string[] = [], opts: { pty?: boolean }) => {
    await runCli(cli, args, !(opts.pty ?? false));
  });

program
  .command("diagnose")
  .description("Print diagnostic info for troubleshooting")
  .action(async () => diagnoseCommand());

const daemon = program.command("daemon").description("Manage local daemon process");
daemon.command("start").action(async () => daemonStart());
daemon.command("status").action(async () => daemonStatusCommand());
daemon.command("stop").action(async () => daemonStopCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error("[felay] fatal:", err);
  process.exit(1);
});
