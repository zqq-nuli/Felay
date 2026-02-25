#!/usr/bin/env node
import { program } from "commander";
import pty from "node-pty";
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

function resolveWindowsCli(cli: string): string {
  if (process.platform !== "win32") {
    return cli;
  }

  if (path.isAbsolute(cli) || cli.includes("\\") || cli.includes("/")) {
    return cli;
  }

  const lookup = spawnSync("where", [cli], {
    encoding: "utf8",
    shell: true,
    windowsHide: true,
  });

  if (lookup.status !== 0) {
    return cli;
  }

  const lines = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Prefer .cmd/.exe over extensionless POSIX shell scripts
  const preferred = lines.find((l) => /\.(cmd|exe|bat)$/i.test(l));
  return preferred || lines[0] || cli;
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

  await ensureDaemonRunning();

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
    const envConfig = getProxyEnvConfig(cli);
    if (!envConfig) {
      process.stderr.write(`[felay] API proxy mode is not supported for "${cli}" (only claude and codex are supported)\n`);
      process.exit(1);
    }

    // Resolve the actual upstream URL (checks settings.json, env, default)
    const originalUpstream = resolveUpstream(envConfig.envVar, envConfig.defaultUpstream, cli);

    // Debug logging to file (TUI overwrites stderr)
    const fsSync = await import("node:fs");
    const pathMod = await import("node:path");
    const osMod = await import("node:os");
    const proxyLogFile = pathMod.default.join(osMod.default.homedir(), ".felay", "proxy-debug.log");
    const plog = (m: string) => { try { fsSync.default.appendFileSync(proxyLogFile, `[${new Date().toISOString()}] ${m}\n`); } catch {} };

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
    plog(`proxy ready on port ${proxyServer.port} → ${originalUpstream}`);

    // Set env var override (works for CLIs that respect env vars)
    proxyEnv[envConfig.envVar] = proxyUrl;

    if (envConfig.provider === "anthropic") {
      // Claude Code reads ANTHROPIC_BASE_URL from its own settings.json,
      // overriding process env vars (anthropics/claude-code#8500).
      // Use NODE_OPTIONS hook to monkey-patch fetch/http.request.
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

  // On Windows, .cmd/.bat files cannot be executed directly by node-pty;
  // they must be launched through cmd.exe /c
  if (
    process.platform === "win32" &&
    /\.(cmd|bat)$/i.test(resolvedCli)
  ) {
    spawnArgs = ["/c", resolvedCli, ...args];
    resolvedCli = "cmd.exe";
  }

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

program
  .name("felay")
  .description("Felay — Feishu CLI Proxy")
  .command("run <cli> [args...]")
  .description("Run CLI in PTY and bridge to daemon")
  .option("--proxy", "Enable API proxy mode for clean output capture")
  .allowUnknownOption(true)
  .action(async (cli: string, args: string[] = [], opts: { proxy?: boolean }) => {
    await runCli(cli, args, opts.proxy ?? false);
  });

const daemon = program.command("daemon").description("Manage local daemon process");
daemon.command("start").action(async () => daemonStart());
daemon.command("status").action(async () => daemonStatusCommand());
daemon.command("stop").action(async () => daemonStopCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error("[felay] fatal:", err);
  process.exit(1);
});
