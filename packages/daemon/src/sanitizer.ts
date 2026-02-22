/**
 * Terminal output sanitization using a headless xterm virtual terminal.
 *
 * Instead of regex-stripping ANSI codes (which breaks on cursor movements,
 * screen redraws, spinner animations, etc.), we feed raw PTY output through
 * a virtual terminal emulator and read back the rendered screen content.
 */

import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;

/**
 * Render raw PTY output through a virtual terminal and extract clean text.
 * This correctly handles cursor movements, screen clears, spinner animations,
 * and all other ANSI escape sequences that a real terminal would process.
 *
 * Note: Terminal.write() is asynchronous — we must wait for the callback
 * before reading the buffer.
 */
export function renderTerminalOutput(rawChunks: string, cols: number = 120, rows: number = 50): Promise<string> {
  return new Promise((resolve) => {
    const term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });

    term.write(rawChunks, () => {
      // Data has been processed — now safe to read the buffer
      const lines: string[] = [];
      const buffer = term.buffer.active;

      for (let i = 0; i <= buffer.length - 1; i++) {
        const line = buffer.getLine(i);
        if (line) {
          lines.push(line.translateToString(true)); // true = trim trailing whitespace
        }
      }

      term.dispose();

      // Remove trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
      }

      // Remove leading empty lines
      while (lines.length > 0 && lines[0].trim() === "") {
        lines.shift();
      }

      resolve(lines.join("\n"));
    });
  });
}

// Keep simple stripAnsi for cases where we just need basic stripping (e.g. push messages)

// Matches common ANSI escape sequences
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[()][AB012]|\x1B[A-Za-z]|\x1B\[[\d;]*m/g;

// Control characters (except newline/tab)
// eslint-disable-next-line no-control-regex
const CTRL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Simple ANSI strip for non-TUI output (push messages, plain CLI tools).
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "").replace(CTRL_CHARS_RE, "");
}

/**
 * Extract meaningful response text from rendered terminal output.
 * Strips TUI chrome like menus, status bars, progress indicators,
 * truncation markers, and other non-content lines.
 */
export function extractResponseText(rendered: string): string {
  const lines = rendered.split("\n");

  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;

    // Truncation marker from outputBuffer
    if (trimmed === "...(truncated)") return false;

    // Common TUI chrome patterns
    // Codex: menu items starting with >
    if (/^>\s+\S/.test(trimmed) && trimmed.length < 80) return false;
    // Codex: status bar items
    if (/\?\s+for\s+shortcuts/.test(trimmed)) return false;
    if (/\d+%\s+context\s+left/.test(trimmed)) return false;
    // Codex: mode indicators
    if (/^(Working|Thinking)\s*\(/.test(trimmed)) return false;
    // Spinner / progress artifacts
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|\/\\-]+$/.test(trimmed)) return false;
    // Box-drawing noise
    if (/^[\s─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬•·]+$/.test(trimmed)) return false;

    return true;
  });

  // Clean leading bullet points (Codex uses "• " for responses)
  const cleaned = filtered.map((line) => {
    return line.replace(/^[•]\s*/, "").trimEnd();
  });

  return cleaned.join("\n").trim();
}

/**
 * Filter out lines that are pure noise (empty, box-drawing).
 */
export function filterNoiseLines(text: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    // Filter pure box-drawing noise
    if (/^[\s─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]+$/.test(trimmed)) return false;
    return true;
  });
  return filtered.join("\n");
}
