import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  type DaemonReply,
  type DaemonLockFile,
  type StatusResponse,
  type StopResponse,
} from "@feishu-cli/shared";

const WINDOWS_PIPE = "\\\\.\\pipe\\feishu-cli";
const UNIX_SOCKET = `${os.homedir()}/.feishu-cli/daemon.sock`;

export function getIpcPath(): string {
  return process.platform === "win32" ? WINDOWS_PIPE : UNIX_SOCKET;
}

export function getLockFilePath(): string {
  return path.join(os.homedir(), ".feishu-cli", "daemon.json");
}

export async function readLockFile(): Promise<DaemonLockFile | null> {
  const lockPath = getLockFilePath();
  if (!fs.existsSync(lockPath)) {
    return null;
  }

  try {
    const text = await fs.promises.readFile(lockPath, "utf8");
    return JSON.parse(text) as DaemonLockFile;
  } catch {
    return null;
  }
}

export function connectDaemon(ipcPath = getIpcPath()): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ipcPath);

    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    const onError = (err: Error) => {
      socket.removeListener("connect", onConnect);
      reject(err);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export async function requestDaemon<T extends DaemonReply>(
  message: unknown,
  ipcPath?: string
): Promise<T> {
  const socket = await connectDaemon(ipcPath);

  return await new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        socket.destroy();
        reject(new Error("daemon request timed out"));
      });
    }, 10_000);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as T;
        settle(() => {
          socket.end();
          resolve(parsed);
        });
      } catch (error) {
        settle(() => reject(error));
      }
    });

    socket.on("error", (error) => settle(() => reject(error)));
    socket.on("close", () => settle(() => reject(new Error("daemon connection closed"))));

    socket.write(`${JSON.stringify(message)}\n`);
  });
}

export async function daemonStatus(): Promise<StatusResponse> {
  return requestDaemon<StatusResponse>({ type: "status_request" });
}

export async function daemonStop(): Promise<StopResponse> {
  return requestDaemon<StopResponse>({ type: "stop_request" });
}
