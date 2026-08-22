import { describe, expect, it } from 'vitest'
import { decodeDjangoProxyBody, type DjangoBinaryEnvelope } from '../django-proxy-body.js'

function expectBinary(decoded: unknown): DjangoBinaryEnvelope {
  expect(decoded).toMatchObject({ __binary: true })
  return decoded as DjangoBinaryEnvelope
}

describe('decodeDjangoProxyBody', () => {
  it('wraps xlsx bytes as __binary base64 without UTF-8 corruption', () => {
    const bytes = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, // PK\x03\x04
      0x00, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x01,
    ])
    const contentType =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

    const envelope = expectBinary(decodeDjangoProxyBody(contentType, bytes))
    expect(envelope).toEqual({
      __binary: true,
      content_type: contentType,
      base64: bytes.toString('base64'),
    })
    const roundTrip = Buffer.from(envelope.base64, 'base64')
    expect(roundTrip.equals(bytes)).toBe(true)
    expect(roundTrip.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
  })

  it('wraps pdf as __binary', () => {
    const bytes = Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n', 'binary')
    const envelope = expectBinary(decodeDjangoProxyBody('application/pdf', bytes))
    expect(envelope.content_type).toBe('application/pdf')
    expect(Buffer.from(envelope.base64, 'base64').equals(bytes)).toBe(true)
  })

  it('passthrough CSV as utf-8 text envelope', () => {
    const csv = 'name,age\nAlice,30\n'
    const decoded = decodeDjangoProxyBody('text/csv; charset=utf-8', Buffer.from(csv))
    expect(decoded).toEqual({
      __passthrough: true,
      content_type: 'text/csv; charset=utf-8',
      raw: csv,
    })
  })

  it('parses JSON application bodies', () => {
    const payload = { ok: true, data: { id: 't1' } }
    const decoded = decodeDjangoProxyBody(
      'application/json',
      Buffer.from(JSON.stringify(payload)),
    )
    expect(decoded).toEqual(payload)
  })

  it('falls back to { raw } for non-JSON text', () => {
    const decoded = decodeDjangoProxyBody('text/plain', Buffer.from('not-json'))
    expect(decoded).toEqual({ raw: 'not-json' })
  })

  it('missing Content-Type + invalid UTF-8 → __binary octet-stream', () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80])
    const envelope = expectBinary(decodeDjangoProxyBody('', bytes))
    expect(envelope.content_type).toBe('application/octet-stream')
    expect(Buffer.from(envelope.base64, 'base64').equals(bytes)).toBe(true)
    expect(Buffer.from(envelope.base64, 'base64').includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(
      false,
    )
  })

  it('missing Content-Type + valid UTF-8 JSON still parses', () => {
    const payload = { ok: true }
    expect(decodeDjangoProxyBody(null, Buffer.from(JSON.stringify(payload)))).toEqual(payload)
  })

  it('regression: naive utf-8 round-trip would inject U+FFFD into binary', () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x80])
    const naive = Buffer.from(bytes.toString('utf-8'), 'utf-8')
    expect(naive.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(true)

    const envelope = expectBinary(
      decodeDjangoProxyBody(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes,
      ),
    )
    const fixed = Buffer.from(envelope.base64, 'base64')
    expect(fixed.equals(bytes)).toBe(true)
    expect(fixed.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false)
  })
})
