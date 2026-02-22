import type { SessionStatus } from "@felay/shared";

export interface SessionInfo {
  sessionId: string;
  cli: string;
  cwd: string;
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
  interactiveBotId?: string;
  pushBotId?: string;
  pushEnabled?: boolean;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionInfo>();

  register(session: Omit<SessionInfo, "updatedAt">): void {
    const existing = this.sessions.get(session.sessionId);
    if (existing && existing.status !== "ended") {
      // Re-registration (e.g. after CLI reconnect): preserve bot bindings
      this.sessions.set(session.sessionId, {
        ...existing,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    this.sessions.set(session.sessionId, {
      ...session,
      updatedAt: new Date().toISOString(),
    });
  }

  end(sessionId: string): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;

    this.sessions.set(sessionId, {
      ...current,
      status: "ended",
      updatedAt: new Date().toISOString(),
    });
  }

  touchProxy(sessionId: string): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;

    this.sessions.set(sessionId, {
      ...current,
      status: "proxy_on",
      updatedAt: new Date().toISOString(),
    });
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  bindInteractiveBot(sessionId: string, botId: string): boolean {
    const current = this.sessions.get(sessionId);
    if (!current) return false;
    this.sessions.set(sessionId, {
      ...current,
      interactiveBotId: botId,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  unbindInteractiveBot(sessionId: string): boolean {
    const current = this.sessions.get(sessionId);
    if (!current) return false;
    this.sessions.set(sessionId, {
      ...current,
      interactiveBotId: undefined,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  bindPushBot(sessionId: string, botId: string): boolean {
    const current = this.sessions.get(sessionId);
    if (!current) return false;
    this.sessions.set(sessionId, {
      ...current,
      pushBotId: botId,
      pushEnabled: true,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  unbindPushBot(sessionId: string): boolean {
    const current = this.sessions.get(sessionId);
    if (!current) return false;
    this.sessions.set(sessionId, {
      ...current,
      pushBotId: undefined,
      pushEnabled: false,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  activeCount(): number {
    return this.list().filter((s) => s.status !== "ended").length;
  }

  /** Remove ended sessions older than the given max age (ms). Default 30 minutes. */
  pruneEnded(maxAgeMs = 30 * 60 * 1000): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (
        session.status === "ended" &&
        now - new Date(session.updatedAt).getTime() > maxAgeMs
      ) {
        this.sessions.delete(id);
        pruned++;
      }
    }
    return pruned;
  }
}
