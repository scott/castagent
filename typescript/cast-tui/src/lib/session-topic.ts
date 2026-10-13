/**
 * Session picker titles and the background topic refresh.
 * No @opentui imports: Mocha loads this file without the TUI renderer.
 */

export const TOPIC_CHAR_LIMIT = 60
export const SESSION_TOPIC_CONCURRENCY = 3

export interface SessionTitleSource {
  id?: string
  name?: string | null
  topic?: string | null
  first_user_message?: string | null
  topic_message_count?: number | null
  message_count?: number | null
}

export function truncatePreview(text: string | null | undefined, limit: number = TOPIC_CHAR_LIMIT): string {
  if (!text) return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  return oneLine.length > limit ? oneLine.slice(0, limit - 1) + '…' : oneLine
}

export function sessionDisplayTitle(session: SessionTitleSource): string {
  const name = session.name?.trim()
  if (name) return name
  const topic = truncatePreview(session.topic)
  if (topic) return topic
  const first = truncatePreview(session.first_user_message)
  if (first) return first
  return '(untitled)'
}

export function topicIsFresh(session: SessionTitleSource): boolean {
  const topic = session.topic?.trim()
  if (!topic) return false
  if (session.topic_message_count == null || session.message_count == null) return false
  return Number(session.topic_message_count) === Number(session.message_count)
}

/** Ask the model only for an unnamed session that has a user message and a stale topic. */
export function topicNeedsRefresh(session: SessionTitleSource): boolean {
  if (session.name?.trim()) return false
  if (!session.first_user_message?.trim()) return false
  return !topicIsFresh(session)
}

export function sessionMetaFromRow<T extends Record<string, any>>(row: T): T & {
  topic: string | null
  topic_message_count: number | null
} {
  const topicText = typeof row.topic === 'string' ? row.topic.trim() : ''
  const rawCount = row.topic_message_count
  const topicMessageCount =
    rawCount == null || rawCount === '' || !Number.isFinite(Number(rawCount))
      ? null
      : Number(rawCount)
  return {
    ...row,
    topic: topicText ? String(row.topic) : null,
    topic_message_count: topicMessageCount,
  }
}

/**
 * Refresh stale rows with a small pool. The picker paints first; this runs after.
 * A null result leaves the row on the first-message fallback.
 */
export async function refreshStaleSessionTopics<T extends SessionTitleSource>(
  sessions: T[],
  options: {
    concurrency?: number
    refreshOne: (session: T) => Promise<Partial<T> | null | void>
    onUpdated?: (index: number, session: T) => void
    isCancelled?: () => boolean
  },
): Promise<void> {
  const jobs = sessions
    .map((session, index) => ({session, index}))
    .filter(({session}) => topicNeedsRefresh(session))
  if (jobs.length === 0) return
  const concurrency = Math.max(1, options.concurrency ?? SESSION_TOPIC_CONCURRENCY)
  let cursor = 0
  const worker = async () => {
    while (cursor < jobs.length) {
      if (options.isCancelled?.()) return
      const job = jobs[cursor++]
      if (!job) return
      let patch: Partial<T> | null | void
      try {
        patch = await options.refreshOne(job.session)
      } catch {
        continue
      }
      if (options.isCancelled?.()) return
      if (!patch || typeof patch !== 'object') continue
      const nextTopic = typeof patch.topic === 'string' ? patch.topic.trim() : ''
      if (!nextTopic) continue
      Object.assign(job.session, patch)
      options.onUpdated?.(job.index, job.session)
    }
  }
  const workers = Array.from({length: Math.min(concurrency, jobs.length)}, () => worker())
  await Promise.all(workers)
}
