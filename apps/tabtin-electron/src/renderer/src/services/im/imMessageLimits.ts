/** Django IM 单条消息正文上限，沿用历史 12 KB 封包预留。 */
export const IM_MESSAGE_MAX_BYTES = 12_000
export const IM_MESSAGE_ENVELOPE_RESERVE_BYTES = 2_000
export const IM_MESSAGE_CONTENT_MAX_BYTES =
  IM_MESSAGE_MAX_BYTES - IM_MESSAGE_ENVELOPE_RESERVE_BYTES

const utf8Encoder = new TextEncoder()

export function getIMMessageContentByteLength(content: string): number {
  return utf8Encoder.encode(content).byteLength
}

export function isIMMessageContentWithinLimit(content: string): boolean {
  return getIMMessageContentByteLength(content) <= IM_MESSAGE_CONTENT_MAX_BYTES
}
