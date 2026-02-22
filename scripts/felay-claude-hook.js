#!/usr/bin/env node
/**
 * Claude Code Stop hook script.
 *
 * Claude Code calls this script when the AI finishes responding (Stop event).
 * Hook input is passed via stdin as JSON, containing `transcript_path` which
 * points to the full conversation JSONL file. We read the last assistant
 * message from the transcript and forward it to the Felay daemon via IPC.
 *
 * Usage in ~/.claude/settings.json:
 *   "hooks": {
 *     "Stop": [{
 *       "matcher": "",
 *       "hooks": [{ "type": "command", "command": "node <path>/felay-claude-hook.js" }]
 *     }]
 *   }
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

/**
 * Extract text content from an assistant message's content field.
 * Content can be a plain string or an array of content blocks.
 */
function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Read the transcript JSONL file and extract the last assistant message.
 *
 * Claude Code transcript format (each line):
 *   { "type": "assistant", "message": { "role": "assistant", "content": [...] }, ... }
 *   { "type": "user", "message": { "role": "user", "content": [...] }, ... }
 *
 * The text is in msg.message.content[].text (content blocks array).
 */
function getLastAssistantMessage(transcriptPath) {
  let data;
  try {
    data = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const lines = data.split("\n").filter((l) => l.trim());

  // Walk backwards to find the last assistant message with text content
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);

      // Claude Code transcript format: type="assistant", content in entry.message.content
      if (entry.type === "assistant" && entry.message?.content) {
        const text = extractTextContent(entry.message.content);
        if (text) return text;
      }

      // Fallback: standard role-based format (role="assistant", content at top level)
      if (entry.role === "assistant" && entry.content) {
        const text = extractTextContent(entry.content);
        if (text) return text;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function main() {
  // Read hook input from stdin
  let inputData = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    inputData += chunk;
  });

  process.stdin.on("end", () => {
    try {
      const hookInput = JSON.parse(inputData);

      if (hookInput.hook_event_name !== "Stop") {
        process.exit(0);
      }

      const transcriptPath = hookInput.transcript_path;
      if (!transcriptPath) {
        process.exit(0);
      }

      const message = getLastAssistantMessage(transcriptPath);
      if (!message) {
        process.exit(0);
      }

      const ipcPath = getIpcPath();
      const ipcMessage =
        JSON.stringify({
          type: "claude_notify",
          payload: {
            cwd: hookInput.cwd || "",
            message: message,
            sessionId: hookInput.session_id || "",
          },
        }) + "\n";

      const socket = net.createConnection(ipcPath, () => {
        socket.write(ipcMessage, () => {
          socket.end();
        });
      });

      socket.on("error", () => {
        process.exit(0);
      });

      socket.on("close", () => {
        process.exit(0);
      });

      // Timeout safety
      setTimeout(() => {
        process.exit(0);
      }, 3000);
    } catch {
      process.exit(0);
    }
  });

  // If stdin closes immediately (no data), exit
  setTimeout(() => {
    if (!inputData) {
      process.exit(0);
    }
  }, 5000);
}

main();
