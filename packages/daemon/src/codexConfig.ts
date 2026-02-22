import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CODEX_DIR, "config.toml");

/** Resolve the absolute path to felay-notify.js. */
function resolveNotifyScript(): string {
  // In ESM, __dirname is not available — derive from import.meta.url
  const thisFile = fileURLToPath(import.meta.url);
  const daemonDir = path.dirname(thisFile);

  // Development layout:  packages/daemon/dist/codexConfig.js  →  scripts/felay-notify.js
  const devCandidate = path.resolve(daemonDir, "..", "..", "..", "scripts", "felay-notify.js");
  if (fs.existsSync(devCandidate)) {
    return devCandidate;
  }

  // Production layout (pkg / NSIS install):  felay-notify.js next to daemon exe
  const prodCandidate = path.resolve(daemonDir, "felay-notify.js");
  if (fs.existsSync(prodCandidate)) {
    return prodCandidate;
  }

  // Also check next to process.execPath (for pkg binaries)
  const execDirCandidate = path.join(path.dirname(process.execPath), "felay-notify.js");
  if (fs.existsSync(execDirCandidate)) {
    return execDirCandidate;
  }

  // Fallback — return dev path even if not found yet
  return devCandidate;
}

/** Normalize path separators to forward slashes for TOML compatibility. */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface CodexConfigStatus {
  codexInstalled: boolean;
  configExists: boolean;
  notifyConfigured: boolean;
  currentNotify?: string;
  felayScriptPath: string;
  configFilePath: string;
}

/** Check if the Codex notify hook is configured to point to felay. */
export function checkCodexConfig(): CodexConfigStatus {
  const felayScriptPath = toForwardSlash(resolveNotifyScript());
  const configFilePath = toForwardSlash(CONFIG_PATH);

  const codexInstalled = fs.existsSync(CODEX_DIR);
  if (!codexInstalled) {
    return { codexInstalled: false, configExists: false, notifyConfigured: false, felayScriptPath, configFilePath };
  }

  const configExists = fs.existsSync(CONFIG_PATH);
  if (!configExists) {
    return { codexInstalled: true, configExists: false, notifyConfigured: false, felayScriptPath, configFilePath };
  }

  let content: string;
  try {
    content = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return { codexInstalled: true, configExists: false, notifyConfigured: false, felayScriptPath, configFilePath };
  }

  // Match notify = [...] line (could be single or multi-element array)
  const notifyMatch = content.match(/^notify\s*=\s*(.+)$/m);
  if (!notifyMatch) {
    return { codexInstalled: true, configExists: true, notifyConfigured: false, felayScriptPath, configFilePath };
  }

  const currentNotify = notifyMatch[1].trim();
  const notifyConfigured = currentNotify.includes("felay-notify");

  return { codexInstalled: true, configExists: true, notifyConfigured, currentNotify, felayScriptPath, configFilePath };
}

/** Configure the Codex notify hook to point to felay-notify.js. */
export function setupCodexConfig(): { ok: boolean; error?: string } {
  const status = checkCodexConfig();

  if (!status.codexInstalled) {
    return { ok: false, error: "Codex 未安装（~/.codex/ 目录不存在）" };
  }

  if (status.notifyConfigured) {
    return { ok: true };
  }

  // Verify the script file actually exists
  const scriptPath = resolveNotifyScript();
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `felay-notify.js 不存在: ${scriptPath}` };
  }

  const notifyLine = `notify = ["node", "${toForwardSlash(scriptPath)}"]`;

  let content: string;
  try {
    content = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : "";
  } catch (err) {
    return { ok: false, error: `无法读取 config.toml: ${err}` };
  }

  let newContent: string;

  // Check if notify line already exists (pointing to something else)
  const notifyRegex = /^notify\s*=\s*.+$/m;
  if (notifyRegex.test(content)) {
    // Replace existing notify line
    newContent = content.replace(notifyRegex, notifyLine);
  } else {
    // Insert before the first [table] section (TOML requirement: top-level keys before tables)
    const lines = content.split("\n");
    const tableIndex = lines.findIndex((line) => /^\s*\[/.test(line));

    if (tableIndex === -1) {
      // No table sections — append at end
      newContent = content.trimEnd() + (content.trim() ? "\n" : "") + notifyLine + "\n";
    } else {
      // Insert before first table, with a blank line separator
      lines.splice(tableIndex, 0, notifyLine, "");
      newContent = lines.join("\n");
    }
  }

  try {
    fs.writeFileSync(CONFIG_PATH, newContent, "utf8");
  } catch (err) {
    return { ok: false, error: `无法写入 config.toml: ${err}` };
  }

  return { ok: true };
}
