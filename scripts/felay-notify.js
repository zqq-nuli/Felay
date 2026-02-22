#!/usr/bin/env node
/**
 * Codex notify hook script.
 *
 * Codex calls this script on `agent-turn-complete` with a JSON payload as argv.
 * We forward it to the Felay daemon via IPC so the daemon can send the clean
 * `last-assistant-message` as a Feishu reply — no PTY output parsing needed.
 *
 * Usage in ~/.codex/config.toml:
 *   notify = ["node", "<path-to-this-script>/felay-notify.js"]
 */

const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");

const IPC_PIPE = "\\\\.\\pipe\\felay";
const IPC_SOCK = path.join(os.homedir(), ".felay", "daemon.sock");

function getIpcPath() {
  return process.platform === "win32" ? IPC_PIPE : IPC_SOCK;
}

function main() {
  // Codex appends JSON as the last argv element
  const jsonArg = process.argv[process.argv.length - 1];
  if (!jsonArg) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(jsonArg);
  } catch {
    // Not valid JSON — not a Codex notification
    process.exit(0);
  }

  // Only handle agent-turn-complete
  if (payload.type !== "agent-turn-complete") {
    process.exit(0);
  }

  const message = payload["last-assistant-message"];
  if (!message) {
    process.exit(0);
  }

  const ipcPath = getIpcPath();
  const ipcMessage = JSON.stringify({
    type: "codex_notify",
    payload: {
      cwd: payload.cwd || "",
      message: message,
      turnId: payload["turn-id"] || "",
      threadId: payload["thread-id"] || "",
    },
  }) + "\n";

  const socket = net.createConnection(ipcPath, () => {
    socket.write(ipcMessage, () => {
      socket.end();
    });
  });

  socket.on("error", () => {
    // Daemon not running or connection failed — silently exit
    process.exit(0);
  });

  socket.on("close", () => {
    process.exit(0);
  });

  // Timeout safety — don't hang
  setTimeout(() => {
    process.exit(0);
  }, 3000);
}

main();
