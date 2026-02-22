import os from "node:os";

const WINDOWS_PIPE = "\\\\.\\pipe\\felay";
const UNIX_SOCKET = `${os.homedir()}/.felay/daemon.sock`;

export function getIpcPath(): string {
  return process.platform === "win32" ? WINDOWS_PIPE : UNIX_SOCKET;
}
