import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  buildPriorTurnArtifactsByEndIndex,
  buildTurnArtifactsByEndIndex,
  collectSessionArtifacts,
  collectTurnArtifacts,
  getTurnEndIndex,
  getTurnMessageWindow,
  isTurnEndSlot,
  resolveToolEventResult,
  type SessionToolResultResolver,
} from '../turnArtifacts'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content' | 'created_at'>): ChatMessage {
  const base = {
    message_kind: partial.role === 'assistant' ? 'llm' : undefined,
    ...partial,
  } as ChatMessage
  // ：轮次产物读运行时 SSoT message.blocks（生产由入口反序列化灌入）。测试从
  // content_blocks_json 派生 finalized entries 模拟 ingress。
  if (base.blocks === undefined && Array.isArray(base.content_blocks_json)) {
    base.blocks = base.content_blocks_json.map((block, index) => ({
      index,
      block_id: `b-${base.id}-${index}`,
      block,
      finalized: true,
      partial: false,
    })) as never
  }
  return base
}

describe('collectTurnArtifacts', () => {
  it('returns empty when turn has no artifacts', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'hi', created_at: '2026-01-01T00:00:00Z' }),
      msg({ id: 'a1', role: 'assistant', content: 'hello', created_at: '2026-01-01T00:00:01Z', agent_run_id: 'run-1' }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('extracts local file from tool_artifact rich content', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'file',
          summary: 'report.xlsx',
          payload: {
            artifact_kind: 'local_file',
            filename: 'report.xlsx',
            relative_path: 'outputs/report.xlsx',
          },
        }],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('file')
    expect(artifacts[0]?.title).toBe('report.xlsx')
    expect(artifacts[0]?.href).toContain('outputs%2Freport.xlsx')
  })

  it('extracts show_widget as widget turn artifact', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'widget',
          summary: '系统架构图',
          payload: {
            widget_id: 'wid-42',
            format: 'svg',
            code: '<svg viewBox="0 0 10 10"><circle r="5"/></svg>',
            title: '架构图',
          },
        }],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      kind: 'widget',
      title: '架构图',
      widgetId: 'wid-42',
      sourceMessageId: 'a1',
      subtitleKey: 'previewWidget',
    })
    expect(artifacts[0]?.href).toBe('tabtin://chat/widget/wid-42')
  })

  it('skips pending widget placeholders in turn artifacts', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'widget',
          summary: '生成中',
          payload: {
            widget_id: 'pending:tc-9',
            format: 'svg',
          },
        }],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('excludes present_to_user resource_ref from turn artifacts', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '已打开文档',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:02Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'resource_ref',
          summary: '季度计划',
          group_id: 'present_to_user_123_abc',
          payload: {
            resource_type: 'doc',
            resource_id: 'doc-1',
            resource_name: '季度计划',
            auto_open: true,
            auto_open_token: 'present-abc123-xyz',
          },
        }],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('excludes present_to_user file/image/table_preview without local_file mark', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tabtin_rich_content',
            kind: 'file',
            summary: '外部 PDF',
            group_id: 'present_to_user_1_x',
            payload: {
              filename: 'report.pdf',
              url: 'https://cdn.example.com/report.pdf',
            },
          },
          {
            type: 'tabtin_rich_content',
            kind: 'image',
            summary: '截图',
            group_id: 'present_to_user_1_x',
            payload: {
              url: 'https://cdn.example.com/shot.png',
              alt_text: '截图',
            },
          },
          {
            type: 'tabtin_rich_content',
            kind: 'table_preview',
            summary: '预览表',
            group_id: 'present_to_user_1_x',
            payload: {
              title: '预览表',
              resource_type: 'table',
              resource_id: 'tbl-1',
              columns: ['a'],
              rows: [['1']],
            },
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('keeps oss_file delivery artifact in turn card ', () => {
    const fileId = '550e8400-e29b-41d4-a716-446655440000'
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '上传好了',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:02Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'file',
          summary: 'chart.png',
          payload: {
            artifact_kind: 'oss_file',
            file_id: fileId,
            filename: 'chart.png',
            url: `tabtin://resource/file/${fileId}?hint=tabfiles&title=chart.png`,
            access_url: 'https://cdn.example.com/chart.png',
            mime_type: 'image/png',
          },
        }],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      kind: 'file',
      title: 'chart.png',
    })
    expect(artifacts[0].href).toContain(fileId)
    expect(artifacts[0].href).toContain('hint=tabfiles')
  })

  it('keeps local_file when mixed with present_to_user resource_ref in same turn', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '写好了',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:02Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'file',
          summary: 'report.xlsx',
          payload: {
            artifact_kind: 'local_file',
            filename: 'report.xlsx',
            relative_path: 'outputs/report.xlsx',
          },
        }],
      }),
      msg({
        id: 'a3',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:03Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'resource_ref',
          summary: '已有文档',
          group_id: 'present_to_user_9_z',
          payload: {
            resource_type: 'doc',
            resource_id: 'doc-9',
            resource_name: '已有文档',
            auto_open_token: 'present-tok-1',
          },
        }],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('file')
    expect(artifacts[0]?.title).toBe('report.xlsx')
  })

  it('excludes resource_ref even without present_to_user group_id prefix', () => {
    // 历史消息可能缺 group_id；resource_ref 本身就是展示通道，不应进产物卡
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'resource_ref',
          summary: '表格',
          payload: {
            resource_type: 'table',
            resource_id: 'tbl-legacy',
            resource_name: '表格',
          },
        }],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('extracts tabtin resource links from assistant text', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '已创建 [季度计划](tabtin://resource/tabdoc/doc-1?hint=tabdoc)',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('doc')
    expect(artifacts[0]?.title).toBe('季度计划')
    expect(artifacts[0]?.href).toBe('tabtin://resource/tabdoc/doc-1?hint=tabdoc')
  })

  it.each(['tabtin-preprod', 'tabtin-dev'])(
    'extracts %s TabData record links from assistant text',
    (scheme) => {
      const href = `${scheme}://resource/table/tbl_env?hint=tabdata&recordIds=rec_1`
      const turn = [
        msg({ id: 'u1', role: 'user', content: 'create', created_at: '2026-01-01T00:00:00Z' }),
        msg({
          id: 'a1',
          role: 'assistant',
          content: `[record](${href})`,
          created_at: '2026-01-01T00:00:01Z',
          agent_run_id: 'run-1',
        }),
      ]
      const artifacts = collectTurnArtifacts(turn)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]?.href).toBe(href)
    },
  )

  it('drops resource links with ellipsis-truncated ids ()', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: [
          '已创建 [有待发货订单](tabtin://resource/document/02eda024-5f11-4d4a-85c2-9a1b3c5d7e90?hint=tabdoc)',
          '文档 ID：tabtin://resource/document/02eda024-5f11-4d4a-85c2-…?hint=tabdoc',
          '另见 [截断](tabtin://resource/document/ad070d7b-...?hint=tabdoc)',
        ].join('\n'),
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('有待发货订单')
    expect(artifacts[0]?.href).toBe('tabtin://resource/document/02eda024-5f11-4d4a-85c2-9a1b3c5d7e90?hint=tabdoc')
  })

  it('keeps file resource links whose path contains ASCII dots', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '[备份](tabtin://resource/file/outputs%2Fdata...bak.txt?hint=tabfiles)',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('备份')
  })

  // ：Shadow Git diff_summary ≠ Agent 交付物。
  // canary / 外部进程 / 轮前已存在文件也会进 checkpoint，不能单独触发「本轮产物」。
  it('ignores diff_summary alone even with added canary files ', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '我可以帮你用 grep，请告诉我关键词？',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        diff_summary: {
          changed: 2,
          insertions: 339,
          deletions: 0,
          files: [
            {
              file: 'artifacts/complex-tracker-canary-report.md',
              changes: 0, insertions: 196, deletions: 0, binary: false,
              status: 'added' as const,
            },
            {
              file: 'workspace/complex-tracker-canary-report.md',
              changes: 0, insertions: 143, deletions: 0, binary: false,
              status: 'added' as const,
            },
          ],
        },
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('ignores diff_summary alone for text / binary / deleted entries ', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: 'done',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        diff_summary: {
          changed: 3,
          insertions: 3,
          deletions: 2,
          files: [
            { file: 'src/app.ts', changes: 3, insertions: 3, deletions: 0, binary: false },
            { file: 'assets/logo.png', changes: 0, insertions: 0, deletions: 0, binary: true },
            {
              file: 'artifacts/report.xlsx',
              changes: 0, insertions: 0, deletions: 0, binary: true,
              status: 'added' as const,
            },
            {
              file: 'artifacts/old.xlsx',
              changes: 0, insertions: 0, deletions: 0, binary: true,
              status: 'deleted' as const,
            },
          ],
        },
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('keeps write_file artifact and still ignores unrelated diff_summary files ', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        diff_summary: {
          changed: 2,
          insertions: 10,
          deletions: 0,
          files: [
            { file: 'reports/report.md', changes: 5, insertions: 5, deletions: 0, binary: false },
            {
              file: 'artifacts/complex-tracker-canary-report.md',
              changes: 0, insertions: 5, deletions: 0, binary: false,
              status: 'added' as const,
            },
          ],
        },
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_write',
            name: 'write_file',
            input: { path: 'reports/report.md' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_write',
            content: JSON.stringify({ success: true }),
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('report.md')
    expect(artifacts[0]?.href).toContain('reports%2Freport.md')
  })

  it('keeps resource link when diff_summary also present ', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '[app.ts](tabtin://resource/file/src%2Fapp.ts?hint=tabfiles)',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        diff_summary: {
          changed: 1,
          insertions: 1,
          deletions: 0,
          files: [{ file: 'src/app.ts', changes: 1, insertions: 1, deletions: 0, binary: false }],
        },
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('app.ts')
  })

  it('strips trailing quote from bare tabtin:// resource URI in assistant text ', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '已生成 tabtin://resource/file/245TES.f30280.m4a"。请查收',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('245TES.f30280.m4a')
    expect(artifacts[0]?.href).toContain('245TES.f30280.m4a')
    expect(artifacts[0]?.href).not.toContain('%22')
    expect(artifacts[0]?.href).not.toMatch(/m4a"$/)
  })

  it('strips trailing quote from write_file path before入卡 ', () => {
    const okResult = JSON.stringify({ success: true })
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_write_quoted',
            name: 'write_file',
            input: { path: 'audio/245TES.f30280.m4a"' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_write_quoted',
            content: okResult,
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('245TES.f30280.m4a')
    expect(artifacts[0]?.href).toContain(encodeURIComponent('audio/245TES.f30280.m4a'))
    expect(artifacts[0]?.href).not.toContain('%22')
  })

  it('strips trailing quote from local_file rich payload filename/path ', () => {
    const turn = [
      msg({
        id: 'ta1',
        role: 'assistant',
        message_kind: 'tool_artifact',
        content: '',
        created_at: '2026-01-01T00:00:02Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tabtin_rich_content',
            kind: 'file',
            payload: {
              artifact_kind: 'local_file',
              filename: '245TES.f30280.m4a"',
              relative_path: '245TES.f30280.m4a"',
              url: 'tabtin://resource/file/245TES.f30280.m4a%22?hint=tabfiles',
            },
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('245TES.f30280.m4a')
    expect(artifacts[0]?.href).toContain(encodeURIComponent('245TES.f30280.m4a'))
    expect(artifacts[0]?.href).not.toContain('%22')
  })

  it('extracts workspace-relative write_file path; skips absolute path (preview rejects it)', () => {
    const okResult = JSON.stringify({ success: true })
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_write_rel',
            name: 'write_file',
            input: { path: 'reports/report.md' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_write_rel',
            content: okResult,
          },
          {
            type: 'tool_use',
            id: 'tu_write_abs',
            name: 'write_file',
            input: { path: '/tmp/scratch.md' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_write_abs',
            content: okResult,
          },
          {
            type: 'tool_use',
            id: 'tu_write_escape',
            name: 'write_file',
            input: { path: '../outside.md' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_write_escape',
            content: okResult,
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('file')
    expect(artifacts[0]?.title).toBe('report.md')
    expect(artifacts[0]?.href).toContain('reports%2Freport.md')
  })

  it('extracts edit_file tool_use path as file artifact', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_edit',
            name: 'edit_file',
            input: { path: 'src/app.ts' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_edit',
            content: JSON.stringify({ success: true }),
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('file')
    expect(artifacts[0]?.title).toBe('app.ts')
    expect(artifacts[0]?.href).toContain('src%2Fapp.ts')
  })

  // ：失败 / 未完成的 write_file 不入「本轮产物」
  it('skips write_file when paired tool_result is_error', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_write_err',
            name: 'write_file',
            input: { path: 'reports/fail.md' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_write_err',
            is_error: true,
            content: JSON.stringify({
              success: false,
              error_code: 'PERMISSION_DENIED',
              error: 'permission denied',
            }),
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('skips write_file when result content has success:false', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_write_fail',
            name: 'write_file',
            input: { path: 'reports/fail.md' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_write_fail',
            content: JSON.stringify({
              success: false,
              error_code: 'STALE_READ',
              error: 'file changed since read',
            }),
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('skips write_file when tool_use has no paired tool_result', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tool_use',
          id: 'tu_write_pending',
          name: 'write_file',
          input: { path: 'reports/pending.md' },
        }],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('extracts edit_file with successful tool_result as file artifact', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_edit_ok',
            name: 'edit_file',
            input: { path: 'lib/util.ts' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_edit_ok',
            content: JSON.stringify({ success: true }),
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('file')
    expect(artifacts[0]?.title).toBe('util.ts')
    expect(artifacts[0]?.href).toContain('lib%2Futil.ts')
  })

  it('collects created file from run_terminal_command file_history paths (hdiutil dmg)', () => {
    const outerContent = JSON.stringify({
      status: 'completed',
      exit_code: 0,
      stdout: 'created: /Users/me/space/artifacts/test.dmg\n',
      file_history: {
        status: 'degraded',
        tracked_count: 1,
        changed_count: 1,
        created_untracked_count: 1,
        deleted_count: 0,
        modified_count: 0,
        created_paths: ['artifacts/test.dmg'],
        scan_truncated: false,
        scan_failed: false,
        track_failed_count: 0,
        degraded: true,
        degraded_reason: 'created_files',
      },
    })
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_dmg',
            name: 'run_terminal_command',
            input: { command: 'hdiutil create -volname "Test" -srcfolder /tmp/x -ov -format UDZO artifacts/test.dmg' },
          },
          { type: 'tool_result', tool_use_id: 'tu_dmg', content: outerContent },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('file')
    expect(artifacts[0]?.title).toBe('test.dmg')
    expect(artifacts[0]?.href).toContain(encodeURIComponent('artifacts/test.dmg'))
  })

  it('collects modified file from file_history (hdiutil -ov overwrite, session 9813c44b)', () => {
    const outerContent = JSON.stringify({
      status: 'completed',
      exit_code: 0,
      stdout: 'created: /Users/me/space/test.dmg\n',
      file_history: {
        status: 'complete',
        tracked_count: 2,
        changed_count: 1,
        created_untracked_count: 0,
        deleted_count: 0,
        modified_count: 1,
        modified_paths: ['test.dmg'],
        scan_truncated: false,
        scan_failed: false,
        track_failed_count: 0,
        degraded: false,
      },
    })
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_ov',
            name: 'run_terminal_command',
            input: { command: 'hdiutil create -volname "TestDisk" -srcfolder /tmp/c -ov -format UDZO test.dmg' },
          },
          { type: 'tool_result', tool_use_id: 'tu_ov', content: outerContent },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('test.dmg')
  })

  it('dedupes file_history path against create_file local_file rich block in same turn', () => {
    const shellContent = JSON.stringify({
      status: 'completed',
      exit_code: 0,
      stdout: '',
      file_history: {
        status: 'degraded',
        tracked_count: 0,
        changed_count: 1,
        created_untracked_count: 1,
        deleted_count: 0,
        modified_count: 0,
        created_paths: ['artifacts/TabTin.dmg'],
        scan_truncated: false,
        scan_failed: false,
        track_failed_count: 0,
        degraded: true,
        degraded_reason: 'created_files',
      },
    })
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_shell',
            name: 'run_terminal_command',
            input: { command: 'hdiutil create ... artifacts/TabTin.dmg' },
          },
          { type: 'tool_result', tool_use_id: 'tu_shell', content: shellContent },
        ],
      }),
      msg({
        id: 'art1',
        role: 'assistant',
        message_kind: 'tool_artifact',
        content: '',
        created_at: '2026-01-01T00:00:02Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tabtin_rich_content',
            kind: 'file',
            summary: 'TabTin.dmg',
            payload: {
              artifact_kind: 'local_file',
              file_type: 'dmg',
              relative_path: 'artifacts/TabTin.dmg',
              filename: 'TabTin.dmg',
            },
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('TabTin.dmg')
  })

  it('skips file_history paths on non-zero exit / temp / hidden / extensionless', () => {
    const mkTurn = (exitCode: number, paths: string[]) => [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_x',
            name: 'run_terminal_command',
            input: { command: 'some-command' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_x',
            content: JSON.stringify({
              status: 'completed',
              exit_code: exitCode,
              stdout: '',
              file_history: {
                status: 'degraded',
                tracked_count: 0,
                changed_count: paths.length,
                created_untracked_count: paths.length,
                deleted_count: 0,
                modified_count: 0,
                created_paths: paths,
                scan_truncated: false,
                scan_failed: false,
                track_failed_count: 0,
                degraded: true,
                degraded_reason: 'created_files',
              },
            }),
          },
        ],
      }),
    ]

    // exit != 0：产出不可信，不入卡
    expect(collectTurnArtifacts(mkTurn(1, ['artifacts/fail.dmg']))).toEqual([])
    // 临时目录首段 / 隐藏段 / 无扩展名：过程产物，不入卡
    expect(collectTurnArtifacts(mkTurn(0, ['tmp/scratch.dmg']))).toEqual([])
    expect(collectTurnArtifacts(mkTurn(0, ['.agent-drafts/draft.md']))).toEqual([])
    expect(collectTurnArtifacts(mkTurn(0, ['bin/tool']))).toEqual([])
    // 混合：只留交付物
    const mixed = collectTurnArtifacts(
      mkTurn(0, ['tmp/x.txt', 'artifacts/ok.pdf', '.hidden/y.md', 'noext']),
    )
    expect(mixed).toHaveLength(1)
    expect(mixed[0]?.title).toBe('ok.pdf')
  })

  it('handles historical tool_result without file_history paths (no crash, no card)', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_old',
            name: 'run_terminal_command',
            input: { command: 'ls -la' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_old',
            content: JSON.stringify({
              status: 'completed',
              exit_code: 0,
              stdout: 'total 0\n',
              file_history: {
                status: 'complete',
                tracked_count: 2,
                changed_count: 0,
                created_untracked_count: 0,
                deleted_count: 0,
                modified_count: 0,
                scan_truncated: false,
                scan_failed: false,
                track_failed_count: 0,
                degraded: false,
              },
            }),
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('collects file_history path behind approval_note prefix ( receipt)', () => {
    const inner = JSON.stringify({
      status: 'completed',
      exit_code: 0,
      stdout: '',
      file_history: {
        status: 'degraded',
        tracked_count: 0,
        changed_count: 1,
        created_untracked_count: 1,
        deleted_count: 0,
        modified_count: 0,
        created_paths: ['artifacts/approved.dmg'],
        scan_truncated: false,
        scan_failed: false,
        track_failed_count: 0,
        degraded: true,
        degraded_reason: 'created_files',
      },
    })
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_appr',
            name: 'run_terminal_command',
            input: { command: 'hdiutil create ... artifacts/approved.dmg' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_appr',
            content: `<approval_note>\nUser approved tool 'run_terminal_command'.\n</approval_note>\n\n${inner}`,
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('approved.dmg')
  })

  // ：不再 scrape stdout；doc/table 只靠 host platform_resource rich
  it('does not scrape doc/table from run_terminal_command stdout alone ', () => {
    const docStdout = JSON.stringify({
      data: { document: { id: '0b9d9e3a-doc-id', title: '功能测试报告' } },
    })
    const tableStdout = [
      'data: {"table":{"id":"a1b2c3d4-1111-2222-3333-444455556666","name":"客户名单","space_id":"space-demo-1"}}',
      'ok: true',
      '',
    ].join('\n')
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_doc',
            name: 'run_terminal_command',
            input: { command: 'tabtin doc create --title "功能测试报告"' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_doc',
            content: JSON.stringify({ status: 'completed', exit_code: 0, stdout: docStdout }),
          },
          {
            type: 'tool_use',
            id: 'tu_table',
            name: 'run_terminal_command',
            input: { command: 'tabtin table create --name "客户名单"' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_table',
            content: JSON.stringify({ status: 'completed', exit_code: 0, stdout: tableStdout }),
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('accepts exitCode/success outer variants for file_history (terminal result shape drift)', () => {
    const mk = (outer: Record<string, unknown>, useId: string) => msg({
      id: `m-${useId}`,
      role: 'assistant',
      content: '',
      created_at: '2026-01-01T00:00:01Z',
      agent_run_id: 'run-1',
      content_blocks_json: [
        { type: 'tool_use', id: useId, name: 'run_terminal_command', input: { command: 'hdiutil create x.dmg' } },
        {
          type: 'tool_result',
          tool_use_id: useId,
          content: JSON.stringify({
            ...outer,
            stdout: '',
            file_history: { created_paths: ['artifacts/shape.dmg'] },
          }),
        },
      ],
    })
    expect(collectTurnArtifacts([mk({ exitCode: 0 }, 'tu_camel')])).toHaveLength(1)
    expect(collectTurnArtifacts([mk({ success: true }, 'tu_success')])).toHaveLength(1)
    expect(collectTurnArtifacts([mk({ exitCode: 1 }, 'tu_fail')])).toEqual([])
  })

  it('does not mis-pair adjacent tool_result belonging to another tool_use', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_shell', name: 'run_terminal_command', input: { command: 'hdiutil create x.dmg' } },
          {
            type: 'tool_result',
            tool_use_id: 'tu_other',
            content: JSON.stringify({
              status: 'completed',
              exit_code: 0,
              stdout: '',
              file_history: { created_paths: ['artifacts/wrong.dmg'] },
            }),
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('silently skips malformed run_terminal_command tool_result', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_bad',
            name: 'run_terminal_command',
            input: { command: 'hdiutil create x.dmg' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_bad',
            content: 'not-json',
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('collectSessionArtifacts aggregates and dedupes across turns', () => {
    const okResult = JSON.stringify({ success: true })
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'write_file',
            input: { path: 'out/a.md' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: okResult,
          },
        ],
      }),
      msg({ id: 'u2', role: 'user', content: 'next', created_at: '2026-01-01T00:00:02Z' }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '[a.md](tabtin://resource/file/out%2Fa.md?hint=tabfiles)',
        created_at: '2026-01-01T00:00:03Z',
        agent_run_id: 'run-2',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'write_file',
            input: { path: 'out/b.md' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu2',
            content: okResult,
          },
        ],
      }),
    ]
    const session = collectSessionArtifacts(messages)
    expect(session).toHaveLength(2)
    expect(session.map(a => a.title).sort()).toEqual(['a.md', 'b.md'])

    // 历史产物：第 2 轮末只含第 1 轮；第 1 轮末为空；不含「整会话」的后续轮
    const priorByEnd = buildPriorTurnArtifactsByEndIndex(messages)
    expect(priorByEnd.get(1)?.map(a => a.title)).toEqual([])
    expect(priorByEnd.get(3)?.map(a => a.title)).toEqual(['a.md'])
    expect(priorByEnd.get(3)?.map(a => a.title)).not.toContain('b.md')
  })
})

describe('turn boundary helpers', () => {
  it('includes trailing tool_artifact in turn window and end slot', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({ id: 'a1', role: 'assistant', content: 'ok', created_at: '2026-01-01T00:00:01Z', agent_run_id: 'run-1' }),
      msg({
        id: 't1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:02Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'file',
          summary: 'out.txt',
          payload: { artifact_kind: 'local_file', filename: 'out.txt', relative_path: 'out.txt' },
        }],
      }),
      msg({ id: 'u2', role: 'user', content: 'next', created_at: '2026-01-01T00:00:03Z' }),
    ]
    expect(getTurnEndIndex(messages, 1)).toBe(2)
    expect(isTurnEndSlot(messages, 1)).toBe(false)
    expect(isTurnEndSlot(messages, 2)).toBe(true)
    const window = getTurnMessageWindow(messages, 2)
    expect(window.map(m => m.id)).toEqual(['a1', 't1'])
    expect(buildTurnArtifactsByEndIndex(messages).get(2)?.length).toBe(1)
  })

  it('multi-segment same-run assistants form one turn (single card at real end)', () => {
    // bugbot  high：同 run 多段 assistant 是同一轮，中间段不是轮末尾
    const link = (n: number) => `[doc${n}](tabtin://resource/tabdoc/doc-${n})`
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({ id: 'a1', role: 'assistant', content: link(1), created_at: '2026-01-01T00:00:01Z', agent_run_id: 'run-1' }),
      msg({ id: 'a2', role: 'assistant', content: link(2), created_at: '2026-01-01T00:00:02Z', agent_run_id: 'run-1' }),
      msg({ id: 'a3', role: 'assistant', content: 'done', created_at: '2026-01-01T00:00:03Z', agent_run_id: 'run-1' }),
    ]
    expect(getTurnEndIndex(messages, 1)).toBe(3)
    expect(isTurnEndSlot(messages, 1)).toBe(false)
    expect(isTurnEndSlot(messages, 2)).toBe(false)
    expect(isTurnEndSlot(messages, 3)).toBe(true)
    const byEnd = buildTurnArtifactsByEndIndex(messages)
    expect(byEnd.size).toBe(1)
    expect(byEnd.get(3)?.length).toBe(2)
    // 窗口覆盖整轮三段
    expect(getTurnMessageWindow(messages, 3).map(m => m.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('#7441 方案 A：不同 agent_run_id 无真实 user 时仍属同一用户轮', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({ id: 'a1', role: 'assistant', content: '[d1](tabtin://resource/tabdoc/d-1)', created_at: '2026-01-01T00:00:01Z', agent_run_id: 'run-1' }),
      msg({ id: 'a2', role: 'assistant', content: '[d2](tabtin://resource/tabdoc/d-2)', created_at: '2026-01-01T00:00:02Z', agent_run_id: 'run-2' }),
    ]
    expect(getTurnEndIndex(messages, 1)).toBe(2)
    expect(isTurnEndSlot(messages, 1)).toBe(false)
    expect(isTurnEndSlot(messages, 2)).toBe(true)
    const byEnd = buildTurnArtifactsByEndIndex(messages)
    // 一张卡汇总整轮产物
    expect(byEnd.size).toBe(1)
    expect(byEnd.get(2)?.map(a => a.href)).toEqual([
      'tabtin://resource/tabdoc/d-1',
      'tabtin://resource/tabdoc/d-2',
    ])
  })

  it('#7441 方案 A：error_envelope 同属用户轮，不切开产物窗口', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({ id: 'a1', role: 'assistant', content: '[d1](tabtin://resource/tabdoc/d-1)', created_at: '2026-01-01T00:00:01Z', agent_run_id: 'run-1' }),
      msg({ id: 'e1', role: 'assistant', content: 'boom', created_at: '2026-01-01T00:00:02Z', message_kind: 'error_envelope', agent_run_id: 'run-1' }),
    ]
    // 挂载点落在轮内最后一个可承载段（error）；窗口含整轮
    expect(getTurnEndIndex(messages, 1)).toBe(2)
    expect(isTurnEndSlot(messages, 1)).toBe(false)
    expect(isTurnEndSlot(messages, 2)).toBe(true)
    expect(getTurnMessageWindow(messages, 2).map(m => m.id)).toEqual(['a1', 'e1'])
    const byEnd = buildTurnArtifactsByEndIndex(messages)
    expect(byEnd.get(2)?.map(a => a.href)).toEqual(['tabtin://resource/tabdoc/d-1'])
    expect(byEnd.has(1)).toBe(false)
  })

  it('user message is never a turn-end slot', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({ id: 'a1', role: 'assistant', content: '[d](tabtin://resource/tabdoc/d-1)', created_at: '2026-01-01T00:00:01Z', agent_run_id: 'run-1' }),
      msg({ id: 'u2', role: 'user', content: 'next', created_at: '2026-01-01T00:00:02Z' }),
    ]
    expect(isTurnEndSlot(messages, 0)).toBe(false)
    expect(isTurnEndSlot(messages, 2)).toBe(false)
    expect(buildTurnArtifactsByEndIndex(messages).has(2)).toBe(false)
  })

  // ：trailing profile/push 不延伸 end，也不得与 llm 双轮末
  it('#7441 trailing agent_profile_context / push 不是轮末挂载点', () => {
    const withProfile = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '[d](tabtin://resource/tabdoc/d-1)',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
      msg({
        id: 'profile',
        role: 'user',
        content: '<context type="agent-profile">x</context>',
        created_at: '2026-01-01T00:00:02Z',
        message_kind: 'agent_profile_context',
      }),
    ]
    expect(getTurnEndIndex(withProfile, 1)).toBe(1)
    expect(isTurnEndSlot(withProfile, 1)).toBe(true)
    expect(isTurnEndSlot(withProfile, 2)).toBe(false)
    expect(buildTurnArtifactsByEndIndex(withProfile).has(1)).toBe(true)
    expect(buildTurnArtifactsByEndIndex(withProfile).has(2)).toBe(false)

    const withPush = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '[d](tabtin://resource/tabdoc/d-1)',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
      msg({
        id: 'push',
        role: 'user',
        content: 'done',
        created_at: '2026-01-01T00:00:02Z',
        metadata: { triggered_by: 'push-notification' },
      }),
    ]
    expect(getTurnEndIndex(withPush, 1)).toBe(1)
    expect(isTurnEndSlot(withPush, 1)).toBe(true)
    expect(isTurnEndSlot(withPush, 2)).toBe(false)
    expect(buildTurnArtifactsByEndIndex(withPush).size).toBe(1)
    expect(buildTurnArtifactsByEndIndex(withPush).has(1)).toBe(true)
  })

  it('code-fenced tabtin:// examples are not artifacts', () => {
    // bugbot  medium：代码块里的示例链接不算产物
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '示例：\n```\ntabtin://resource/tabdoc/fake-1\n```\n行内 `tabtin://resource/tabdoc/fake-2` 也不算。真实产物 [d](tabtin://resource/tabdoc/real-1)',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
      }),
    ]
    const byEnd = buildTurnArtifactsByEndIndex(messages)
    expect(byEnd.get(1)?.map(a => a.href)).toEqual(['tabtin://resource/tabdoc/real-1'])
  })
})

describe('会话级 toolEvents resolver（方案 C：live tool_result 不在 message.blocks）', () => {
  // 实时期 run_terminal_command 的 tool_result 是独立 user envelope，无 ChatMessage
  // 壳 → 不落进任何 message.blocks。资产聚合改按 tool_use_id 从 toolEvents 取
  // canonical 结果（含 file_history），使 live 与历史一致、不刷新即可出卡。
  function liveTurn(toolUseId: string, command = 'hdiutil create test.dmg'): ChatMessage[] {
    return [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        // 只有 tool_use，无配对 tool_result（模拟实时流：结果块被丢弃）
        content_blocks_json: [
          { type: 'tool_use', id: toolUseId, name: 'run_terminal_command', input: { command } },
        ],
      }),
    ]
  }

  function resolverFrom(
    entries: Record<string, { output: unknown; isError?: boolean }>,
  ): SessionToolResultResolver {
    const byId = new Map(
      Object.entries(entries).flatMap(([id, { output, isError }]) => {
        const resolved = resolveToolEventResult(output, isError === true)
        return resolved ? [[id, resolved] as const] : []
      }),
    )
    return (id) => byId.get(id)
  }

  const dmgOutput = {
    status: 'complete',
    exit_code: 0,
    stdout: 'created: /abs/test.dmg\n',
    file_history: { status: 'complete', modified_paths: ['test.dmg'] },
  }

  it('块内无 tool_result 时，靠会话级 resolver 从 file_history 出卡', () => {
    const turn = liveTurn('tu_live')
    // 无 resolver：实时期读不到 → 空（回归当前 bug 现象）
    expect(collectTurnArtifacts(turn)).toEqual([])
    // 有 resolver：canonical file_history → 出卡
    const artifacts = collectTurnArtifacts(turn, undefined, resolverFrom({ tu_live: { output: dmgOutput } }))
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('test.dmg')
    expect(artifacts[0]?.kind).toBe('file')
  })

  it('resolver output 为 JSON 字符串（老数据形态）同样解析', () => {
    const turn = liveTurn('tu_str')
    const artifacts = collectTurnArtifacts(
      turn,
      undefined,
      resolverFrom({ tu_str: { output: JSON.stringify(dmgOutput) } }),
    )
    expect(artifacts.map(a => a.title)).toEqual(['test.dmg'])
  })

  it('phase=error（isError）→ ok=false，不出卡', () => {
    const turn = liveTurn('tu_err')
    const artifacts = collectTurnArtifacts(
      turn,
      undefined,
      resolverFrom({ tu_err: { output: dmgOutput, isError: true } }),
    )
    expect(artifacts).toEqual([])
  })

  it('exit_code!=0 → 不出卡（envelope 失败）', () => {
    const turn = liveTurn('tu_bad')
    const artifacts = collectTurnArtifacts(
      turn,
      undefined,
      resolverFrom({ tu_bad: { output: { ...dmgOutput, exit_code: 1 } } }),
    )
    expect(artifacts).toEqual([])
  })

  it('write_file 实时无块结果时靠 resolver 判定成功入卡', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_wf', name: 'write_file', input: { path: 'notes/plan.md' } },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
    const artifacts = collectTurnArtifacts(
      turn,
      undefined,
      resolverFrom({ tu_wf: { output: { success: true } } }),
    )
    expect(artifacts.map(a => a.title)).toEqual(['plan.md'])
  })

  it('块内配对优先于 resolver，同 path 只出一张卡（历史 + resolver 不双卡）', () => {
    // 历史：tool_use + tool_result co-locate 同消息；同时 resolver 也有该结果。
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_dup', name: 'run_terminal_command', input: { command: 'hdiutil create test.dmg' } },
          { type: 'tool_result', tool_use_id: 'tu_dup', content: JSON.stringify(dmgOutput) },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn, undefined, resolverFrom({ tu_dup: { output: dmgOutput } }))
    expect(artifacts.map(a => a.title)).toEqual(['test.dmg'])
  })

  it('buildTurnArtifactsByEndIndex / collectSessionArtifacts 透传 resolver', () => {
    const turn = liveTurn('tu_thread')
    const resolver = resolverFrom({ tu_thread: { output: dmgOutput } })
    expect(buildTurnArtifactsByEndIndex(turn, undefined, resolver).get(1)?.length).toBe(1)
    expect(collectSessionArtifacts(turn, undefined, resolver).map(a => a.title)).toEqual(['test.dmg'])
  })

  it('resolveToolEventResult：非对象 / 无法解析 → null', () => {
    expect(resolveToolEventResult(undefined, false)).toBeNull()
    expect(resolveToolEventResult('not json', false)).toBeNull()
    expect(resolveToolEventResult(42, false)).toBeNull()
  })
})

describe('file_history 轮内净算：建了又删的中间产物不入卡', () => {
  function shellMsg(
    id: string,
    blockIdx: number,
    fh: { created_paths?: string[]; modified_paths?: string[]; deleted_paths?: string[] },
    command = 'do-stuff',
  ): ChatMessage {
    return msg({
      id,
      role: 'assistant',
      content: '',
      created_at: `2026-01-01T00:00:0${blockIdx}Z`,
      agent_run_id: 'run-1',
      content_blocks_json: [
        { type: 'tool_use', id: `tu_${id}`, name: 'run_terminal_command', input: { command } },
        {
          type: 'tool_result',
          tool_use_id: `tu_${id}`,
          content: JSON.stringify({ status: 'complete', exit_code: 0, stdout: '', file_history: fh }),
        },
      ],
    })
  }

  it('同轮内跨命令：先建后删 → 不入卡', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      shellMsg('a1', 1, { created_paths: ['artifacts/scratch.dmg'] }),
      shellMsg('a2', 2, { deleted_paths: ['artifacts/scratch.dmg'] }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('先删后重建（agent 重跑）→ 仍入卡', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      shellMsg('a1', 1, { deleted_paths: ['test.dmg'] }),
      shellMsg('a2', 2, { created_paths: ['test.dmg'] }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts.map(a => a.title)).toEqual(['test.dmg'])
  })

  it('中间产物删除、最终产物保留 → 只留最终产物', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      shellMsg('a1', 1, { created_paths: ['tmpdata/step1.json', 'artifacts/final.pdf'] }),
      shellMsg('a2', 2, { deleted_paths: ['tmpdata/step1.json'] }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts.map(a => a.title)).toEqual(['final.pdf'])
  })

  it('会话级 resolver 路径同样净算删除（实时期）', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_c', name: 'run_terminal_command', input: { command: 'create' } },
          { type: 'tool_use', id: 'tu_d', name: 'run_terminal_command', input: { command: 'rm' } },
        ],
      }),
    ]
    const resolver: SessionToolResultResolver = (id) => {
      if (id === 'tu_c') return resolveToolEventResult({ exit_code: 0, file_history: { created_paths: ['build/app.dmg'] } }, false)!
      if (id === 'tu_d') return resolveToolEventResult({ exit_code: 0, file_history: { deleted_paths: ['build/app.dmg'] } }, false)!
      return undefined
    }
    expect(collectTurnArtifacts(turn, undefined, resolver)).toEqual([])
  })
})

describe('跨源净算：write_file / delete_file 与 shell deleted_paths', () => {
  it('write_file → delete_file → 不入卡', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_w', name: 'write_file', input: { path: 'test.txt', content: 'x' } },
          { type: 'tool_result', tool_use_id: 'tu_w', content: JSON.stringify({ success: true }) },
          { type: 'tool_use', id: 'tu_d', name: 'delete_file', input: { path: 'test.txt' } },
          { type: 'tool_result', tool_use_id: 'tu_d', content: JSON.stringify({ success: true }) },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('write_file → shell deleted_paths → 不入卡', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_w', name: 'write_file', input: { path: 'test.txt', content: 'x' } },
          { type: 'tool_result', tool_use_id: 'tu_w', content: JSON.stringify({ success: true }) },
          { type: 'tool_use', id: 'tu_r', name: 'run_terminal_command', input: { command: 'rm test.txt' } },
          {
            type: 'tool_result',
            tool_use_id: 'tu_r',
            content: JSON.stringify({
              status: 'complete',
              exit_code: 0,
              stdout: '',
              file_history: { deleted_paths: ['test.txt'] },
            }),
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('write_file A+B → 只删 A → 只留 B', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_a', name: 'write_file', input: { path: 'a.txt', content: '1' } },
          { type: 'tool_result', tool_use_id: 'tu_a', content: JSON.stringify({ success: true }) },
          { type: 'tool_use', id: 'tu_b', name: 'write_file', input: { path: 'b.txt', content: '2' } },
          { type: 'tool_result', tool_use_id: 'tu_b', content: JSON.stringify({ success: true }) },
          { type: 'tool_use', id: 'tu_d', name: 'delete_file', input: { path: 'a.txt' } },
          { type: 'tool_result', tool_use_id: 'tu_d', content: JSON.stringify({ success: true }) },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn).map(a => a.title)).toEqual(['b.txt'])
  })

  it('delete_file 失败不抵消已写入', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_w', name: 'write_file', input: { path: 'keep.txt', content: 'x' } },
          { type: 'tool_result', tool_use_id: 'tu_w', content: JSON.stringify({ success: true }) },
          { type: 'tool_use', id: 'tu_d', name: 'delete_file', input: { path: 'keep.txt' } },
          { type: 'tool_result', tool_use_id: 'tu_d', content: JSON.stringify({ success: false }), is_error: true },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn).map(a => a.title)).toEqual(['keep.txt'])
  })
})

describe('多维表 / 平台交付进本轮产物', () => {
  it('仅 stdout、无 platform_resource 块 → 不入卡', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_t',
            name: 'run_terminal_command',
            input: { command: 'tabtin table create --name 融资' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_t',
            content: JSON.stringify({
              status: 'complete',
              exit_code: 0,
              stdout: JSON.stringify({ data: { id: 'tbl_flat', name: '融资' } }),
            }),
          },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('有 platform_resource 块 → 入卡', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tool_use',
            id: 'tu_t',
            name: 'run_terminal_command',
            input: { command: 'tabtin table create --name 融资' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_t',
            content: JSON.stringify({
              status: 'complete',
              exit_code: 0,
              stdout: JSON.stringify({ data: { id: 'tbl_platform', name: '融资' } }),
            }),
          },
        ],
      }),
      msg({
        id: 'art1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:02Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'resource_ref',
          summary: '融资',
          payload: {
            artifact_kind: 'platform_resource',
            resource_type: 'table',
            resource_id: 'tbl_platform',
            resource_name: '融资',
            hint_carrier_app_id: 'tabdata',
            url: 'tabtin://resource/table/tbl_platform?hint=tabdata&title=%E8%9E%8D%E8%B5%84',
          },
        }],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('table')
    expect(artifacts[0]?.title).toBe('融资')
  })

  it('host platform_resource resource_ref 入卡；裸 resource_ref 仍排除', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [
          {
            type: 'tabtin_rich_content',
            kind: 'resource_ref',
            summary: '融资表',
            payload: {
              artifact_kind: 'platform_resource',
              resource_type: 'table',
              resource_id: 'tbl_platform',
              resource_name: '融资表',
              hint_carrier_app_id: 'tabdata',
              space_id: 'workspace-1',
              url: 'tabtin://resource/table/tbl_platform?hint=tabdata&title=%E8%9E%8D%E8%B5%84%E8%A1%A8',
            },
          },
          {
            type: 'tabtin_rich_content',
            kind: 'resource_ref',
            summary: '展示用',
            group_id: 'present_to_user_1',
            payload: {
              resource_type: 'table',
              resource_id: 'tbl_present',
              resource_name: '展示用',
            },
          },
        ],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.kind).toBe('table')
    expect(artifacts[0]?.title).toBe('融资表')
    expect(artifacts[0]?.resourceSpaceId).toBe('workspace-1')
  })

  it('用后到 resource_ref 的真实工作空间补全已去重的正文链接', () => {
    const turn = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '[融资表](tabtin://resource/table/tbl_platform?hint=tabdata)',
        created_at: '2026-01-01T00:00:01Z',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'resource_ref',
          payload: {
            artifact_kind: 'platform_resource',
            resource_type: 'table',
            resource_id: 'tbl_platform',
            resource_name: '融资表',
            space_id: 'workspace-1',
            url: 'tabtin://resource/table/tbl_platform?hint=tabdata',
          },
        }],
      }),
    ]

    const artifacts = collectTurnArtifacts(turn)

    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.resourceSpaceId).toBe('workspace-1')
  })
})

describe('local_file 并入 path 净算', () => {
  it('create_file rich → 同轮 delete_file 同 path → 不入卡', () => {
    const turn = [
      msg({ id: 'u1', role: 'user', content: 'go', created_at: '2026-01-01T00:00:00Z' }),
      msg({
        id: 'art1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'file',
          summary: 'scratch.txt',
          payload: {
            artifact_kind: 'local_file',
            filename: 'scratch.txt',
            relative_path: 'tmpdata/scratch.txt',
          },
        }],
      }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:02Z',
        agent_run_id: 'run-1',
        content_blocks_json: [
          { type: 'tool_use', id: 'tu_d', name: 'delete_file', input: { path: 'tmpdata/scratch.txt' } },
          { type: 'tool_result', tool_use_id: 'tu_d', content: JSON.stringify({ success: true }) },
        ],
      }),
    ]
    expect(collectTurnArtifacts(turn)).toEqual([])
  })

  it('create_file rich 无后续删除 → 轮末入卡', () => {
    const turn = [
      msg({
        id: 'art1',
        role: 'assistant',
        content: '',
        created_at: '2026-01-01T00:00:01Z',
        message_kind: 'tool_artifact',
        agent_run_id: 'run-1',
        content_blocks_json: [{
          type: 'tabtin_rich_content',
          kind: 'file',
          summary: 'keep.txt',
          payload: {
            artifact_kind: 'local_file',
            filename: 'keep.txt',
            relative_path: 'outputs/keep.txt',
          },
        }],
      }),
    ]
    const artifacts = collectTurnArtifacts(turn)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.title).toBe('keep.txt')
    expect(artifacts[0]?.href).toContain(encodeURIComponent('outputs/keep.txt'))
  })

})
