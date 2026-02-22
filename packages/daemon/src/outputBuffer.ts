/**
 * Per-session output buffering with two modes:
 *
 * 1. Interactive buffer: collects PTY output after a Feishu message triggers
 *    collection, flushes after a silence timeout (no new chunks).
 *
 * 2. Push buffer: continuously appends PTY output, flushes on a merge-window
 *    timer. Supports dynamic window increase on rate-limit.
 */

export interface OutputBufferOptions {
  /** Silence timeout for interactive replies (ms). Default 5000. */
  interactiveSilenceMs?: number;
  /** Merge window for push flushes (ms). Taken from config. */
  pushMergeWindowMs: number;
  /** Max bytes per message. Excess is truncated keeping the tail. */
  maxMessageBytes: number;

  /** Called when interactive silence timeout fires. */
  onInteractiveReply: (sessionId: string, fullOutput: string) => void;
  /** Called when push merge window fires. */
  onPushFlush: (sessionId: string, mergedOutput: string) => void;
}

interface InteractiveState {
  collecting: boolean;
  chunks: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface PushState {
  chunks: string[];
  timer: ReturnType<typeof setTimeout> | null;
  mergeWindowMs: number;
}

interface SummaryState {
  buffer: string;
  maxBytes: number;
}

export class OutputBuffer {
  private readonly interactive = new Map<string, InteractiveState>();
  private readonly push = new Map<string, PushState>();
  private readonly summary = new Map<string, SummaryState>();

  private static readonly SUMMARY_MAX_BYTES = 8192;
  private readonly opts: Required<Pick<OutputBufferOptions, "interactiveSilenceMs">> &
    OutputBufferOptions;

  constructor(opts: OutputBufferOptions) {
    this.opts = { interactiveSilenceMs: 5000, ...opts };
  }

  /* ── Interactive buffer ── */

  /** Begin collecting output for a session (called when Feishu message arrives). */
  startCollecting(sessionId: string): void {
    let state = this.interactive.get(sessionId);
    if (!state) {
      state = { collecting: false, chunks: [], timer: null };
      this.interactive.set(sessionId, state);
    }
    // Reset for new collection cycle
    if (state.timer) clearTimeout(state.timer);
    state.collecting = true;
    state.chunks = [];
    state.timer = null;
  }

  /** Append a PTY output chunk to the interactive buffer. */
  appendChunk(sessionId: string, chunk: string): void {
    const state = this.interactive.get(sessionId);
    if (!state || !state.collecting) return;

    state.chunks.push(chunk);

    // Reset silence timer
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this.flushInteractive(sessionId);
    }, this.opts.interactiveSilenceMs);
  }

  private flushInteractive(sessionId: string): void {
    const state = this.interactive.get(sessionId);
    if (!state || !state.collecting) return;

    const full = state.chunks.join("");
    state.collecting = false;
    state.chunks = [];
    state.timer = null;

    if (full.length > 0) {
      this.opts.onInteractiveReply(sessionId, this.truncateTail(full));
    }
  }

  /* ── Push buffer ── */

  /** Append a PTY output chunk to the push buffer. */
  appendPushChunk(sessionId: string, chunk: string): void {
    let state = this.push.get(sessionId);
    if (!state) {
      state = {
        chunks: [],
        timer: null,
        mergeWindowMs: this.opts.pushMergeWindowMs,
      };
      this.push.set(sessionId, state);
    }

    state.chunks.push(chunk);

    // Start merge-window timer if not already running
    if (!state.timer) {
      state.timer = setTimeout(() => {
        this.flushPush(sessionId);
      }, state.mergeWindowMs);
    }
  }

  private flushPush(sessionId: string): void {
    const state = this.push.get(sessionId);
    if (!state) return;

    const merged = state.chunks.join("");
    state.chunks = [];
    state.timer = null;

    if (merged.length > 0) {
      this.opts.onPushFlush(sessionId, this.truncateTail(merged));
    }
  }

  /* ── Summary buffer (rolling tail of all output for task summary) ── */

  /** Append a PTY output chunk to the summary buffer (called for every pty_output). */
  appendSummaryChunk(sessionId: string, chunk: string): void {
    let state = this.summary.get(sessionId);
    if (!state) {
      state = { buffer: "", maxBytes: OutputBuffer.SUMMARY_MAX_BYTES };
      this.summary.set(sessionId, state);
    }

    state.buffer += chunk;

    // Trim to keep only the tail
    if (Buffer.byteLength(state.buffer, "utf8") > state.maxBytes) {
      const buf = Buffer.from(state.buffer, "utf8");
      let sliced = buf.subarray(buf.length - state.maxBytes).toString("utf8");
      // Strip leading replacement character from broken multi-byte sequence
      if (sliced.charCodeAt(0) === 0xfffd) {
        sliced = sliced.slice(1);
      }
      state.buffer = sliced;
    }
  }

  /** Get the summary buffer content for a session (last ~8KB of output). */
  getSummary(sessionId: string): string | null {
    const state = this.summary.get(sessionId);
    if (!state || !state.buffer) return null;
    return state.buffer;
  }

  /** Increase the merge window for a session (e.g. on rate-limit). */
  increaseMergeWindow(sessionId: string): void {
    const state = this.push.get(sessionId);
    if (!state) return;
    state.mergeWindowMs = Math.min(state.mergeWindowMs * 2, 30000);
  }

  /* ── Cleanup ── */

  /** Force-flush remaining interactive output for a session (used on session end). */
  forceFlushInteractive(sessionId: string): string | null {
    const state = this.interactive.get(sessionId);
    if (!state) return null;
    if (state.timer) clearTimeout(state.timer);
    const full = state.chunks.join("");
    state.collecting = false;
    state.chunks = [];
    state.timer = null;
    return full.length > 0 ? this.truncateTail(full) : null;
  }

  /** Clean up all timers and buffers for a session. */
  cleanup(sessionId: string): void {
    const iState = this.interactive.get(sessionId);
    if (iState) {
      if (iState.timer) clearTimeout(iState.timer);
      this.interactive.delete(sessionId);
    }

    const pState = this.push.get(sessionId);
    if (pState) {
      if (pState.timer) clearTimeout(pState.timer);
      this.push.delete(sessionId);
    }

    this.summary.delete(sessionId);
  }

  /* ── Util ── */

  private truncateTail(text: string): string {
    const max = this.opts.maxMessageBytes;
    if (Buffer.byteLength(text, "utf8") <= max) return text;
    // Keep the tail (most recent output is more relevant)
    const buf = Buffer.from(text, "utf8");
    let sliced = buf.subarray(buf.length - max).toString("utf8");
    // Strip leading replacement character from broken multi-byte sequence
    if (sliced.charCodeAt(0) === 0xfffd) {
      sliced = sliced.slice(1);
    }
    return "...(truncated)\n" + sliced;
  }
}
