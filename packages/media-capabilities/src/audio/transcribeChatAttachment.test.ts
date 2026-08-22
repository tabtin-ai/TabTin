import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  classifyChatAudioAsrFailure,
  clearChatAudioTranscriptCache,
  formatChatAudioTranscriptBody,
  formatChatAudioTranscriptFailure,
  inferAudioFormat,
  isChatAudioAttachment,
  isCloudUnreachableAudioUrl,
  isFlashCompatibleAudioFormat,
  transcribeChatAudioAttachment,
} from './transcribeChatAttachment.js'

beforeEach(() => {
  clearChatAudioTranscriptCache()
})

describe('isChatAudioAttachment', () => {
  it('detects audio mime and extensions', () => {
    expect(isChatAudioAttachment('audio/mpeg', 'a.mp3')).toBe(true)
    expect(isChatAudioAttachment('audio/wav')).toBe(true)
    expect(isChatAudioAttachment(undefined, 'note.m4a')).toBe(true)
    expect(isChatAudioAttachment('application/pdf', 'x.pdf')).toBe(false)
    expect(isChatAudioAttachment('video/mp4', 'x.mp4')).toBe(false)
  })
})

describe('inferAudioFormat / isFlashCompatibleAudioFormat', () => {
  it('maps mime and extension', () => {
    expect(inferAudioFormat('audio/mpeg')).toBe('mp3')
    expect(inferAudioFormat('audio/wav')).toBe('wav')
    expect(inferAudioFormat('audio/mp4', 'clip.m4a')).toBe('m4a')
    expect(inferAudioFormat(undefined, 'x.ogg')).toBe('ogg')
  })

  it('flash only accepts mp3/wav/ogg', () => {
    expect(isFlashCompatibleAudioFormat('mp3')).toBe(true)
    expect(isFlashCompatibleAudioFormat('m4a')).toBe(false)
  })
})

describe('isCloudUnreachableAudioUrl', () => {
  it('flags localhost / local-object', () => {
    expect(
      isCloudUnreachableAudioUrl(
        'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.mp3',
      ),
    ).toBe(true)
    expect(isCloudUnreachableAudioUrl('http://localhost:6060/x.mp3')).toBe(true)
    expect(isCloudUnreachableAudioUrl('https://cdn.example.com/a.mp3')).toBe(false)
  })
})

describe('classifyChatAudioAsrFailure', () => {
  it('classifies common failures', () => {
    expect(classifyChatAudioAsrFailure('ASR_NOT_CONFIGURED: 未配置', 'ASR_NOT_CONFIGURED')).toBe(
      'not_configured',
    )
    expect(classifyChatAudioAsrFailure('code=45000006 Invalid audio URI')).toBe('local_oss')
    expect(classifyChatAudioAsrFailure('语音识别超时')).toBe('timeout')
    expect(classifyChatAudioAsrFailure('请先转为较短的 mp3 / wav')).toBe('local_unsupported_format')
    expect(classifyChatAudioAsrFailure('音频过大（20MB），超过本地转写上限')).toBe('local_too_large')
    expect(classifyChatAudioAsrFailure('code=55000000 upstream boom')).toBe('upstream')
  })
})

describe('formatChatAudioTranscriptBody', () => {
  it('wraps transcript', () => {
    expect(formatChatAudioTranscriptBody('a.mp3', '  hello  ')).toContain('[音频转写: a.mp3]')
    expect(formatChatAudioTranscriptBody('a.mp3', '  hello  ')).toContain('hello')
  })

  it('handles empty transcript', () => {
    expect(formatChatAudioTranscriptBody('a.mp3', '')).toContain('未检测到有效语音')
  })
})

describe('formatChatAudioTranscriptFailure', () => {
  it('does not tell agent the org switch is off for local OSS', () => {
    const text = formatChatAudioTranscriptFailure(
      'a.mp3',
      'code=45000006 Invalid audio URI',
      'local_oss',
    )
    expect(text).toMatch(/本地开发存储|云端无法直接拉取/)
    expect(text).toMatch(/不要把原因说成「组织没开通 ASR」|不要假装/)
    expect(text).not.toMatch(/组织是否开通 ASR/)
  })

  it('classifies not_configured distinctly', () => {
    const text = formatChatAudioTranscriptFailure('a.mp3', 'ASR_NOT_CONFIGURED', 'not_configured')
    expect(text).toMatch(/尚未配置|AdminDash/)
  })
})

describe('transcribeChatAudioAttachment', () => {
  it('calls flash recognize with audio_url for public CDN', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, data: { text: '你好世界' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const result = await transcribeChatAudioAttachment(
      {
        url: 'https://cdn.example.com/a.mp3',
        filename: 'a.mp3',
        mime_type: 'audio/mpeg',
        size: 1024,
        file_id: 'f-cdn',
      },
      {
        apiBaseUrl: 'http://127.0.0.1:6060/api',
        organizationId: 'org-1',
        getAccessToken: () => 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toBe('你好世界')
      expect(result.mode).toBe('flash')
      expect(result.fromCache).toBeUndefined()
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body.audio_url).toContain('a.mp3')
    expect(body.audio_data).toBeUndefined()
  })

  it('downloads localhost audio and sends audio_data', async () => {
    const localUrl =
      'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.mp3'
    const audioBytes = new Uint8Array([1, 2, 3, 4, 5])
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('local-object')) {
        return new Response(audioBytes, { status: 200 })
      }
      if (u.includes('/services/speech/recognize/')) {
        return new Response(
          JSON.stringify({ success: true, data: { text: '本机转写成功' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })

    const result = await transcribeChatAudioAttachment(
      {
        url: localUrl,
        filename: 'a.mp3',
        mime_type: 'audio/mpeg',
        size: 5,
        file_id: 'f-local',
      },
      {
        apiBaseUrl: 'http://127.0.0.1:6060/api',
        organizationId: 'org-1',
        getAccessToken: () => 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toBe('本机转写成功')
    const recognizeCall = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes('/services/speech/recognize/'),
    )
    const body = JSON.parse(String((recognizeCall![1] as RequestInit).body))
    expect(body.audio_url).toBeUndefined()
    expect(typeof body.audio_data).toBe('string')
  })

  it('refuses local m4a without calling ASR', async () => {
    const fetchImpl = vi.fn()
    const result = await transcribeChatAudioAttachment(
      {
        url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=x.m4a',
        filename: 'x.m4a',
        mime_type: 'audio/mp4',
        size: 1024,
      },
      {
        apiBaseUrl: 'http://127.0.0.1:6060/api',
        organizationId: 'org-1',
        getAccessToken: () => 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('local_unsupported_format')
      expect(result.userMessage).toMatch(/mp3|wav/)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses oversized local audio without calling ASR', async () => {
    const fetchImpl = vi.fn()
    const result = await transcribeChatAudioAttachment(
      {
        url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=big.mp3',
        filename: 'big.mp3',
        mime_type: 'audio/mpeg',
        size: 20 * 1024 * 1024,
      },
      {
        apiBaseUrl: 'http://127.0.0.1:6060/api',
        organizationId: 'org-1',
        getAccessToken: () => 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('local_too_large')
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('caches successful transcript by file_id', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, data: { text: '缓存原文' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const deps = {
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      organizationId: 'org-1',
      getAccessToken: () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }
    const att = {
      url: 'https://cdn.example.com/a.mp3',
      filename: 'a.mp3',
      mime_type: 'audio/mpeg',
      size: 100,
      file_id: 'file-cache-1',
    }

    const first = await transcribeChatAudioAttachment(att, deps)
    const second = await transcribeChatAudioAttachment(att, deps)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.text).toBe('缓存原文')
      expect(second.fromCache).toBe(true)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns failure when organization missing', async () => {
    const result = await transcribeChatAudioAttachment(
      { url: 'https://cdn.example.com/a.mp3', filename: 'a.mp3' },
      {
        apiBaseUrl: 'http://127.0.0.1:6060/api',
        organizationId: '',
        getAccessToken: () => 'tok',
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('missing_org')
      expect(result.userMessage).toContain('缺少组织信息')
    }
  })
})
