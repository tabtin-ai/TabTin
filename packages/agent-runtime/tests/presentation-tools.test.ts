import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createPresentationTools } from '../src/tools/presentation-tools'
import { ToolRegistry } from '../src/engine/tooling/tool-system'
import { runTools } from '../src/engine/tooling/tool-orchestration'
import { createMockPermissionHandler } from './test-utils'
import type { ToolExecutionResult } from '../src/engine/tooling/tool-orchestration'
import type { StreamEvent } from '../src/engine/contracts/wire-protocol'
import type { ToolUseBlock } from '../src/engine/contracts/conversation'
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';

type RichBlockArg = NonNullable<ToolContext['emitRichContentBlock']> extends (args: infer A) => void ? A : never

// 宿主注入值：复现产品当前 6 类可展示资源 + slide 禁 auto_open 策略。
const SUPPORTED_RESOURCE_TYPES = new Set(['table', 'doc', 'slide', 'video', 'site', 'tracker'])
const autoOpenPolicy = (resourceType: string): boolean => resourceType !== 'slide'
const buildLocalFileArtifactUrl = (relativePath: string): string =>
  `tabtin://resource/file/${encodeURIComponent(relativePath)}?hint=tabfiles`

function getPresentToUserTool(): Tool {
  const tool = createPresentationTools({
    supportedResourceTypes: SUPPORTED_RESOURCE_TYPES,
    autoOpenPolicy,
    buildLocalFileArtifactUrl,
  }).find((candidate) => candidate.name === 'present_to_user')
  if (!tool) {
    throw new Error('present_to_user tool not registered')
  }
  return tool
}

function makeContext(richBlocks: RichBlockArg[] = [], workspaceRoot?: string): ToolContext {
  return {
    threadId: 'tt-test',
    runtimeId: 'sess-test',
    agentRunId: 'run-test',
    toolUseId: 'toolu-test',
    abortSignal: new AbortController().signal,
    messages: [],
    ...(workspaceRoot ? { workspaceRoot } : {}),
    emitRichContentBlock: (args) => richBlocks.push(args),
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'present-local-file-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeWorkspaceFile(relativePath: string, contents = 'data'): void {
  const abs = path.join(tmpDir, relativePath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

function makeToolUseBlock(name: string, id: string, input: unknown = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input }
}

async function drainRunTools(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<ToolExecutionResult[]> {
  let next = await gen.next()
  while (!next.done) {
    next = await gen.next()
  }
  return next.value
}

describe('present_to_user resource_ref contract', () => {
  it('presents a standard table resource_ref with resource_type and resource_id', async () => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    const result = await tool.execute(
      {
        summary: '36Kr import result',
        items: [
          {
            kind: 'resource_ref',
            resource_type: 'table',
            resource_id: '0021d10c-404d-4528-a091-2741a3e64744',
            resource_name: '36氪项目库',
            summary: '36氪项目库表格',
          },
        ],
      },
      makeContext(richBlocks),
    )

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(String(result.content))).toMatchObject({ success: true, accepted: 1 })
    expect(richBlocks).toHaveLength(1)
    expect(richBlocks[0]).toMatchObject({
      kind: 'resource_ref',
      summary: '36氪项目库表格',
      payload: {
        resource_type: 'table',
        resource_id: '0021d10c-404d-4528-a091-2741a3e64744',
        resource_name: '36氪项目库',
        auto_register: true,
      },
    })
    expect(typeof richBlocks[0].payload?.auto_register_token).toBe('string')
    expect(String(richBlocks[0].payload?.auto_register_token).length).toBeGreaterThan(0)
    expect(richBlocks[0].payload?.auto_open).toBeUndefined()
  })

  it.each([
    ['open_behavior=focus', { open_behavior: 'focus' }],
    ['auto_open=true', { auto_open: true }],
  ])('only auto-opens a resource_ref when explicitly requested via %s', async (_label, openInput) => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    await tool.execute(
      {
        summary: 'explicit focus',
        items: [{
          kind: 'resource_ref',
          resource_type: 'doc',
          resource_id: 'doc-explicit-focus',
          summary: '显式打开文档',
          ...openInput,
        }],
      },
      makeContext(richBlocks),
    )

    expect(richBlocks[0].payload).toMatchObject({
      auto_register: true,
      auto_open: true,
    })
    expect(typeof richBlocks[0].payload?.auto_open_token).toBe('string')
  })

  it('does not register or auto-open slide resource refs', async () => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    await tool.execute(
      {
        summary: 'slide result',
        items: [{
          kind: 'resource_ref',
          resource_type: 'slide',
          resource_id: 'slide-no-register',
          summary: '演示文稿',
          open_behavior: 'focus',
        }],
      },
      makeContext(richBlocks),
    )

    expect(richBlocks[0].payload?.auto_register).toBeUndefined()
    expect(richBlocks[0].payload?.auto_open).toBeUndefined()
  })

  it('normalizes ref plus metadata.type into resource_id and resource_type', async () => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    const result = await tool.execute(
      {
        summary: '36Kr import result',
        items: [
          {
            kind: 'resource_ref',
            ref: '0021d10c-404d-4528-a091-2741a3e64744',
            metadata: { type: 'table' },
            summary: '36氪项目库表格',
          },
        ],
      },
      makeContext(richBlocks),
    )

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(String(result.content))).toMatchObject({ success: true, accepted: 1 })
    expect(richBlocks).toHaveLength(1)
    expect(richBlocks[0].payload).toMatchObject({
      ref: '0021d10c-404d-4528-a091-2741a3e64744',
      metadata: { type: 'table' },
      resource_type: 'table',
      resource_id: '0021d10c-404d-4528-a091-2741a3e64744',
      auto_register: true,
    })
    expect(typeof richBlocks[0].payload?.auto_register_token).toBe('string')
  })

  it('presents a tracker resource_ref', async () => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    const result = await tool.execute(
      {
        summary: 'created tracker',
        items: [
          {
            kind: 'resource_ref',
            resource_type: 'tracker',
            resource_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            resource_name: '每日同步',
            summary: '每日同步自动化',
          },
        ],
      },
      makeContext(richBlocks),
    )

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(String(result.content))).toMatchObject({ success: true, accepted: 1 })
    expect(richBlocks[0]).toMatchObject({
      kind: 'resource_ref',
      payload: {
        resource_type: 'tracker',
        resource_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        resource_name: '每日同步',
      },
    })
  })

  it('returns a diagnostic resource_ref example when resource_type is missing', async () => {
    const tool = getPresentToUserTool()

    const result = await tool.execute(
      {
        summary: '36Kr import result',
        items: [
          {
            kind: 'resource_ref',
            ref: '0021d10c-404d-4528-a091-2741a3e64744',
            summary: '36氪项目库表格',
          },
        ],
      },
      makeContext(),
    )

    expect(result.isError).toBeTruthy()
    const content = JSON.parse(String(result.content)) as { errors: string[] }
    expect(content.errors[0]).toContain('resource_type')
    expect(content.errors[0]).toContain('resource_id')
    expect(content.errors[0]).toContain('kind: "resource_ref"')
    expect(content.errors[0]).toContain('metadata: { type }')
  })
})

describe('present_to_user local_file scheduling', () => {
  it('keeps ordinary presentation dynamically read-only while local_file is write-like and serial', () => {
    const tool = getPresentToUserTool()
    const imageInput = {
      summary: 'image',
      items: [{ kind: 'image', url: 'https://example.test/a.png', summary: '图' }],
    }
    const localFileInput = {
      summary: 'file',
      items: [{ kind: 'local_file', relative_path: 'artifacts/report.xlsx', summary: '报表' }],
    }

    expect(tool.policyActionKind).toBe('object_read')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.disablePreStart).toBe(true)
    expect(tool.isWriteOp?.(imageInput)).toBe(false)
    expect(tool.isConcurrencySafe?.(imageInput)).toBe(true)
    expect(tool.extractPolicyParams?.(imageInput)).toEqual({})
    expect(tool.isWriteOp?.(localFileInput)).toBe(true)
    expect(tool.isConcurrencySafe?.(localFileInput)).toBe(false)
    expect(tool.extractPolicyParams?.(localFileInput)).toEqual({
      relative_path: 'artifacts/report.xlsx',
      path: 'artifacts/report.xlsx',
    })
  })

  it('waits for an earlier write tool before presenting a local file in the same runTools batch', async () => {
    const relativePath = 'artifacts/same-turn.txt'
    const order: string[] = []
    const richBlocks: RichBlockArg[] = []
    const presentToUser = getPresentToUserTool()
    const writeFile: Tool = {
      name: 'write_file',
      description: 'write test file',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: false,
      execute: async () => {
        order.push('write_file')
        writeWorkspaceFile(relativePath, 'same turn data')
        return { content: 'written' }
      },
    }
    const registry = new ToolRegistry()
    registry.loadTools({ getTools: () => [writeFile, presentToUser] })

    const results = await drainRunTools(runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: [
        makeToolUseBlock('write_file', 'write-1'),
        makeToolUseBlock('present_to_user', 'present-1', {
          summary: 'same turn file',
          items: [{ kind: 'local_file', relative_path: relativePath }],
        }),
      ],
      registry,
      context: makeContext(richBlocks, tmpDir),
      permissionHandler: createMockPermissionHandler(),
    }))

    expect(order).toEqual(['write_file'])
    expect(results).toHaveLength(2)
    expect(results.every((result) => !result.result.isError)).toBe(true)
    expect(richBlocks).toHaveLength(1)
    expect(richBlocks[0]).toMatchObject({
      kind: 'file',
      payload: {
        artifact_kind: 'local_file',
        relative_path: relativePath,
        auto_open: true,
        auto_register: true,
      },
    })
  })
})

describe('present_to_user image contract', () => {
  it('normalizes image_url alias to the canonical url payload', async () => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    const result = await tool.execute(
      {
        summary: '生成图片',
        items: [
          {
            kind: 'image',
            image_url: 'https://example.test/generated.png',
            summary: '红苹果产品摄影图',
          },
        ],
      },
      makeContext(richBlocks),
    )

    expect(result.isError).toBeFalsy()
    expect(richBlocks).toHaveLength(1)
    expect(richBlocks[0]).toMatchObject({
      kind: 'image',
      summary: '红苹果产品摄影图',
      payload: {
        image_url: 'https://example.test/generated.png',
        url: 'https://example.test/generated.png',
      },
    })
  })

  it('unescapes literal \\u0026 in image url so signed TOS links load', async () => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []
    const broken =
      'https://ark.example.test/img.jpeg?X-Tos-Algorithm=TOS4\\u0026X-Tos-SignedHeaders=host'

    const result = await tool.execute(
      {
        summary: '生成图片',
        items: [{ kind: 'image', url: broken, summary: '红苹果' }],
      },
      makeContext(richBlocks),
    )

    expect(result.isError).toBeFalsy()
    expect(richBlocks[0]?.payload).toMatchObject({
      url: 'https://ark.example.test/img.jpeg?X-Tos-Algorithm=TOS4&X-Tos-SignedHeaders=host',
    })
  })

  it('rejects an image item without url instead of emitting a fallback card', async () => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    const result = await tool.execute(
      {
        summary: '生成图片',
        items: [{ kind: 'image', summary: '缺少地址' }],
      },
      makeContext(richBlocks),
    )

    expect(result.isError).toBeTruthy()
    expect(String(result.content)).toContain('image requires url')
    expect(richBlocks).toHaveLength(0)
  })
})

describe('present_to_user local_file contract', () => {
  it('publishes an existing workspace file as a local_file artifact', async () => {
    writeWorkspaceFile('artifacts/report.xlsx', 'workbook-bytes')
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    const result = await tool.execute(
      {
        summary: '生成的报表',
        items: [{ kind: 'local_file', relative_path: 'artifacts/report.xlsx', summary: '报表.xlsx' }],
      },
      makeContext(richBlocks, tmpDir),
    )

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(String(result.content))).toMatchObject({ success: true, accepted: 1 })
    expect(richBlocks).toHaveLength(1)
    expect(richBlocks[0]).toMatchObject({
      kind: 'file',
      summary: '报表.xlsx',
      payload: {
        artifact_kind: 'local_file',
        file_type: 'xlsx',
        relative_path: 'artifacts/report.xlsx',
        filename: 'report.xlsx',
        mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        auto_register: true,
        auto_open: true,
      },
    })
    expect(String(richBlocks[0].payload?.url)).toBe('tabtin://resource/file/artifacts%2Freport.xlsx?hint=tabfiles')
    expect(JSON.stringify(richBlocks[0])).not.toContain(tmpDir)
  })

  it('rejects missing or escaping local files without emitting a card', async () => {
    const tool = getPresentToUserTool()
    const richBlocks: RichBlockArg[] = []

    const result = await tool.execute(
      {
        summary: '坏路径',
        items: [
          { kind: 'local_file', relative_path: '../secret.pdf', summary: '越界' },
          { kind: 'local_file', relative_path: 'missing.pdf', summary: '不存在' },
        ],
      },
      makeContext(richBlocks, tmpDir),
    )

    expect(result.isError).toBeTruthy()
    expect(String(result.content)).toContain('relative_path 不能跳出当前工作目录')
    expect(String(result.content)).toContain('找不到文件')
    expect(richBlocks).toHaveLength(0)
  })
})
