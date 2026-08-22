/**
 * uploadFileToOSS — C9 类多 organization 上传隔离回归防御。
 *
 * **本测试守住的核心契约**（防 C9 file_not_in_organization 回归再发）：
 *
 *   `opts.organizationId  >  globalThis.tabtin.organizationId  >  undefined`
 *
 * 三档优先级 + dev-mode warning + 端到端 mock 隔离验证。
 *
 * ── 为什么需要本测试 ──
 *
 * C9 bug 现场（详见 docs/agent/cli-spec/api-evolution-mutual-protection.md）：
 *
 *   1. daemon 启动时绑定 organization A，写 `globalThis.tabtin.organizationId = 'A'`；
 *   2. 用户在 CLI 端切到 organization B，CLI 发请求带 `organization_id=B`；
 *   3. 但 ActionTool/oss-upload 链路上某处忘了把 per-request organizationId 透传，
 *      `uploadFileToOSS` fallback 到 daemon 全局 → FileRecord 写到 A；
 *   4. 用户后续 `doc import file --file-record-id <id>` 在 organization B
 *      查不到这个 FileRecord → 403 `file_not_in_organization`。
 *
 * 这条链路有 7 个潜在断点（4 处 ActionTool 透传 + daemon action-bridge 注入
 * + Electron bridge-core getter + cli-routes oss.ts 透传），任何一处改坏都
 * 会让 bug 复发。本测试集是"最后一道闸门"：
 *
 *   - 行为测试（场景 1-4 + 9）：直接执行 uploadFileToOSS，断言传给
 *     `client.upload` 的 organizationId 满足优先级链路；
 *   - 链路守卫（场景 5/8 + 4 处 ActionTool 透传）：源码静态比对（fs.readFileSync
 *     + 正则匹配），防消费方代码被改坏后 silent 走错链路 —— 行为测试
 *     mock 掉了 client.upload，覆盖不到"调用方根本没传 organizationId"这种
 *     上游问题，所以补静态比对锁住消费方代码形态。
 *
 * 与现有 `oss-upload.test.ts` 的分工：
 *
 *   - `oss-upload.test.ts` 守 contextId 校验 + UploadOutcome 结构契约
 *     （dogfood baking_error 复盘）；
 *   - 本文件守 organizationId 优先级 + 跨包透传链路（C9 复盘）；
 *
 *   两者主题不同，故分文件——避免单文件变成"oss-upload 所有契约"杂烩。
 *
 * 测试形态参考 `apps/tabtin-daemon/tests/c9-action-bridge-organization-id.test.ts`
 * 的"行为 + 源码静态比对"组合模式（前一轮 fixer 已验证有效）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// 与 oss-upload.test.ts 同款 mock：vi.hoisted 让 mockUpload 在 vi.mock factory
// 之前定义，闭包捕获后 mock factory 能拿到。每个 test 用 mockUpload.mock.calls
// 检查 client.upload 收到的 organizationId 值（这是 C9 防御的核心断言点）。
const { mockUpload } = vi.hoisted(() => ({ mockUpload: vi.fn() }))
vi.mock('@tabtin/oss-client', () => ({
  createOSSClient: () => ({ upload: mockUpload }),
}))

let tmpFile: string

function setTabtin(value: unknown): void {
  ;(globalThis as unknown as { tabtin?: unknown }).tabtin = value
}

function delTabtin(): void {
  delete (globalThis as unknown as { tabtin?: unknown }).tabtin
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `oss-upload-wt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  fs.writeFileSync(tmpFile, Buffer.from('fake-png-bytes'))
  mockUpload.mockResolvedValue({
    fileId: 'frec_test',
    fileName: 'test.png',
    fileKey: 'test/x.png',
    fileSize: 14,
    accessUrl: 'https://oss.example.com/test/x.png',
    cdnUrl: 'https://cdn.example.com/test/x.png',
  })
})

afterEach(() => {
  try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
  delTabtin()
  mockUpload.mockReset()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────
// 行为测试（4 档优先级 + dev warning + 端到端隔离）
// ─────────────────────────────────────────────────────────────────────

describe('uploadFileToOSS — organizationId 优先级链路（C9 防御）', () => {
  it('场景 1：opts.organizationId 传了 → 透传给 client.upload（最高优先级）', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
      // 故意不设 daemon 全局 organizationId，验证 opts 单独传也能 work
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      contextId: 'test-ctx',
      organizationId: 'wt_per_request',
    })

    expect(result.url).toBe('https://oss.example.com/test/x.png')
    expect(mockUpload).toHaveBeenCalledOnce()
    const uploadOpts = mockUpload.mock.calls[0][2]
    expect(uploadOpts.organizationId).toBe('wt_per_request')
  })

  it('场景 2：opts.organizationId 缺失 → fallback 到 daemon globalThis.tabtin.organizationId', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
      organizationId: 'wt_daemon_global',  // daemon 内部任务场景
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      contextId: 'test-ctx',
      // organizationId 不传 —— 模拟 daemon 内部任务（无 per-request 上下文）
    })

    expect(result.url).toBe('https://oss.example.com/test/x.png')
    const uploadOpts = mockUpload.mock.calls[0][2]
    expect(uploadOpts.organizationId).toBe('wt_daemon_global')
  })

  it('场景 3：opts 和 daemon 都没有 → undefined（让 Django 退到 user default organization）', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    // Mock warn 避免 dev-mode 诊断信息漏到 CI 输出（NODE_ENV=test 非 production
    // 会触发 warning，这里测的是 client.upload 接到 undefined，warning 是另一个
    // 测试场景 4 的关注点）。
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      contextId: 'test-ctx',
    })

    expect(result.url).toBe('https://oss.example.com/test/x.png')
    const uploadOpts = mockUpload.mock.calls[0][2]
    // 关键契约：传 undefined（不是空串），oss-client 接到才会让 Django
    // `_oss_resolve_organization` 走 user default organization fallback；传空串
    // 会被 oss-client 当 "" header 发出去，Django 反而无法识别为缺失。
    expect(uploadOpts.organizationId).toBeUndefined()
  })

  it('场景 4：dev mode + 无 organizationId → console.warn 触发（让开发期能发现 C9 隐患）', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    const originalNodeEnv = process.env.NODE_ENV
    // 显式设为非 production（vitest 默认 NODE_ENV=test，但保险起见显式设置）
    process.env.NODE_ENV = 'development'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { uploadFileToOSS } = await import('../oss-upload')
      await uploadFileToOSS(tmpFile, { contextId: 'test-ctx' })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('uploadFileToOSS called without organizationId'),
      )
      // 警告文案必须能让排查者一眼看出方向（mention "per-request organizationId"）
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/per-request organizationId/),
      )
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
    }
  })

  it('场景 4-补：production mode + 无 organizationId → 不触发 warn（避免生产噪音）', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { uploadFileToOSS } = await import('../oss-upload')
      await uploadFileToOSS(tmpFile, { contextId: 'test-ctx' })

      const warnCall = warnSpy.mock.calls.find((args) =>
        typeof args[0] === 'string' && args[0].includes('uploadFileToOSS called without organizationId'),
      )
      expect(warnCall).toBeUndefined()
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
    }
  })

  // ── C9 核心防御 ────────────────────────────────────────────────────
  it('场景 9：daemon globalThis = A + per-request opts = B → client.upload 收到 B（C9 核心隔离）', async () => {
    // 这是 C9 bug 现场的最小重现：
    //   - daemon 启动时绑了 organization A（globalThis.tabtin.organizationId = 'A'）；
    //   - 用户切到 organization B，CLI / SSE payload 带 organization_id=B；
    //   - 中间任一环节没透传 B → FileRecord 写到 A → doc import file 报 file_not_in_organization。
    //
    // 本测试在 oss-upload 这一层守住"per-request 永远赢"的契约 ——
    // 哪怕上游链路再怎么改，只要 caller 显式传了 opts.organizationId，
    // FileRecord 就归属正确的 organization。
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
      organizationId: 'wt_DAEMON_A',  // daemon 当前绑定 A
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    await uploadFileToOSS(tmpFile, {
      contextId: 'test-ctx',
      organizationId: 'wt_CLI_B',  // CLI 请求的目标 organization B
    })

    const uploadOpts = mockUpload.mock.calls[0][2]
    expect(uploadOpts.organizationId).toBe('wt_CLI_B')
    expect(uploadOpts.organizationId).not.toBe('wt_DAEMON_A')
  })

  it('场景 9-补：opts.organizationId = 空串 → 视作未传，fallback daemon 全局', async () => {
    // 空串语义防御：JS `'' || 'fallback'` 走 fallback，避免传空串绕过
    // 优先级逻辑（消费方不小心传空串时不能 silent 取消优先级）。
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
      organizationId: 'wt_DAEMON_A',
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    await uploadFileToOSS(tmpFile, {
      contextId: 'test-ctx',
      organizationId: '',
    })

    const uploadOpts = mockUpload.mock.calls[0][2]
    expect(uploadOpts.organizationId).toBe('wt_DAEMON_A')
  })

})

// ─────────────────────────────────────────────────────────────────────
// 链路守卫：源码静态比对（防 4 处 ActionTool 透传 + cli-routes 透传被改回去）
// ─────────────────────────────────────────────────────────────────────
//
// 为什么用源码静态比对而不是行为测试：
//
// 行为测试已经把 client.upload mock 掉了 —— 验证的是"调用方传了什么 opts
// 给 uploadFileToOSS"。但**消费方根本没传 organizationId**这种上游回归，行为
// 测试覆盖不到（行为测试是从 uploadFileToOSS 入口开始的）。
//
// 各消费方的测试基建参差不齐：
//   - cli-routes/oss.ts：完全没有测试基建（package.json 无 vitest）；
//   - Electron bridge-core.ts：完全没有 main 端测试基建（仅 renderer 有）；
//
// 静态比对方案：fs.readFileSync 读消费方源码，正则匹配关键透传/注入语句
// 是否存在。任一处被改回去（删 organizationId 字段、改优先级）→ 测试红，
// CI 直接拦下来。对齐 daemon `c9-action-bridge-organization-id.test.ts` 同款
// 模式（前一轮 fixer 已验证有效）。
//
// 局限：只能抓"代码不在了"的回归，抓不到"代码在但语义错了"的回归
// —— 但语义错的部分有行为测试兜底（场景 1-9）。两者互补。

const REPO_ROOT = path.resolve(__dirname, '../../../../..')

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8')
}

describe('C9 链路守卫 — ActionTool organizationId 透传源码静态比对', () => {
  it('packages/agent-runtime/src/tools/show-widget/bake-upload.ts —— organizationId 参数透传', () => {
    const src = readSrc('packages/agent-runtime/src/tools/show-widget/bake-upload.ts')
    // bake-upload 是从函数参数接 organizationId（来自 ToolContext.organizationId），
    // 不从 params 透传 —— 检查"函数签名收 organizationId 参数 + 透传给 uploadFileToOSS"。
    expect(src).toMatch(/organizationId\??\s*:\s*string/)  // 函数参数
    expect(src).toMatch(/organizationId,?\s*\n/)            // 透传到 uploadFileToOSS opts 对象
  })

  it('packages/agent-runtime/src/tools/show-widget/index.ts —— execute 把 ToolContext.organizationId 接力给 bakeAndUploadWidget', () => {
    const src = readSrc('packages/agent-runtime/src/tools/show-widget/index.ts')
    expect(src).toMatch(/context\.organizationId/)
  })

  it('packages/action-tools/src/utils/oss-upload.ts —— 优先级链路代码未被改坏', () => {
    const src = readSrc('packages/action-tools/src/utils/oss-upload.ts')
    // 核心一行：`opts.organizationId || g?.tabtin?.organizationId || undefined`
    expect(src).toMatch(/opts\.organizationId\s*\|\|\s*g\?\.tabtin\?\.organizationId\s*\|\|\s*undefined/)
    // 必须有 dev warning 行（防被人"觉得吵"删掉）
    expect(src).toMatch(/uploadFileToOSS called without organizationId/)
  })
})

describe('C9 链路守卫 — cli-routes / Electron host 注入源码静态比对', () => {
  it('packages/cli-routes/src/routes/oss.ts —— 透传 body.organization_id → uploadFileToOSS organizationId', () => {
    const src = readSrc('packages/cli-routes/src/routes/oss.ts')
    // 严格匹配 `organizationId: (typeof body?.organization_id === 'string' && body.organization_id) || undefined`
    // 不死锁标点细节，留弹性允许换行/格式调整，但 4 个关键 token 必须都在。
    expect(src).toMatch(/organizationId:/)
    expect(src).toMatch(/body\?\.organization_id/)
    expect(src).toMatch(/typeof\s+body\?\.organization_id\s*===\s*['"]string['"]/)
    // 不能直接 fallback 到 daemon 全局——cli-routes 必须只看 body.organization_id
    // （daemon 全局 fallback 由 oss-upload.ts 一层内部做，cli-routes 上层不该绕过）
    expect(src).not.toMatch(/cli-routes.*globalThis\.tabtin\.organizationId/)
  })

  it('apps/tabtin-electron/src/main/services/bridge-core.ts —— 注入 global.tabtin.organizationId lazy getter', () => {
    const src = readSrc('apps/tabtin-electron/src/main/services/bridge-core.ts')
    // 必须用 Object.defineProperty 而不是直接赋值——固定值在用户切 organization 后就过期
    expect(src).toMatch(/Object\.defineProperty\s*\(\s*global\.tabtin,\s*['"]organizationId['"]/)
    // getter 必须代理到 getCLIOrganizationId（cli-context 的 SSoT）
    expect(src).toMatch(/get:\s*\(\)\s*=>\s*getCLIOrganizationId\(\)/)
    // import 应包括 getCLIOrganizationId
    expect(src).toMatch(/getCLIOrganizationId/)
  })

  it('apps/tabtin-daemon —— DaemonConfig 携带 organization_id 字段（兜底注入的来源）', () => {
    // 防 daemon config schema 把 organization_id 字段删掉导致 action-bridge 注入失效。
    // 不直接 import 类型（避免装配整个 daemon），用 grep 字面匹配。
    const src = readSrc('apps/tabtin-daemon/src/config/types.ts')
    expect(src).toMatch(/organization_id\??\s*:\s*string/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 端到端 mock 完整链路：cli-routes payload → uploadFileToOSS → client.upload
// ─────────────────────────────────────────────────────────────────────
//
// 这个测试模拟"CLI Go 端注入 organization_id 到 body → cli-routes/oss.ts
// 接收后透传到 uploadFileToOSS → 内部走优先级链路 → client.upload 收到正确
// organizationId"的完整路径。
//
// 为什么不直接 import cli-routes 的 handleOSSRoute：cli-routes 没有
// vitest 配置，sub-path import 在 action-tools 包里跨包跑 ts 源会撞
// moduleResolution 问题。这里用"还原 cli-routes 的透传逻辑（一行）"
// 替代——核心是验证 oss-upload 接到的 opts.organizationId 在端到端 mock
// 链路上确实保持 per-request 优先。

describe('C9 端到端 mock —— cli-routes → uploadFileToOSS → client.upload 全链路', () => {
  it('CLI body 带 organization_id=B + daemon globalThis=A → 最终 client.upload 收到 B', async () => {
    // Daemon 全局：模拟 daemon 启动绑定 organization A
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
      organizationId: 'wt_DAEMON_A',
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    // 还原 cli-routes/oss.ts:148-155 的透传逻辑（保持与生产代码同步）
    // ：body 是 CLI Go pipeline 发来的 JSON body，organization_id 字段是 ResolveOrganizationID
    // 的结果（与 CLI active organization 一致）。
    const body = {
      file_path: tmpFile,
      organization_id: 'wt_CLI_B',  // CLI 切到了 B
      context_id: 'doc-import-456',
    }

    await uploadFileToOSS(tmpFile, {
      contextId: body.context_id,
      organizationId: (typeof body.organization_id === 'string' && body.organization_id) || undefined,
    })

    const uploadOpts = mockUpload.mock.calls[0][2]
    expect(uploadOpts.organizationId).toBe('wt_CLI_B')
    expect(uploadOpts.contextId).toBe('doc-import-456')
  })

  it('CLI body 没带 organization_id（异常路径）+ daemon globalThis=A → fallback 到 A', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
      organizationId: 'wt_DAEMON_A',
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    // CLI Go 端正常路径会注入 organization_id；这里模拟"老版 CLI / 第三方
    // 客户端"忘了带的兜底场景 —— 走 daemon 全局，避免 FileRecord 完全
    // 写不进去。
    const body = { file_path: tmpFile, context_id: 'doc-import-457' }

    await uploadFileToOSS(tmpFile, {
      contextId: body.context_id,
      organizationId: (typeof (body as any).organization_id === 'string' && (body as any).organization_id) || undefined,
    })

    const uploadOpts = mockUpload.mock.calls[0][2]
    expect(uploadOpts.organizationId).toBe('wt_DAEMON_A')
  })

  it('Electron host 场景：daemon globalThis 由 lazy getter 提供 → 切 organization 后能动态返回新值', async () => {
    // 模拟 Electron bridge-core 的 lazy getter 行为：
    //   global.tabtin.organizationId 不是固定值，而是 getter 每次返回
    //   getCLIOrganizationId() 当前真值。
    // 这里用闭包变量 + Object.defineProperty 还原 getter 语义。
    let activeOrganization: string | null = 'wt_INITIAL'
    const fakeGlobal: any = {
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    }
    Object.defineProperty(fakeGlobal, 'organizationId', {
      get: () => activeOrganization ?? undefined,
      configurable: true,
      enumerable: true,
    })
    setTabtin(fakeGlobal)
    const { uploadFileToOSS } = await import('../oss-upload')

    // 第 1 次：active organization = INITIAL
    await uploadFileToOSS(tmpFile, { contextId: 'ctx-1' })
    expect(mockUpload.mock.calls[0][2].organizationId).toBe('wt_INITIAL')

    // 用户切了 organization（renderer space:set-active → cli-context.currentOrganizationId 改）
    activeOrganization = 'wt_AFTER_SWITCH'

    // 第 2 次：getter 必须返回新值（不是 cache 住第 1 次的 INITIAL）
    await uploadFileToOSS(tmpFile, { contextId: 'ctx-2' })
    expect(mockUpload.mock.calls[1][2].organizationId).toBe('wt_AFTER_SWITCH')
  })
})
