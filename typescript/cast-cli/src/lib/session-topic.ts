/**
 * Title for an unnamed session: stored topic, then the first user message.
 * A user-set name always wins. Freshness is topic_message_count == message_count.
 */

export const TOPIC_CHAR_LIMIT = 60

export interface SessionTitleSource {
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
