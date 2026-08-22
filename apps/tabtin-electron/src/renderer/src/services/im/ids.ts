const UUID_BYTE_LENGTH = 16
const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

/**
 * Generates the client idempotency key at the transport boundary.
 *
 * UUIDv7 keeps the ID sortable for diagnostics without making it the message
 * ordering authority. Provider seq remains the only conversation order.
 */
function createUuidV7(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_UUID_V7_TIMESTAMP) {
    throw new RangeError('UUIDv7 timestamp is outside the supported range')
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure random number generation is unavailable')
  }

  const bytes = new Uint8Array(UUID_BYTE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)

  bytes[0] = Math.floor(now / 0x10000000000) & 0xff
  bytes[1] = Math.floor(now / 0x100000000) & 0xff
  bytes[2] = Math.floor(now / 0x1000000) & 0xff
  bytes[3] = Math.floor(now / 0x10000) & 0xff
  bytes[4] = Math.floor(now / 0x100) & 0xff
  bytes[5] = now & 0xff
  bytes[6] = 0x70 | (bytes[6] & 0x0f)
  bytes[8] = 0x80 | (bytes[8] & 0x3f)

  const hex = Array.from(bytes, byteToHex)
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-')
}

export function createClientRequestId(now = Date.now()): string {
  return createUuidV7(now)
}

/**
 * Generates the stable identity carried by optimistic, confirmed, and echoed
 * representations of one logical message.
 */
export function createMessageRef(now = Date.now()): string {
  return createUuidV7(now)
}
