import { describe, expect, it } from 'vitest'
import { convertVideoBlock } from '../src/providers/proxy-provider.js'
import type { VideoBlock } from '../src/engine/contracts/conversation.js'

describe('convertVideoBlock ', () => {
  it('VideoBlock url → OpenAI video_url part', () => {
    const block: VideoBlock = {
      type: 'video',
      source: { type: 'url', url: 'https://cdn.example.com/demo.mp4' },
    }
    expect(convertVideoBlock(block)).toEqual({
      type: 'video_url',
      video_url: { url: 'https://cdn.example.com/demo.mp4' },
    })
  })
})
