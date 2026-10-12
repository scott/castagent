export interface SessionTurn {
  role: 'user' | 'agent'
  text: string
}

/** What the next message/send attaches. history is present only on the seed turn. */
export interface OutboundSession {
  sessionId?: string
  history?: SessionTurn[]
}

/**
 * Pairs the on-screen session with the id sent on message/send.
 *
 * A loaded transcript (resume, fork, or --session) is attached once,
 * because the agent process cannot read ~/.cast/sessions. A new
 * connection sends only its id, so the server starts an empty context.
 */
export class SessionContext {
  private sessionId: string | null = null
  private pendingTranscript: SessionTurn[] | null = null

  get id(): string | null {
    return this.sessionId
  }

  /** Connect, /connect, or /session new. Nothing is seeded. */
  start(sessionId: string | null = null): void {
    this.sessionId = sessionId
    this.pendingTranscript = null
  }

  /** Resume, fork, or a launch with --session. Sent with the next turn only. */
  load(sessionId: string, transcript: SessionTurn[]): void {
    this.sessionId = sessionId
    this.pendingTranscript = transcript
      .filter((turn) => turn.role === 'user' || turn.role === 'agent')
      .map((turn) => ({role: turn.role, text: turn.text}))
  }

  /**
   * Bind an id created for a fresh chat. Does not seed history.
   * The same id keeps a transcript that load() already armed.
   */
  bind(sessionId: string): void {
    if (this.sessionId !== sessionId) {
      this.pendingTranscript = null
    }
    this.sessionId = sessionId
  }

  /** Metadata for the turn about to be sent. Does not clear the one-time transcript. */
  peek(): OutboundSession {
    if (!this.sessionId) return {}
    if (this.pendingTranscript && this.pendingTranscript.length > 0) {
      return {
        sessionId: this.sessionId,
        history: this.pendingTranscript.map((turn) => ({role: turn.role, text: turn.text})),
      }
    }
    return {sessionId: this.sessionId}
  }

  /** The seed was delivered. Later turns send only the id. */
  commit(): void {
    this.pendingTranscript = null
  }
}
