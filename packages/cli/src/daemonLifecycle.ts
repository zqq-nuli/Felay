import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readLockFile, daemonStatus } from "./daemonClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "../../../");

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isDaemonReachable(): Promise<boolean> {
  try {
    await daemonStatus();
    return true;
  } catch {
    return false;
  }
}

export async function getLiveDaemonIpc(): Promise<string | null> {
  const lock = await readLockFile();
  if (!lock) return null;

  if (!isPidAlive(lock.pid)) {
    return null;
  }

  return lock.ipc;
}

export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonReachable()) return;

  const daemonEntry = path.resolve(workspaceRoot, "packages/daemon/src/index.ts");
  if (!fs.existsSync(daemonEntry)) {
    throw new Error("daemon entry not found");
  }

  const child: ChildProcess = spawn(
    "pnpm",
    ["--filter", "@felay/daemon", "dev"],
    {
      cwd: workspaceRoot,
      shell: process.platform === "win32",
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }
  );

  child.unref();

  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await isDaemonReachable()) return;
  }

  throw new Error("daemon start timeout");
}
