import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../config/api.js', () => ({ API_BASE_URL: 'http://127.0.0.1:6060/api' }))
vi.mock('../../../auth.js', () => ({ TokenManager: { getAccessToken: vi.fn() } }))

import { formatFullTranscript } from '../handoff-transcript-enricher'

const ORIGINAL_BLOCK = [
  '<conversation_reference>',
  '[系统说明] 用户承接了来自他人的 Agent 会话交接。',
  '',
  '## 对话概要',
  '标题：       查看附件内容',
  '',
  '## 交接信息',
  '交接包：     11111111-2222-3333-4444-555555555555',
  '',
  '## 冻结对话内容',
  '',
  '### 用户',
  '看下这个附件',
  '</conversation_reference>',
].join('\n')

describe('formatFullTranscript', () => {
  it('附件带 parsed_content 时注入 <attachment_content>，模型可直接读全文', () => {
    const out = formatFullTranscript(ORIGINAL_BLOCK, [
      {
        role: 'user',
        text: '看下这个附件',
        attachments: [{
          type: 'file',
          file_id: '76090ee0-851e-4319-8e26-ecf176b89d61',
          filename: '202605.00197v1.pdf',
          url: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.pdf',
          mime_type: 'application/pdf',
          size: 243814,
          parsed_content: '这篇论文围绕法律人工智能与律师职业的融合发展……',
        }],
      },
      { role: 'assistant', text: '论文核心命题是……' },
    ], '查看附件内容')

    expect(out).toContain('## 冻结对话内容（完整）')
    expect(out).toContain('附件：202605.00197v1.pdf（238KB） file_id=76090ee0-851e-4319-8e26-ecf176b89d61')
    expect(out).toContain('<attachment_content filename="202605.00197v1.pdf">')
    expect(out).toContain('这篇论文围绕法律人工智能与律师职业的融合发展……')
    expect(out).toContain('</attachment_content>')
    // 会过期的下载地址不该给模型——正确通道是随交接授权回填的解析内容
    expect(out).not.toContain('url=')
  })

  it('解析未就绪时标注内容暂不可用，不静默丢附件', () => {
    const out = formatFullTranscript(ORIGINAL_BLOCK, [
      {
        role: 'user',
        text: '看下这个附件',
        attachments: [{
          type: 'file',
          file_id: 'f-1',
          filename: 'brief.pdf',
          url: '',
          mime_type: 'application/pdf',
          size: 1024,
          parsed_content: '',
        }],
      },
    ], '查看附件内容')

    expect(out).toContain('附件：brief.pdf（1KB） file_id=f-1')
    expect(out).toContain('附件内容暂未解析完成')
    expect(out).not.toContain('<attachment_content')
  })

  it('旧字符串占位附件原样透传', () => {
    const out = formatFullTranscript(ORIGINAL_BLOCK, [
      { role: 'user', text: '看图', attachments: ['[图片]'] },
    ], '查看附件内容')

    expect(out).toContain('附件：[图片]')
  })
})
