/**
 * Sending is immediate follow intent. A delayed follow is retained only while the first
 * message has no mounted MessageList; otherwise a later user browse must win the race.
 */
export function beginSendScroll(input: {
  messageCount: number
  requestFollow: () => void
}): number | null {
  input.requestFollow()
  return input.messageCount === 0 ? 0 : null
}
