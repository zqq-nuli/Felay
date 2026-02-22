import os from "node:os";

const WINDOWS_PIPE = "\\\\.\\pipe\\feishu-cli";
const UNIX_SOCKET = `${os.homedir()}/.feishu-cli/daemon.sock`;

export function getIpcPath(): string {
  return process.platform === "win32" ? WINDOWS_PIPE : UNIX_SOCKET;
}
