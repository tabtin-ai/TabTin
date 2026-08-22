/**
 * C9 防御回归测试集 —— organization_id 跨 host 透传链路。
 *
 * **本测试守的契约**（防 C9 `file_not_in_organization` bug 复发）：
 *
 *   1. daemon action-bridge.ts 兜底注入 `params._organization_id`（#5）
 *   2. cli-routes /oss/upload 透传 `body.organization_id` → uploadFileToOSS（#7）
 *   3. Electron bridge-core.ts 注入 `global.tabtin.organizationId` lazy getter（#6）
 *   4. DaemonConfig 携带 organization_id 字段（注入的来源）
 *
 * **测试形态**：源码静态比对 + simulated injection 逻辑。
 *
 * 选择理由：
 *
 *   - DaemonActionBridge 完整 wire-up 涉及 PluginManager / Logger /
 *     AdapterFactory 一连串依赖，纯逻辑回归不值得拉这套 mock；
 *   - cli-routes 包没有 vitest 基建（搭建超出本任务边界，得加 devDep + 脚本）；
 *   - Electron main 包没有 main 端测试基建（仅 renderer 有 __tests__）；
 *
 *   daemon 测试套有完整的 vitest 基建，把跨 host 的源码静态比对全收口
 *   到这里（与 action-bridge.ts 注入测试是同一案的姊妹守卫）—— 任一处
 *   被改坏，CI 都拦得住。对齐 w2-f3-action-bridge-ef05-br02.test.ts 同款
 *   "源码静态比对 + simulated logic"模式（前一轮 fixer 已验证有效）。
 *
 * **局限**：只能抓"代码不在了"的回归，抓不到"代码在但语义错了"的回归。
 * 语义部分由 packages/action-tools/src/base/types/__tests__/oss-upload-organization-isolation.test.ts
 * 的行为测试兜底（mock client.upload 验证优先级链路）。两者互补。
 *
 * 背景：C9 file_not_in_organization bug 收口审计建议
 * 详见 docs/agent/cli-spec/api-evolution-mutual-protection.md
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ACTION_BRIDGE_PATH = path.resolve(__dirname, '../src/application/execution/action-bridge.ts')
const REPO_ROOT = path.resolve(__dirname, '../../..')

function readRepoSrc(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8')
}

// ---------------------------------------------------------------------------
// 源码静态比对：注入代码段必须存在 + 位置正确
// ---------------------------------------------------------------------------
describe('C9 #5 — action-bridge 兜底注入 _organization_id', () => {
  const source = fs.readFileSync(ACTION_BRIDGE_PATH, 'utf-8')

  it('包含 `params._organization_id = this.config.organization_id` 兜底注入', () => {
    expect(source).toContain('params._organization_id = this.config.organization_id')
  })

  it('注入有 `!params._organization_id` 守卫（不覆盖已注入值）', () => {
    expect(source).toContain('if (!params._organization_id && this.config.organization_id)')
  })

  it('注入位置在 `_workspace_root` 兜底之后、enforcePolicy 调用之前', () => {
    const workspaceRootIdx = source.indexOf('params._workspace_root = params.working_directory')
    const organizationInjectIdx = source.indexOf('params._organization_id = this.config.organization_id')
    const enforcePolicyIdx = source.indexOf('this.enforcePolicy(actionType, params')
    expect(workspaceRootIdx).toBeGreaterThan(-1)
    expect(organizationInjectIdx).toBeGreaterThan(-1)
    expect(enforcePolicyIdx).toBeGreaterThan(-1)
    expect(organizationInjectIdx).toBeGreaterThan(workspaceRootIdx)
    expect(organizationInjectIdx).toBeLessThan(enforcePolicyIdx)
  })

  it('注释引用了 C9 file_not_in_organization 修复来源', () => {
    expect(source).toContain('C9 防御 #5')
    expect(source).toContain('file_not_in_organization')
  })
})

// ---------------------------------------------------------------------------
// Simulated injection 逻辑：验证 fallback 优先级语义
// ---------------------------------------------------------------------------
describe('C9 #5 — simulated _organization_id 注入逻辑', () => {
  function simulateInjection(
    config: { organization_id: string },
    rawParams: Record<string, any>,
  ) {
    const params = { ...rawParams }
    if (!params._organization_id && config.organization_id) {
      params._organization_id = config.organization_id
    }
    return params
  }

  it('SSE payload 没带 organization → 用 daemon config.organization_id 兜底', () => {
    const result = simulateInjection(
      { organization_id: 'wt-daemon-default' },
      { file_path: '/test', some_business_field: 'x' },
    )
    expect(result._organization_id).toBe('wt-daemon-default')
  })

  it('上游已注入 _organization_id（agent-runtime adapter 路径）→ 不覆盖', () => {
    const result = simulateInjection(
      { organization_id: 'wt-daemon-default' },
      { _organization_id: 'wt-explicit-from-upstream', file_path: '/test' },
    )
    expect(result._organization_id).toBe('wt-explicit-from-upstream')
  })

  it('业务参数 organization_id（无下划线前缀）不参与兜底（保持 LLM cross-organization 语义清晰）', () => {
    const result = simulateInjection(
      { organization_id: 'wt-daemon-default' },
      { organization_id: 'wt-business-arg', file_path: '/test' },
    )
    // 业务字段 organization_id 不被读，daemon config 仍兜底注入到 _organization_id
    expect(result._organization_id).toBe('wt-daemon-default')
    expect(result.organization_id).toBe('wt-business-arg')
  })

  it('daemon config 异常缺失（理论上不该发生）→ 不注入空串，保持 undefined 让下游链路继续 fallback', () => {
    const result = simulateInjection(
      { organization_id: '' },
      { file_path: '/test' },
    )
    expect(result._organization_id).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C9 防御 #7：cli-routes /oss/upload 透传 body.organization_id
// ---------------------------------------------------------------------------
describe('C9 #7 — cli-routes /oss/upload 透传 body.organization_id', () => {
  const source = readRepoSrc('packages/cli-routes/src/routes/oss.ts')

  it('包含 organizationId 字段透传给 uploadFileToOSS', () => {
    // 不死锁标点细节（留给格式工具弹性），但关键 token 必须齐：
    //   - organizationId: 字段名（uploadFileToOSS opts 字段）
    //   - body?.organization_id 字段名（CLI Go pipeline 注入的字段）
    //   - typeof === 'string' 字符串类型守卫（防 number / null 直接透传）
    expect(source).toMatch(/organizationId:/)
    expect(source).toMatch(/body\?\.organization_id/)
    expect(source).toMatch(/typeof\s+body\?\.organization_id\s*===\s*['"]string['"]/)
  })

  it('透传逻辑包含 || undefined 兜底（避免空串绕过下游 daemon 全局 fallback）', () => {
    // 关键：`(... && body.organization_id) || undefined` —— 不是 `body.organization_id || ''`。
    // 必须传 undefined 才能让 oss-upload.ts 的 `opts.organizationId || g?.tabtin?.organizationId`
    // fallback 跑起来；传空串会因 `'' || x` JS 真值规则跳到 daemon 全局 —— 这就是
    // 我们要的行为，但前提是 cli-routes 这层不能预先把 undefined 转成空串。
    expect(source).toMatch(/body\.organization_id\s*\)\s*\|\|\s*undefined/)
  })

  it('注释解释了 C9 修复来源（防代码"看不懂"被新人删掉）', () => {
    expect(source).toMatch(/organization_id/)
    // 注释里要有 daemon 全局 / per-request 概念说明，让接手人知道为什么不能简化
    expect(source).toMatch(/per-request|file_not_in_organization/)
  })
})

// ---------------------------------------------------------------------------
// C9 防御 #6：Electron bridge-core.ts 注入 global.tabtin.organizationId lazy getter
// ---------------------------------------------------------------------------
describe('C9 #6 — Electron bridge-core 注入 global.tabtin.organizationId lazy getter', () => {
  const source = readRepoSrc('apps/tabtin-electron/src/main/services/bridge-core.ts')

  it('使用 Object.defineProperty 而非固定赋值（必须 lazy 才能跟切 organization）', () => {
    // 固定 `global.tabtin.organizationId = currentOrganizationId` 在 setup 时拍死，
    // 用户切 organization 后过期 —— 必须 getter 每次访问跑函数拿真值。
    expect(source).toMatch(/Object\.defineProperty\s*\(\s*global\.tabtin,\s*['"]organizationId['"]/)
  })

  it('getter 代理到 getCLIOrganizationId （cli-context 的 SSoT，与 renderer 一致）', () => {
    expect(source).toMatch(/get:\s*\(\)\s*=>\s*getCLIOrganizationId\(\)/)
    // import 也要在文件顶部 —— 不然 getter 闭包根本拿不到符号
    expect(source).toMatch(/from\s+['"]\.\.\/cli\/cli-context['"]/)
    expect(source).toMatch(/getCLIOrganizationId/)
  })

  it('getter 守卫不重复注入（多 FrontendActionBridge 实例 / hot reload 场景）', () => {
    // `if (!Object.getOwnPropertyDescriptor(global.tabtin, 'organizationId')?.get)` 守卫
    // ：避免重复 defineProperty 抛 TypeError（configurable:true 实际不会抛，
    // 但保持幂等是好习惯）。
    expect(source).toMatch(/Object\.getOwnPropertyDescriptor\s*\(\s*global\.tabtin,\s*['"]organizationId['"]/)
  })

  it('注释引用了 C9 防御 #6 + file_not_in_organization 修复来源', () => {
    expect(source).toMatch(/C9 防御 #6/)
    expect(source).toMatch(/file_not_in_organization/)
  })
})

// ---------------------------------------------------------------------------
// DaemonConfig.organization_id 字段存在性 —— action-bridge 兜底注入的数据源
// ---------------------------------------------------------------------------
describe('C9 #5 配套 — DaemonConfig 携带 organization_id 字段', () => {
  it('shared/daemon-config.ts 声明 organization_id 字段', () => {
    // 防 daemon config schema 把 organization_id 字段删掉/重命名导致 action-bridge
    // 的 `this.config.organization_id` 永远 undefined → 兜底注入失效 → C9 复发。
    const source = readRepoSrc('apps/tabtin-daemon/src/base/types/daemon-config.ts')
    expect(source).toMatch(/organization_id\??\s*:\s*string/)
  })
})
