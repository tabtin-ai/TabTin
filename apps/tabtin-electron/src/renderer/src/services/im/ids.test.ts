import { describe, expect, it } from 'vitest'
import { createClientRequestId, createMessageRef } from './ids'

describe('createClientRequestId', () => {
  it('generates an RFC 9562 UUIDv7 with the supplied timestamp', () => {
    const timestamp = Date.parse('2026-07-30T08:00:00.000Z')
    const id = createClientRequestId(timestamp)

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(timestamp)
  })

  it('does not reuse random bits for IDs created in the same millisecond', () => {
    const timestamp = Date.parse('2026-07-30T08:00:00.000Z')

    expect(createClientRequestId(timestamp)).not.toBe(createClientRequestId(timestamp))
  })
})

describe('createMessageRef', () => {
  it('uses the same UUIDv7 format as request IDs without sharing identity', () => {
    const timestamp = Date.parse('2026-07-30T08:00:00.000Z')
    const requestId = createClientRequestId(timestamp)
    const messageRef = createMessageRef(timestamp)

    expect(messageRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(messageRef).not.toBe(requestId)
  })
})
