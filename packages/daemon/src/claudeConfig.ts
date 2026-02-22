import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");

/** Resolve the absolute path to felay-claude-hook.js. */
function resolveHookScript(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const daemonDir = path.dirname(thisFile);

  // Development layout: packages/daemon/dist/claudeConfig.js → scripts/felay-claude-hook.js
  const devCandidate = path.resolve(daemonDir, "..", "..", "..", "scripts", "felay-claude-hook.js");
  if (fs.existsSync(devCandidate)) {
    return devCandidate;
  }

  // Production layout (pkg / NSIS install): felay-claude-hook.js next to daemon exe
  const prodCandidate = path.resolve(daemonDir, "felay-claude-hook.js");
  if (fs.existsSync(prodCandidate)) {
    return prodCandidate;
  }

  // Also check next to process.execPath (for pkg binaries)
  const execDirCandidate = path.join(path.dirname(process.execPath), "felay-claude-hook.js");
  if (fs.existsSync(execDirCandidate)) {
    return execDirCandidate;
  }

  return devCandidate;
}

/** Normalize path separators to forward slashes. */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface ClaudeConfigStatus {
  claudeInstalled: boolean;
  configExists: boolean;
  hookConfigured: boolean;
  currentHookCommand?: string;
  felayScriptPath: string;
  configFilePath: string;
}

/** Check if the Claude Code Stop hook is configured to point to felay. */
export function checkClaudeConfig(): ClaudeConfigStatus {
  const felayScriptPath = toForwardSlash(resolveHookScript());
  const configFilePath = toForwardSlash(SETTINGS_PATH);

  const claudeInstalled = fs.existsSync(CLAUDE_DIR);
  if (!claudeInstalled) {
    return { claudeInstalled: false, configExists: false, hookConfigured: false, felayScriptPath, configFilePath };
  }

  const configExists = fs.existsSync(SETTINGS_PATH);
  if (!configExists) {
    return { claudeInstalled: true, configExists: false, hookConfigured: false, felayScriptPath, configFilePath };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return { claudeInstalled: true, configExists: false, hookConfigured: false, felayScriptPath, configFilePath };
  }

  // Navigate: settings.hooks.Stop[*].hooks[*].command
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || !Array.isArray(hooks.Stop)) {
    return { claudeInstalled: true, configExists: true, hookConfigured: false, felayScriptPath, configFilePath };
  }

  for (const group of hooks.Stop) {
    const g = group as { hooks?: Array<{ command?: string }> };
    if (!Array.isArray(g.hooks)) continue;
    for (const hook of g.hooks) {
      if (hook.command && hook.command.includes("felay-claude-hook")) {
        return {
          claudeInstalled: true,
          configExists: true,
          hookConfigured: true,
          currentHookCommand: hook.command,
          felayScriptPath,
          configFilePath,
        };
      }
    }
  }

  // Collect first Stop hook command for display
  let currentHookCommand: string | undefined;
  for (const group of hooks.Stop) {
    const g = group as { hooks?: Array<{ command?: string }> };
    if (Array.isArray(g.hooks) && g.hooks.length > 0 && g.hooks[0].command) {
      currentHookCommand = g.hooks[0].command;
      break;
    }
  }

  return { claudeInstalled: true, configExists: true, hookConfigured: false, currentHookCommand, felayScriptPath, configFilePath };
}

/** Configure the Claude Code Stop hook to point to felay-claude-hook.js. */
export function setupClaudeConfig(): { ok: boolean; error?: string } {
  const status = checkClaudeConfig();

  if (!status.claudeInstalled) {
    return { ok: false, error: "Claude Code 未安装（~/.claude/ 目录不存在）" };
  }

  if (status.hookConfigured) {
    return { ok: true };
  }

  const scriptPath = resolveHookScript();
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `felay-claude-hook.js 不存在: ${scriptPath}` };
  }

  const hookCommand = `node ${toForwardSlash(scriptPath)}`;

  let settings: Record<string, unknown>;
  try {
    settings = fs.existsSync(SETTINGS_PATH)
      ? JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"))
      : {};
  } catch (err) {
    return { ok: false, error: `无法读取 settings.json: ${err}` };
  }

  // Build the Stop hook entry
  const felayHookGroup = {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: hookCommand,
        timeout: 30,
      },
    ],
  };

  // Ensure hooks.Stop exists and append our hook group
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown[]>;

  if (!Array.isArray(hooks.Stop)) {
    hooks.Stop = [];
  }

  // Don't duplicate — check if already present
  const alreadyPresent = hooks.Stop.some((group) => {
    const g = group as { hooks?: Array<{ command?: string }> };
    return Array.isArray(g.hooks) && g.hooks.some((h) => h.command?.includes("felay-claude-hook"));
  });

  if (!alreadyPresent) {
    hooks.Stop.push(felayHookGroup);
  }

  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    return { ok: false, error: `无法写入 settings.json: ${err}` };
  }

  return { ok: true };
}
