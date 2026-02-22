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
} from "@felay/shared";
import { connectDaemon, daemonStatus, daemonStop } from "./daemonClient.js";
import { ensureDaemonRunning, getLiveDaemonIpc } from "./daemonLifecycle.js";

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

  const first = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return first || cli;
}

async function runCli(cli: string, args: string[]): Promise<void> {
  const sessionId = nanoid(10);
  const cwd = process.cwd();
  const startedAt = new Date().toISOString();

  await ensureDaemonRunning();

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

  const ptyProcess = pty.spawn(resolvedCli, spawnArgs, {
    name: "xterm-color",
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd,
    env: Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] != null)
    ),
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
      payload: { sessionId, cli, args, cwd, pid: process.pid, startedAt },
    };
    socket.write(toJsonLine(register));
  }

  function setupSocket(socket: net.Socket): void {
    daemonSocket = socket;
    connected = true;
    reconnecting = false;

    registerSession(socket);

    let socketBuffer = "";
    socket.on("data", (buf: Buffer) => {
      socketBuffer += buf.toString("utf8");
      const lines = socketBuffer.split("\n");
      socketBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { type?: string; payload?: { text?: string } };
          if (parsed.type === "feishu_input" && parsed.payload?.text) {
            ptyProcess.write(parsed.payload.text);
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
  .allowUnknownOption(true)
  .action(async (cli: string, args: string[] = []) => {
    await runCli(cli, args);
  });

const daemon = program.command("daemon").description("Manage local daemon process");
daemon.command("start").action(async () => daemonStart());
daemon.command("status").action(async () => daemonStatusCommand());
daemon.command("stop").action(async () => daemonStopCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error("[felay] fatal:", err);
  process.exit(1);
});
