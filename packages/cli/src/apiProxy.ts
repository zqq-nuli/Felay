import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { URL } from "node:url";

const proxyLogPath = path.join(os.homedir(), ".felay", "proxy-debug.log");
function proxyLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(proxyLogPath, line); } catch { /* ignore */ }
}

/* ── Types ── */

export interface AssembledMessage {
  provider: "anthropic" | "openai";
  model: string;
  stopReason: string;
  textContent: string;
  toolUseBlocks?: Array<{ name: string; input: string }>;
  isSuggestion: boolean;
  completedAt: string;
}

interface SseEvent {
  event: string;
  data: string;
}

/* ── SSE Parser ── */

class SseParser {
  private buffer = "";

  /** Feed a raw chunk and return any fully-parsed SSE events. */
  feed(chunk: string): SseEvent[] {
    // Normalize \r\n and bare \r to \n (SSE spec allows all three line endings)
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const events: SseEvent[] = [];

    // SSE events are separated by double newlines
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);

      let event = "";
      let data = "";

      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) {
          event = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          data += (data ? "\n" : "") + line.slice(6);
        } else if (line.startsWith("data:")) {
          // "data:" with no space (e.g., "data:[DONE]")
          data += (data ? "\n" : "") + line.slice(5);
        }
      }

      if (event || data) {
        events.push({ event, data });
      }
    }

    return events;
  }

  reset(): void {
    this.buffer = "";
  }
}

/* ── Anthropic Assembler ── */

interface ContentBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  toolName?: string;
  toolInput?: string;
}

class AnthropicAssembler {
  private blocks: Map<number, ContentBlock> = new Map();
  private stopReason = "";
  private model = "";
  private readonly isSuggestion: boolean;
  private readonly onComplete: (msg: AssembledMessage) => void;

  constructor(onComplete: (msg: AssembledMessage) => void, isSuggestion: boolean) {
    this.onComplete = onComplete;
    this.isSuggestion = isSuggestion;
  }

  feed(event: SseEvent): void {
    let parsed: any;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (event.event) {
      case "message_start": {
        this.model = parsed.message?.model ?? "";
        break;
      }
      case "content_block_start": {
        const index = parsed.index as number;
        const blockType = parsed.content_block?.type;
        if (blockType === "text") {
          this.blocks.set(index, { type: "text", text: "" });
        } else if (blockType === "tool_use") {
          this.blocks.set(index, {
            type: "tool_use",
            toolName: parsed.content_block.name ?? "",
            toolInput: "",
          });
        } else if (blockType === "thinking") {
          this.blocks.set(index, { type: "thinking", text: "" });
        }
        break;
      }

      case "content_block_delta": {
        const index = parsed.index as number;
        const block = this.blocks.get(index);
        if (!block) break;
        const deltaType = parsed.delta?.type;
        if (deltaType === "text_delta" && block.type === "text") {
          block.text = (block.text ?? "") + (parsed.delta.text ?? "");
        } else if (deltaType === "input_json_delta" && block.type === "tool_use") {
          block.toolInput = (block.toolInput ?? "") + (parsed.delta.partial_json ?? "");
        } else if (deltaType === "thinking_delta" && block.type === "thinking") {
          block.text = (block.text ?? "") + (parsed.delta.thinking ?? "");
        }
        break;
      }

      case "message_delta": {
        this.stopReason = parsed.delta?.stop_reason ?? "";
        break;
      }

      case "message_stop": {
        const textParts: string[] = [];
        const toolUseBlocks: Array<{ name: string; input: string }> = [];

        for (const [, block] of [...this.blocks.entries()].sort((a, b) => a[0] - b[0])) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            toolUseBlocks.push({
              name: block.toolName ?? "",
              input: block.toolInput ?? "",
            });
          }
          // thinking blocks are parsed but not forwarded to Feishu
        }

        this.onComplete({
          provider: "anthropic",
          model: this.model,
          stopReason: this.stopReason,
          textContent: textParts.join(""),
          toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
          isSuggestion: this.isSuggestion,
          completedAt: new Date().toISOString(),
        });

        // Reset for next message
        this.blocks.clear();
        this.stopReason = "";
        this.model = "";
        break;
      }
    }
  }
}

/* ── OpenAI Assembler ── */

class OpenAIAssembler {
  private textContent = "";
  private model = "";
  private toolCalls: Map<number, { name: string; arguments: string }> = new Map();
  private finishReason = "";
  private readonly isSuggestion: boolean;
  private readonly onComplete: (msg: AssembledMessage) => void;

  constructor(onComplete: (msg: AssembledMessage) => void, isSuggestion: boolean) {
    this.onComplete = onComplete;
    this.isSuggestion = isSuggestion;
  }

  feed(event: SseEvent): void {
    if (event.data === "[DONE]") {
      const toolUseBlocks: Array<{ name: string; input: string }> = [];
      for (const [, tc] of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        toolUseBlocks.push({ name: tc.name, input: tc.arguments });
      }

      this.onComplete({
        provider: "openai",
        model: this.model,
        stopReason: this.finishReason || "stop",
        textContent: this.textContent,
        toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
        isSuggestion: this.isSuggestion,
        completedAt: new Date().toISOString(),
      });

      // Reset
      this.textContent = "";
      this.toolCalls.clear();
      this.finishReason = "";
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    if (parsed.model && !this.model) {
      this.model = parsed.model;
    }

    const choice = parsed.choices?.[0];
    if (!choice) return;

    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }

    const delta = choice.delta;
    if (!delta) return;

    if (delta.content) {
      this.textContent += delta.content;
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const existing = this.toolCalls.get(idx);
        if (!existing) {
          this.toolCalls.set(idx, {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          });
        } else {
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        }
      }
    }
  }
}

/* ── CLI type detection ── */

export function getProxyEnvConfig(cli: string): {
  envVar: string;
  defaultUpstream: string;
  provider: "anthropic" | "openai";
} | null {
  const base = cli.replace(/\\/g, "/").split("/").pop() || "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();

  if (name === "claude") {
    return {
      envVar: "ANTHROPIC_BASE_URL",
      defaultUpstream: "https://api.anthropic.com",
      provider: "anthropic",
    };
  }

  if (name === "codex") {
    return {
      envVar: "OPENAI_BASE_URL",
      defaultUpstream: "https://api.openai.com",
      provider: "openai",
    };
  }

  return null;
}

/* ── Resolve actual upstream URL (check CLI settings files) ── */

/**
 * Resolve the real upstream URL for a CLI, checking:
 * 1. process.env (shell environment)
 * 2. CLI-specific settings files (e.g., ~/.claude/settings.json env block)
 * 3. Default upstream
 */
export function resolveUpstream(envVar: string, defaultUpstream: string, cli: string): string {
  // 1. Shell environment
  if (process.env[envVar]) {
    return process.env[envVar]!;
  }

  // 2. Claude Code settings.json
  const base = cli.replace(/\\/g, "/").split("/").pop() || "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  if (name === "claude") {
    try {
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (settings?.env?.[envVar]) {
        proxyLog(`resolved upstream from ~/.claude/settings.json: ${settings.env[envVar]}`);
        return settings.env[envVar];
      }
    } catch {
      // settings file not found or invalid
    }
  }

  // 3. Default
  return defaultUpstream;
}

/**
 * Write a Node.js require-hook script that monkey-patches globalThis.fetch
 * to redirect requests targeting `upstreamOrigin` to `proxyUrl`.
 * Returns the path to the written hook file.
 */
export function writeHttpHook(proxyUrl: string, upstreamBaseUrl: string): string {
  const upstream = new URL(upstreamBaseUrl);
  const hookPath = path.join(os.homedir(), ".felay", "proxy-hook.cjs");

  // The hook replaces the origin in fetch URLs, keeping path/headers intact.
  // It also patches http.request/https.request for broader coverage.
  const hookCode = `
'use strict';
const PROXY_URL = ${JSON.stringify(proxyUrl)};
const TARGET_ORIGIN = ${JSON.stringify(upstream.origin)};
const TARGET_HOST = ${JSON.stringify(upstream.host)};

// --- Patch globalThis.fetch ---
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function felayProxyFetch(input, init) {
    try {
      let url;
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else if (input && typeof input === 'object' && input.url) {
        url = input.url;
      }
      if (url && url.startsWith(TARGET_ORIGIN)) {
        const newUrl = PROXY_URL + url.slice(TARGET_ORIGIN.length);
        if (typeof input === 'string') {
          return origFetch.call(this, newUrl, init);
        } else if (input instanceof URL) {
          return origFetch.call(this, new URL(newUrl), init);
        } else if (input && typeof input === 'object') {
          return origFetch.call(this, new Request(newUrl, input), init);
        }
      }
    } catch {}
    return origFetch.call(this, input, init);
  };
}

// --- Patch http/https.request ---
for (const mod of ['http', 'https']) {
  try {
    const m = require(mod);
    const origRequest = m.request;
    m.request = function felayProxyRequest(urlOrOpts, optsOrCb, maybeCb) {
      try {
        if (typeof urlOrOpts === 'string' && urlOrOpts.startsWith(TARGET_ORIGIN)) {
          urlOrOpts = PROXY_URL + urlOrOpts.slice(TARGET_ORIGIN.length);
        } else if (urlOrOpts && typeof urlOrOpts === 'object' && !Buffer.isBuffer(urlOrOpts)) {
          const h = urlOrOpts.hostname || urlOrOpts.host || '';
          if (h === TARGET_HOST || h === TARGET_HOST.split(':')[0]) {
            const proxyParsed = new (require('url').URL)(PROXY_URL);
            urlOrOpts = { ...urlOrOpts, hostname: proxyParsed.hostname, host: proxyParsed.host, port: proxyParsed.port, protocol: proxyParsed.protocol };
          }
        }
      } catch {}
      return origRequest.call(this, urlOrOpts, optsOrCb, maybeCb);
    };
  } catch {}
}
`.trimStart();

  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, hookCode, "utf8");
  proxyLog(`wrote http hook to ${hookPath}`);
  return hookPath;
}

/* ── HTTP Reverse Proxy ── */

export async function startApiProxy(
  config: { upstreamBaseUrl: string; provider: "anthropic" | "openai" },
  onMessage: (msg: AssembledMessage) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const upstream = new URL(config.upstreamBaseUrl);
  const isUpstreamHttps = upstream.protocol === "https:";

  const server = http.createServer((clientReq, clientRes) => {
    const targetUrl = new URL(clientReq.url ?? "/", config.upstreamBaseUrl);

    // Copy original headers, update host
    const headers: http.OutgoingHttpHeaders = { ...clientReq.headers };
    headers.host = targetUrl.host;
    // Remove connection-specific headers that shouldn't be forwarded
    delete headers["connection"];

    const reqOptions: http.RequestOptions | https.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isUpstreamHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: clientReq.method,
      headers,
    };

    const transport = isUpstreamHttps ? https : http;

    // Buffer request body for SSE dump
    const reqBodyChunks: Buffer[] = [];
    clientReq.on("data", (chunk: Buffer) => {
      reqBodyChunks.push(chunk);
    });

    const proxyReq = transport.request(reqOptions, (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] ?? "";
      const statusCode = proxyRes.statusCode ?? 0;
      const isSse = contentType.includes("text/event-stream") && statusCode === 200;

      proxyLog(`${clientReq.method} ${clientReq.url} → ${statusCode} content-type=${contentType} isSse=${isSse}`);

      // Forward status and headers transparently
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);

      if (isSse) {
        // Detect suggestion mode from request body
        const reqBody = Buffer.concat(reqBodyChunks).toString("utf8");
        const isSuggestion = reqBody.includes("SUGGESTION MODE");

        // Tee mode: stream to client AND parse SSE
        const parser = new SseParser();
        const assembler = config.provider === "anthropic"
          ? new AnthropicAssembler((msg) => {
              proxyLog(`assembled: model=${msg.model} stopReason=${msg.stopReason} textLen=${msg.textContent.length} tools=${msg.toolUseBlocks?.length ?? 0} suggestion=${msg.isSuggestion}`);
              onMessage(msg);
            }, isSuggestion)
          : new OpenAIAssembler((msg) => {
              proxyLog(`assembled: model=${msg.model} stopReason=${msg.stopReason} textLen=${msg.textContent.length} tools=${msg.toolUseBlocks?.length ?? 0} suggestion=${msg.isSuggestion}`);
              onMessage(msg);
            }, isSuggestion);

        proxyRes.on("data", (chunk: Buffer) => {
          // Forward immediately to client (zero delay)
          clientRes.write(chunk);

          // Feed to SSE parser
          const events = parser.feed(chunk.toString("utf8"));
          for (const ev of events) {
            assembler.feed(ev);
          }
        });

        proxyRes.on("end", () => {
          clientRes.end();
        });

        proxyRes.on("error", (err) => {
          process.stderr.write(`[felay:proxy] upstream response error: ${err.message}\n`);
          clientRes.end();
        });
      } else {
        // Non-SSE: pipe directly
        proxyRes.pipe(clientRes);
        proxyRes.on("error", (err) => {
          process.stderr.write(`[felay:proxy] upstream response error: ${err.message}\n`);
          clientRes.end();
        });
      }
    });

    proxyReq.on("error", (err) => {
      process.stderr.write(`[felay:proxy] upstream request error: ${err.message}\n`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
      }
      clientRes.end(`Proxy error: ${err.message}`);
    });

    clientReq.on("error", (err) => {
      process.stderr.write(`[felay:proxy] client request error: ${err.message}\n`);
      proxyReq.destroy();
    });

    // Pipe client request body to upstream
    clientReq.pipe(proxyReq);
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get proxy server address"));
        return;
      }
      const port = addr.port;
      proxyLog(`listening on http://127.0.0.1:${port} → ${config.upstreamBaseUrl}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });

    server.on("error", reject);
  });
}
