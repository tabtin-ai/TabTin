/**
 * ConversationReferenceViewerDialog 附件行解析单测：
 * `附件：📎 名字（大小）[file_id: …]` → 可点击文件卡数据（file_id 尾标不展示）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@tabtin/smartsheet-ui', () => ({
  Dialog: () => null,
  DialogContent: () => null,
  DialogTitle: () => null,
  toast: vi.fn(),
}))
vi.mock('@components/tabchat/IMMessageBubble', () => ({ markdownComponents: {} }))
vi.mock('../../preview/useResourcePreviewStore', () => ({
  useResourcePreviewStore: { getState: () => ({ open: vi.fn() }) },
}))
vi.mock('../../preview/inferPreviewableKind', () => ({ inferPreviewableKind: () => 'pdf' }))
vi.mock('../../preview/resolveOssFileAccessUrl', () => ({ resolveOssFileDetail: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('react-markdown', () => ({ default: () => null }))
vi.mock('remark-gfm', () => ({ default: () => null }))

import { parseRawBlockTurns } from '../ConversationReferenceViewerDialog'

const RAW_BLOCK = [
  '<conversation_reference>',
  '## 对话概要',
  '标题：       查看附件内容',
  '',
  '## 冻结对话内容',
  '',
  '### 用户',
  '看看pdf',
  '附件：📎 202605.00197v1.pdf（238.1 KB）[file_id: 76090ee0-851e-4319-8e26-ecf176b89d61]',
  '',
  '### AI',
  '我已经看过这篇 PDF 了。',
  '</conversation_reference>',
].join('\n')

describe('parseRawBlockTurns 附件解析', () => {
  it('附件行解析出文件名/大小/file_id，正文里不再残留附件行', () => {
    const { title, turns } = parseRawBlockTurns(RAW_BLOCK)

    expect(title).toBe('查看附件内容')
    expect(turns).toHaveLength(2)

    const userTurn = turns[0]
    expect(userTurn.text).toBe('看看pdf')
    expect(userTurn.attachments).toEqual([{
      filename: '202605.00197v1.pdf',
      sizeLabel: '238.1 KB',
      fileId: '76090ee0-851e-4319-8e26-ecf176b89d61',
    }])
    // file_id 尾标只做数据，不进正文展示
    expect(userTurn.text).not.toContain('file_id')

    expect(turns[1].attachments).toEqual([])
  })

  it('旧字符串占位（[图片]）与无 file_id 附件降级为纯文本卡', () => {
    const raw = [
      '## 冻结对话内容',
      '### 用户',
      '看图',
      '附件：[图片]、📎 note.txt（1.0 KB）',
    ].join('\n')

    const { turns } = parseRawBlockTurns(raw)
    expect(turns[0].attachments).toEqual([
      { filename: '[图片]', sizeLabel: undefined, fileId: undefined },
      { filename: 'note.txt', sizeLabel: '1.0 KB', fileId: undefined },
    ])
  })

  it('多附件同行按「、」拆分', () => {
    const raw = [
      '## 冻结对话内容',
      '### 用户',
      '附件：📎 a.pdf（1.0 KB）[file_id: 11111111-2222-4333-8444-555555555555]、📎 b.pdf（2.0 KB）[file_id: 66666666-7777-4888-9999-aaaaaaaaaaaa]',
    ].join('\n')

    const { turns } = parseRawBlockTurns(raw)
    expect(turns[0].attachments.map(a => a.filename)).toEqual(['a.pdf', 'b.pdf'])
    expect(turns[0].attachments.map(a => a.fileId)).toEqual([
      '11111111-2222-4333-8444-555555555555',
      '66666666-7777-4888-9999-aaaaaaaaaaaa',
    ])
  })
})
