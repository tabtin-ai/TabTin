/**
 * blockToContextRef 单元测试
 *
 * 覆盖目标：
 * 1. 6 种新增「整个 tab 资源引用」的 block → ref 还原（webpage / memo /
 *    whiteboard / phone_device / desktop_device / terminal_session）
 * 2. 双向同构：ContextRef → contextRefsToBlocks → blockToContextRef 后
 *    type / resourceId / label / tabType / spaceId 完全一致
 * 3. 关键字段缺失时 return null（不让 ChatInput 渲染残缺 chip）
 *
 * 背景：原 ChatInput.tsx 内联实现仅识别 5 种历史 block type（table_selection /
 * doc_selection / code_file / code_selection / web_selection），新增的 6 种
 * tab 资源类型完全没处理 → 用户编辑历史消息或恢复草稿时 chip 全部丢失。
 */

import { describe, expect, it } from 'vitest'

import { BLOCK_TYPE_TO_REF, blockToContextRef } from '../blockToContextRef'
import { contextRefsToBlocks } from '../useContextInjection'
import { createContextRef, type ContextRef, type ContextRefType } from '../../types'

/**
 * 把 createContextRef 生成的 ref 中的随机 id 抹掉，便于断言核心字段。
 * createContextRef 会注入 `ref-${Date.now()}-${random}` 这样不可预测的 id。
 */
function stripVolatile(ref: ContextRef): Omit<ContextRef, 'id'> {
  const { id: _id, ...rest } = ref
  void _id
  return rest
}

describe('BLOCK_TYPE_TO_REF', () => {
  it('覆盖了历史 block type（含 field）与新增 tab 资源类型', () => {
    expect(BLOCK_TYPE_TO_REF).toMatchObject({
      table_selection: 'table_selection',
      field: 'field',
      doc_selection: 'doc_selection',
      code_file: 'code_file',
      code_selection: 'code_selection',
      web_selection: 'web_selection',
      web_annotation: 'web_annotation',
      webpage: 'webpage',
      memo: 'memo',
      whiteboard: 'whiteboard',
      phone_device: 'phone_device',
      desktop_device: 'desktop_device',
      terminal_session: 'terminal_session',
      tracker: 'tracker',
      agenda_event: 'agenda_event',
      mcp_server: 'mcp_server',
    })
  })

  it('web_annotation block 可恢复为 ContextRef', () => {
    const ref = blockToContextRef({
      type: 'web_annotation',
      preview: '选中文字',
      url: 'https://example.com',
      page_title: 'Example',
      tab_type: 'tabweb',
      selection: { kind: 'text', text: '选中文字' },
      rect: { x: 1, y: 2, width: 3, height: 4 },
      dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
      screenshot_attachment_id: 'browser-annotation-1',
      screenshot_filename: 'browser-annotation-1.png',
      content_snapshot: { text: '注释区域完整文本', truncated: true },
    })

    expect(stripVolatile(ref!)).toMatchObject({
      type: 'web_annotation',
      resourceId: 'https://example.com',
      label: '选中文字',
      tabType: 'tabweb',
      meta: expect.objectContaining({
        pageTitle: 'Example',
        selection: { kind: 'text', text: '选中文字' },
        rect: { x: 1, y: 2, width: 3, height: 4 },
        dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
        screenshotAttachmentId: 'browser-annotation-1',
        screenshotFilename: 'browser-annotation-1.png',
        // ：内容快照随 block 往返不丢失
        contentSnapshot: { text: '注释区域完整文本', truncated: true },
      }),
    })
  })

  it('未知 block type 返回 null', () => {
    expect(blockToContextRef({ type: 'mystery_type', preview: 'x' })).toBeNull()
  })

  it('block.type 缺失时返回 null', () => {
    expect(blockToContextRef({ preview: 'x' })).toBeNull()
  })
})

/**
 * contextRefsToBlocks 正向字段映射 —— 锁定每种 type 输出的关键字段名，
 * 必须与后端 _TAB_RESOURCE_ID_FIELDS（context_resolver.py）严格对齐。
 *
 * 对应的字段约定（命名分歧一旦回归，后端 resolver 就解析不出资源 ID，
 * Agent 调工具时拿到错误参数）：
 *   - webpage           → url
 *   - memo              → memo_id
 *   - whiteboard        → canvas_id
 *   - phone_device      → device_id (+ device_name?)
 *   - desktop_device    → device_id (+ device_name?)
 *   - terminal_session  → session_id (+ cwd?)
 *   - tracker           → tracker_id
 *   - agenda_event      → event_id
 *   - slide             → slide_id
 *   - video             → video_id
 *   - site              → site_id
 *   - folder            → folder_path (+ folder_kind?)
 *   - file              → file_id
 */
describe('contextRefsToBlocks → block 字段映射（正向）', () => {
  function blockOf(ref: ContextRef) {
    const [block] = contextRefsToBlocks([ref])
    return block
  }

  it('webpage：包含 type / url / page_title / favicon', () => {
    const block = blockOf(
      createContextRef('webpage', 'https://google.com', 'Google', {
        meta: { pageTitle: 'Google', favicon: 'https://google.com/favicon.ico' },
      }),
    )
    expect(block).toMatchObject({
      type: 'webpage',
      url: 'https://google.com',
      page_title: 'Google',
      favicon: 'https://google.com/favicon.ico',
    })
  })

  it('memo：包含 type / memo_id', () => {
    const block = blockOf(createContextRef('memo', 'memo_abc', '周报'))
    expect(block).toMatchObject({ type: 'memo', memo_id: 'memo_abc' })
  })

  it('whiteboard：包含 type / canvas_id', () => {
    const block = blockOf(createContextRef('whiteboard', 'canvas_x', '架构图'))
    expect(block).toMatchObject({ type: 'whiteboard', canvas_id: 'canvas_x' })
  })

  it('phone_device：包含 type / device_id / device_name', () => {
    const block = blockOf(
      createContextRef('phone_device', 'dev_p', 'iPhone 15', {
        meta: { deviceName: 'iPhone 15' },
      }),
    )
    expect(block).toMatchObject({
      type: 'phone_device',
      device_id: 'dev_p',
      device_name: 'iPhone 15',
    })
  })

  it('desktop_device：包含 type / device_id / device_name', () => {
    const block = blockOf(
      createContextRef('desktop_device', 'dev_d', 'MBP', {
        meta: { deviceName: 'MBP M3' },
      }),
    )
    expect(block).toMatchObject({
      type: 'desktop_device',
      device_id: 'dev_d',
      device_name: 'MBP M3',
    })
  })

  it('terminal_session：包含 type / session_id / cwd', () => {
    const block = blockOf(
      createContextRef('terminal_session', 'sess_a', '/repo', {
        meta: { cwd: '/repo' },
      }),
    )
    expect(block).toMatchObject({
      type: 'terminal_session',
      session_id: 'sess_a',
      cwd: '/repo',
    })
  })

  it('tracker：包含 type / tracker_id', () => {
    const block = blockOf(createContextRef('tracker', 'trk_001', '迭代 W12'))
    expect(block).toMatchObject({ type: 'tracker', tracker_id: 'trk_001' })
  })

  it('agenda_event：包含 type / event_id', () => {
    const block = blockOf(createContextRef('agenda_event', 'evt_001', '周会'))
    expect(block).toMatchObject({ type: 'agenda_event', event_id: 'evt_001' })
  })

  it('slide：包含 type / slide_id', () => {
    const block = blockOf(createContextRef('slide', 'sld_001', 'Q4 OKR'))
    expect(block).toMatchObject({ type: 'slide', slide_id: 'sld_001' })
  })

  it('video：包含 type / video_id', () => {
    const block = blockOf(createContextRef('video', 'vid_001', 'Demo'))
    expect(block).toMatchObject({ type: 'video', video_id: 'vid_001' })
  })

  it('site：包含 type / site_id', () => {
    const block = blockOf(createContextRef('site', 'site_001', '官网'))
    expect(block).toMatchObject({ type: 'site', site_id: 'site_001' })
  })

  it('folder：包含 type / folder_path / folder_kind', () => {
    const block = blockOf(
      createContextRef('folder', '/Users/me/code', 'code', {
        meta: { kind: 'user' },
      }),
    )
    expect(block).toMatchObject({
      type: 'folder',
      folder_path: '/Users/me/code',
      folder_kind: 'user',
    })
  })

  it('file：包含 type / file_id（ 云盘文件引用不得丢资源 ID）', () => {
    const block = blockOf(
      createContextRef('file', '084aa15a-d224-4764-9c2f-f45c92026f05', 'CLAUDE.md', {
        spaceId: 'sp-agent',
        spaceName: '默认 Agent',
        tabType: 'file',
      }),
    )
    expect(block).toMatchObject({
      type: 'file',
      file_id: '084aa15a-d224-4764-9c2f-f45c92026f05',
      preview: 'CLAUDE.md',
      tab_type: 'file',
      space_id: 'sp-agent',
      space_name: '默认 Agent',
    })
  })

  it('mcp_server：connection_id 与 server_name 可双向恢复', () => {
    const original = createContextRef('mcp_server', 'conn-1', 'github', {
      meta: { serverName: 'github', sourceLabel: 'Manual' },
    })
    const block = blockOf(original)

    expect(block).toMatchObject({
      type: 'mcp_server',
      connection_id: 'conn-1',
      server_name: 'github',
      source_label: 'Manual',
    })
    expect(stripVolatile(blockToContextRef(block)!)).toMatchObject({
      type: 'mcp_server',
      resourceId: 'conn-1',
      label: 'github',
      meta: { serverName: 'github', sourceLabel: 'Manual' },
    })
  })

  it('tab_type 字段透传：ref.tabType=tabweb → block.tab_type=tabweb', () => {
    const block = blockOf(
      createContextRef('webpage', 'https://x.com', 'X', {
        tabType: 'tabweb',
        meta: { pageTitle: 'X' },
      }),
    )
    expect(block.tab_type).toBe('tabweb')
  })

  it('未声明 tabType 时不输出 tab_type 字段（保持 block 简洁）', () => {
    const block = blockOf(createContextRef('memo', 'memo_x', '笔记'))
    expect(block).not.toHaveProperty('tab_type')
  })
})

describe('blockToContextRef — 6 种 tab 资源类型还原', () => {
  it('webpage：从 block.url 还原 resourceId，meta 含 pageTitle / favicon', () => {
    const ref = blockToContextRef({
      type: 'webpage',
      preview: 'TabTin 官网',
      url: 'https://tabtin.ai',
      page_title: 'TabTin',
      favicon: 'https://tabtin.ai/favicon.ico',
      space_id: 'space-1',
      space_name: 'Space 1',
      tab_type: 'tabweb',
    })
    expect(ref).not.toBeNull()
    expect(ref).toMatchObject({
      type: 'webpage',
      resourceId: 'https://tabtin.ai',
      label: 'TabTin 官网',
      tabType: 'tabweb',
      spaceId: 'space-1',
      spaceName: 'Space 1',
      meta: {
        pageTitle: 'TabTin',
        favicon: 'https://tabtin.ai/favicon.ico',
      },
    })
  })

  it('webpage：缺 url → null', () => {
    expect(
      blockToContextRef({ type: 'webpage', preview: 'x', page_title: 'x' }),
    ).toBeNull()
  })

  it('memo：从 block.memo_id 还原', () => {
    const ref = blockToContextRef({
      type: 'memo',
      preview: '项目周报',
      memo_id: 'memo_abc123',
      tab_type: 'tabmemo',
    })
    expect(ref).toMatchObject({
      type: 'memo',
      resourceId: 'memo_abc123',
      label: '项目周报',
      tabType: 'tabmemo',
    })
  })

  it('file：从 block.file_id 还原', () => {
    const ref = blockToContextRef({
      type: 'file',
      preview: 'CLAUDE.md',
      file_id: 'file-uuid-001',
      tab_type: 'file',
      space_id: 'sp-agent',
    })
    expect(ref).toMatchObject({
      type: 'file',
      resourceId: 'file-uuid-001',
      label: 'CLAUDE.md',
      tabType: 'file',
      spaceId: 'sp-agent',
    })
  })

  it('file：缺 file_id → null（ 空引用不可还原）', () => {
    expect(
      blockToContextRef({ type: 'file', preview: 'CLAUDE.md', tab_type: 'file' }),
    ).toBeNull()
  })

  it('memo：缺 memo_id → null', () => {
    expect(blockToContextRef({ type: 'memo', preview: 'x' })).toBeNull()
  })

  it('whiteboard：从 block.canvas_id 还原', () => {
    const ref = blockToContextRef({
      type: 'whiteboard',
      preview: '架构图',
      canvas_id: 'canvas_xyz',
      tab_type: 'tabwhiteboard',
    })
    expect(ref).toMatchObject({
      type: 'whiteboard',
      resourceId: 'canvas_xyz',
      label: '架构图',
      tabType: 'tabwhiteboard',
    })
  })

  it('whiteboard：缺 canvas_id → null', () => {
    expect(blockToContextRef({ type: 'whiteboard', preview: 'x' })).toBeNull()
  })

  it('phone_device：从 block.device_id 还原，meta 含 deviceName', () => {
    const ref = blockToContextRef({
      type: 'phone_device',
      preview: 'iPhone 15',
      device_id: 'dev_iphone15',
      device_name: 'iPhone 15',
      tab_type: 'tabphone',
    })
    expect(ref).toMatchObject({
      type: 'phone_device',
      resourceId: 'dev_iphone15',
      label: 'iPhone 15',
      tabType: 'tabphone',
      meta: { deviceName: 'iPhone 15' },
    })
  })

  it('desktop_device：从 block.device_id 还原', () => {
    const ref = blockToContextRef({
      type: 'desktop_device',
      preview: 'MBP',
      device_id: 'dev_mbp',
      device_name: 'MBP',
    })
    expect(ref).toMatchObject({
      type: 'desktop_device',
      resourceId: 'dev_mbp',
      label: 'MBP',
      meta: { deviceName: 'MBP' },
    })
  })

  it('phone_device / desktop_device：缺 device_id → null', () => {
    expect(blockToContextRef({ type: 'phone_device', preview: 'x' })).toBeNull()
    expect(blockToContextRef({ type: 'desktop_device', preview: 'x' })).toBeNull()
  })

  it('terminal_session：从 block.session_id 还原，meta 含 cwd', () => {
    const ref = blockToContextRef({
      type: 'terminal_session',
      preview: '/home/user/project',
      session_id: 'sess_abc',
      cwd: '/home/user/project',
      tab_type: 'terminal',
    })
    expect(ref).toMatchObject({
      type: 'terminal_session',
      resourceId: 'sess_abc',
      label: '/home/user/project',
      tabType: 'terminal',
      meta: { cwd: '/home/user/project' },
    })
  })

  it('terminal_session：缺 session_id → null', () => {
    expect(
      blockToContextRef({ type: 'terminal_session', preview: 'x', cwd: '/tmp' }),
    ).toBeNull()
  })

  it('phone_device 缺 deviceName 仍能还原（meta 为 undefined）', () => {
    const ref = blockToContextRef({
      type: 'phone_device',
      preview: 'Anonymous',
      device_id: 'dev_only',
    })
    expect(ref).toMatchObject({
      type: 'phone_device',
      resourceId: 'dev_only',
      label: 'Anonymous',
    })
    expect(ref?.meta).toBeUndefined()
  })
})

describe('blockToContextRef — 历史 5 种 type 仍正常工作', () => {
  it('table_selection 仍按 table_id 还原', () => {
    const ref = blockToContextRef({
      type: 'table_selection',
      preview: '订单表',
      table_id: 'tbl_orders',
      record_ids: ['rec1', 'rec2'],
      field_ids: ['fld1'],
      space_id: 'space-1',
    })
    expect(ref).toMatchObject({
      type: 'table_selection',
      resourceId: 'tbl_orders',
      meta: { record_ids: ['rec1', 'rec2'], field_ids: ['fld1'] },
    })
  })

  it('field 保留 type=field，并用 field_ids + table_id 还原 ', () => {
    const ref = blockToContextRef({
      type: 'field',
      preview: '总分',
      table_id: 'tbl_scores',
      field_ids: ['fld_total'],
      space_id: 'space-1',
    })
    expect(ref).toMatchObject({
      type: 'field',
      resourceId: 'fld_total',
      label: '总分',
      spaceId: 'space-1',
      meta: { tableId: 'tbl_scores' },
    })
  })

  it('field 缺 table_id 或 field_id 时返回 null', () => {
    expect(
      blockToContextRef({
        type: 'field',
        preview: '总分',
        field_ids: ['fld_total'],
      }),
    ).toBeNull()
    expect(
      blockToContextRef({
        type: 'field',
        preview: '总分',
        table_id: 'tbl_scores',
      }),
    ).toBeNull()
  })

  it('code_file 仍按 file_path 还原，缺 file_path → null', () => {
    expect(
      blockToContextRef({ type: 'code_file', preview: 'x' }),
    ).toBeNull()
    expect(
      blockToContextRef({
        type: 'code_file',
        preview: 'x',
        file_path: '/a.ts',
        language: 'ts',
      }),
    ).toMatchObject({
      type: 'code_file',
      resourceId: '/a.ts',
      meta: { filePath: '/a.ts', language: 'ts' },
    })
  })

  it('code_file：preview 为文件原文时 label 用文件名、原文保留进 meta.preview', () => {
    const ref = blockToContextRef({
      type: 'code_file',
      file_path: '/Users/me/proj/README.md',
      preview: '<div align="center">\n[**简体中文**](README_zh_CN.md)\n</div>',
      language: 'markdown',
    })
    expect(ref).toMatchObject({
      type: 'code_file',
      resourceId: '/Users/me/proj/README.md',
      label: 'README.md',
      meta: {
        filePath: '/Users/me/proj/README.md',
        language: 'markdown',
        preview: '<div align="center">\n[**简体中文**](README_zh_CN.md)\n</div>',
      },
    })
    expect(ref?.label).not.toContain('<div')
  })

  it('web_selection 仍按 url 还原，缺 url → null', () => {
    expect(blockToContextRef({ type: 'web_selection', preview: 'x' })).toBeNull()
    expect(
      blockToContextRef({
        type: 'web_selection',
        preview: '段落',
        url: 'https://example.com',
        page_title: 'Example',
      }),
    ).toMatchObject({
      type: 'web_selection',
      resourceId: 'https://example.com',
      meta: { url: 'https://example.com', pageTitle: 'Example' },
    })
  })
})

/**
 * 双向同构：构造 ContextRef → contextRefsToBlocks → blockToContextRef →
 * 应该等价于原 ref 的核心字段（type / resourceId / label / tabType / spaceId）。
 *
 * 这是 blockToContextRef 与 contextRefsToBlocks 的契约：编辑/草稿恢复的
 * 用户体验依赖于这条等式成立。
 */
describe('blockToContextRef ↔ contextRefsToBlocks 双向同构', () => {
  function roundTrip(ref: ContextRef): Omit<ContextRef, 'id'> | null {
    const [block] = contextRefsToBlocks([ref])
    const restored = blockToContextRef(block)
    return restored ? stripVolatile(restored) : null
  }

  it('field 不退化成 table_selection，round-trip 保留 type/fieldId/tableId ', () => {
    const original = createContextRef('field', 'fld_total', '总分', {
      spaceId: 'space-1',
      meta: { tableId: 'tbl_scores' },
    })
    const [block] = contextRefsToBlocks([original])
    expect(block).toMatchObject({
      type: 'field',
      table_id: 'tbl_scores',
      field_ids: ['fld_total'],
    })
    expect(block.type).not.toBe('table_selection')

    const restored = roundTrip(original)
    expect(restored).toMatchObject({
      type: 'field',
      resourceId: 'fld_total',
      label: '总分',
      spaceId: 'space-1',
      meta: { tableId: 'tbl_scores' },
    })
  })

  function assertCoreFieldsEqual(original: ContextRef, restored: Omit<ContextRef, 'id'> | null) {
    expect(restored).not.toBeNull()
    expect(restored).toMatchObject({
      type: original.type,
      resourceId: original.resourceId,
      label: original.label,
    })
    if (original.tabType !== undefined) {
      expect(restored?.tabType).toBe(original.tabType)
    }
    if (original.spaceId !== undefined) {
      expect(restored?.spaceId).toBe(original.spaceId)
    }
  }

  const cases: Array<{ name: string; build: () => ContextRef }> = [
    {
      name: 'webpage',
      build: () =>
        createContextRef('webpage', 'https://tabtin.ai', 'TabTin', {
          spaceId: 'sp1',
          spaceName: 'SP1',
          tabType: 'tabweb',
          meta: { pageTitle: 'TabTin', favicon: 'https://tabtin.ai/favicon.ico' },
        }),
    },
    {
      name: 'memo',
      build: () =>
        createContextRef('memo', 'memo_xx', '周报', {
          spaceId: 'sp1',
          tabType: 'tabmemo',
        }),
    },
    {
      name: 'whiteboard',
      build: () =>
        createContextRef('whiteboard', 'canvas_xx', '架构图', {
          spaceId: 'sp1',
          tabType: 'tabwhiteboard',
        }),
    },
    {
      name: 'phone_device',
      build: () =>
        createContextRef('phone_device', 'dev_p', 'iPhone', {
          spaceId: 'sp1',
          tabType: 'tabphone',
          meta: { deviceName: 'iPhone 15' },
        }),
    },
    {
      name: 'desktop_device',
      build: () =>
        createContextRef('desktop_device', 'dev_d', 'MBP', {
          spaceId: 'sp1',
          tabType: 'tabdesktop',
          meta: { deviceName: 'MBP M3' },
        }),
    },
    {
      name: 'terminal_session',
      build: () =>
        createContextRef('terminal_session', 'sess_x', '/repo', {
          spaceId: 'sp1',
          tabType: 'terminal',
          meta: { cwd: '/repo' },
        }),
    },
    {
      name: 'tracker',
      build: () =>
        createContextRef('tracker', 'trk_001', '迭代 W12', {
          spaceId: 'sp1',
          tabType: 'tabtracker',
        }),
    },
    {
      name: 'web_selection（旧类型回归）',
      build: () =>
        createContextRef('web_selection', 'https://ex.com', '段落', {
          spaceId: 'sp1',
          meta: { url: 'https://ex.com', pageTitle: 'Ex' },
        }),
    },
    {
      name: 'code_file（旧类型回归）',
      build: () =>
        createContextRef('code_file', '/a.ts', 'a.ts', {
          spaceId: 'sp1',
          meta: { filePath: '/a.ts', rootPath: '/', language: 'ts' },
        }),
    },
  ]

  for (const c of cases) {
    it(`${c.name} 经过一次 ref→block→ref 后核心字段保持一致`, () => {
      const original = c.build()
      const restored = roundTrip(original)
      assertCoreFieldsEqual(original, restored)
    })
  }

  it('webpage 经一次 round-trip 后 meta.pageTitle / favicon 仍保留', () => {
    const original = createContextRef('webpage', 'https://x.com', 'X', {
      meta: { pageTitle: 'X 标题', favicon: 'https://x.com/f.ico' },
    })
    const restored = roundTrip(original)
    expect(restored?.meta).toMatchObject({
      pageTitle: 'X 标题',
      favicon: 'https://x.com/f.ico',
    })
  })

  it('terminal_session 经一次 round-trip 后 meta.cwd 仍保留', () => {
    const original = createContextRef('terminal_session', 'sess', '/repo', {
      meta: { cwd: '/repo' },
    })
    const restored = roundTrip(original)
    expect(restored?.meta).toMatchObject({ cwd: '/repo' })
  })

  /**
   * 抽样确认：每种「整个 tab 资源引用」类型都应被 BLOCK_TYPE_TO_REF 收录，
   * 否则 round-trip 会断（无映射 → blockToContextRef 直接返回 null，
   * 历史消息恢复时 chip 丢失）。
   */
  it.each<ContextRefType>([
    'webpage',
    'memo',
    'whiteboard',
    'phone_device',
    'desktop_device',
    'terminal_session',
    'tracker',
    'agenda_event',
  ])('%s 在 BLOCK_TYPE_TO_REF 中有同名映射', (type) => {
    expect(BLOCK_TYPE_TO_REF[type]).toBe(type)
  })

  // 资源池 mention 类（slide / video / site / folder）已补 BLOCK_TYPE_TO_REF + 反序列化分支
  // —— 见 blockToContextRef.ts 底部的 if 链。下面用 round-trip 钉死。
  it.each(['slide', 'video', 'site', 'folder'] as const)(
    '%s 在 BLOCK_TYPE_TO_REF 中有同名映射',
    (type) => {
      expect(BLOCK_TYPE_TO_REF[type]).toBe(type)
    },
  )

  it('slide round-trip：type / resourceId 一致', () => {
    const original = createContextRef('slide', 'sld_001', 'Q4 OKR')
    const block = contextRefsToBlocks([original])[0]
    const restored = blockToContextRef(block)
    expect(restored).not.toBeNull()
    expect(restored!.type).toBe('slide')
    expect(restored!.resourceId).toBe('sld_001')
  })

  it('video round-trip：type / resourceId 一致', () => {
    const original = createContextRef('video', 'vid_001', 'Demo')
    const block = contextRefsToBlocks([original])[0]
    const restored = blockToContextRef(block)
    expect(restored).not.toBeNull()
    expect(restored!.type).toBe('video')
    expect(restored!.resourceId).toBe('vid_001')
  })

  it('site round-trip：type / resourceId 一致', () => {
    const original = createContextRef('site', 'site_001', '官网')
    const block = contextRefsToBlocks([original])[0]
    const restored = blockToContextRef(block)
    expect(restored).not.toBeNull()
    expect(restored!.type).toBe('site')
    expect(restored!.resourceId).toBe('site_001')
  })

  it('folder round-trip：type / resourceId / kind 一致', () => {
    const original = createContextRef('folder', '/Users/me/code', 'code', {
      meta: { kind: 'user' },
    })
    const block = contextRefsToBlocks([original])[0]
    const restored = blockToContextRef(block)
    expect(restored).not.toBeNull()
    expect(restored!.type).toBe('folder')
    expect(restored!.resourceId).toBe('/Users/me/code')
    expect(restored!.meta?.kind).toBe('user')
  })

  it('file 在 BLOCK_TYPE_TO_REF 中有同名映射', () => {
    expect(BLOCK_TYPE_TO_REF.file).toBe('file')
  })

  it('file round-trip：type / resourceId / space 字段一致', () => {
    const original = createContextRef('file', 'file-uuid-001', 'CLAUDE.md', {
      spaceId: 'sp1',
      spaceName: '默认 Agent',
      tabType: 'file',
    })
    const block = contextRefsToBlocks([original])[0]
    expect(block.file_id).toBe('file-uuid-001')
    const restored = blockToContextRef(block)
    expect(restored).not.toBeNull()
    expect(restored!.type).toBe('file')
    expect(restored!.resourceId).toBe('file-uuid-001')
    expect(restored!.label).toBe('CLAUDE.md')
    expect(restored!.spaceId).toBe('sp1')
    expect(restored!.tabType).toBe('file')
  })

  it('web_annotation round-trip：content_snapshot 不丢失', () => {
    const original = createContextRef('web_annotation', 'https://example.com/', '注释', {
      tabType: 'tabweb',
      meta: {
        url: 'https://example.com/',
        pageTitle: 'Example',
        selection: { kind: 'element', text: '评论内容' },
        contentSnapshot: { text: '评论 1 评论 2 评论 3', truncated: false },
      },
    })
    const [block] = contextRefsToBlocks([original])
    expect(block.content_snapshot).toEqual({ text: '评论 1 评论 2 评论 3', truncated: false })
    const restored = blockToContextRef(block)
    expect(restored).not.toBeNull()
    expect(restored!.meta?.contentSnapshot).toEqual({ text: '评论 1 评论 2 评论 3', truncated: false })
  })

  it('conversation_reference round-trip：session_id / raw_block 一致', () => {
    const rawBlock = '<conversation_reference>\n标题：演示\n</conversation_reference>'
    const original = createContextRef('conversation_reference', 'sess-ref-1', '演示对话', {
      meta: { rawBlock, preview: '你好', messageCount: 3 },
    })
    const block = contextRefsToBlocks([original])[0]
    expect(block.type).toBe('conversation_reference')
    expect(block.session_id).toBe('sess-ref-1')
    expect(block.raw_block).toBe(rawBlock)
    const restored = blockToContextRef(block)
    expect(restored).not.toBeNull()
    expect(restored!.type).toBe('conversation_reference')
    expect(restored!.resourceId).toBe('sess-ref-1')
    expect(restored!.meta?.rawBlock).toBe(rawBlock)
    expect(restored!.meta?.messageCount).toBe(3)
  })
})
