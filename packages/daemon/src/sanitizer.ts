/**
 * ANSI escape sequence stripping and noise filtering for PTY output.
 */

// Matches common ANSI escape sequences:
// - CSI sequences: ESC [ ... letter  (colors, cursor movement, erase, etc.)
// - OSC sequences: ESC ] ... BEL/ST  (title setting, hyperlinks, etc.)
// - Character set: ESC ( or ) followed by a character
// - Simple escapes: ESC followed by a single character
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[()][AB012]|\x1B[A-Za-z]|\x1B\[[\d;]*m/g;

// Control characters (except newline/tab)
// eslint-disable-next-line no-control-regex
const CTRL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Remove all ANSI escape sequences and stray control characters from text.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "").replace(CTRL_CHARS_RE, "");
}

/**
 * Filter out lines that are pure noise:
 * - Lines consisting only of whitespace
 * - Repeated cursor-movement artifacts (lines with only special chars after stripping)
 * - Progress bar lines (lines starting with common progress indicators)
 */
export function filterNoiseLines(text: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    // Filter pure whitespace/box-drawing noise
    if (/^[\s─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]+$/.test(trimmed)) return false;
    return true;
  });
  return filtered.join("\n");
}
