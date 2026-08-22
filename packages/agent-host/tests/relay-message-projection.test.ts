import { describe, expect, it } from 'vitest'
import { projectRelayMessageEvent } from '../src/delivery/relay-message-projection.js'
import type { StreamEvent } from '@tabtin/agent-runtime'

function userEvent(payload: Record<string, unknown>): StreamEvent {
  return {
    type: 'agent.stream.user',
    payload,
  } as StreamEvent
}

describe('projectRelayMessageEvent ', () => {
  it('strips base64 image source from blocks_json while keeping file_id siblings', () => {
    const huge = 'A'.repeat(50_000)
    const input = userEvent({
      blocks_json: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: huge },
        },
        {
          type: 'image',
          source: { type: 'file_id', file_id: '11111111-1111-4111-8111-111111111111' },
        },
      ],
    })

    const out = projectRelayMessageEvent(input)
    expect(out).not.toBe(input)
    const blocks = out.payload.blocks_json as Array<Record<string, unknown>>
    const strippedSource = blocks[0]!.source as Record<string, unknown>
    expect(strippedSource.data).toContain('stripped_for_relay')
    expect(String(strippedSource.data).length).toBeLessThan(200)
    expect(blocks[1]).toEqual(input.payload.blocks_json[1])
    expect(out.payload.stripped_for_relay).toBe(true)
  })

  it('strips data: URLs from attachments_json', () => {
    const dataUrl = `data:image/png;base64,${'B'.repeat(40_000)}`
    const input = userEvent({
      attachments_json: [
        {
          type: 'image',
          file_id: '22222222-2222-4222-8222-222222222222',
          url: dataUrl,
          preview_url: dataUrl,
        },
      ],
    })

    const out = projectRelayMessageEvent(input)
    const attachments = out.payload.attachments_json as Array<Record<string, unknown>>
    expect(String(attachments[0]!.url)).toContain('stripped_for_relay')
    expect(String(attachments[0]!.preview_url)).toContain('stripped_for_relay')
    expect(attachments[0]!.file_id).toBe('22222222-2222-4222-8222-222222222222')
  })

  it('leaves non-message events unchanged', () => {
    const event = {
      type: 'agent.stream.assistant',
      payload: { content: 'hi' },
    } as StreamEvent
    expect(projectRelayMessageEvent(event)).toBe(event)
  })

  it('no-ops when payload has no inline media', () => {
    const input = userEvent({
      blocks_json: [{ type: 'text', text: 'hello' }],
    })
    expect(projectRelayMessageEvent(input)).toBe(input)
  })
})
