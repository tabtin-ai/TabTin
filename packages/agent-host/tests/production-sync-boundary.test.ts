import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HOST_SHELL_PATHS = {
  electron: '../../../apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts',
  daemon: '../../../apps/tabtin-daemon/src/agent/DaemonAgentHost.ts',
} as const

/** Runtime assemblies hold createRuntime / soft / CostCap (extracted from Host shells). */
const ELECTRON_RUNTIME_ASSEMBLY =
  '../../../apps/tabtin-electron/src/main/agent/runtime/electron-runtime-assembly.ts'
const DAEMON_RUNTIME_ASSEMBLY =
  '../../../apps/tabtin-daemon/src/agent/runtime/daemon-runtime-assembly.ts'

const hostShellSources = Object.fromEntries(
  Object.entries(HOST_SHELL_PATHS).map(([key, path]) => [
    key,
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'),
  ]),
) as Record<keyof typeof HOST_SHELL_PATHS, string>

const electronRuntimeSource = readFileSync(
  fileURLToPath(new URL(ELECTRON_RUNTIME_ASSEMBLY, import.meta.url)),
  'utf8',
)
const daemonRuntimeSource = readFileSync(
  fileURLToPath(new URL(DAEMON_RUNTIME_ASSEMBLY, import.meta.url)),
  'utf8',
)

/** Runtime-knowledge sources that must stay dual-end parity (assembly modules). */
const runtimeParitySources = {
  electron: electronRuntimeSource,
  daemon: daemonRuntimeSource,
} as const

describe('production host sync boundary', () => {
  it('does not construct the upload-less SyncQueue path', () => {
    for (const source of [...Object.values(hostShellSources), electronRuntimeSource]) {
      // Platform hosts must NEVER `new SyncQueue(...)` directly——upload-less
      // sync queues are a runtime-package internal seam owned by the shared
      // agent-runtime module. Hosts talk to sync exclusively via injected APIs.
      expect(source).not.toContain('new SyncQueue(')
      expect(source).not.toMatch(/\bsyncQueue\s*:/)
      expect(source).not.toContain('.syncQueue')
    }
  })

  it('does not carry the fossil "Daemon 无 soft" narrative in comments', () => {
    // 契约锁死：canSoftReconfigureByShellTier 双端等价，Daemon 与 Electron
    // 无差异。若源码里再冒出「Daemon 无 soft」这类历史遗留断言（明明现在
    // 支持 soft-reconfigure），说明有人在文档/注释层引入漂移——不允许。
    for (const source of Object.values(runtimeParitySources)) {
      expect(source).not.toMatch(/Daemon\s+无\s+soft/)
      expect(source).not.toMatch(/daemon\s+cannot\s+soft[- ]?reconfigure/i)
      // 硬钉「softReconfigureAllowed: false」这类固化拒绝——两端都应把决策
      // 下沉给 canSoftReconfigureByShellTier，不允许在 host adapter 里写死 false。
      expect(source).not.toMatch(/softReconfigureAllowed\s*:\s*false/)
    }
  })

  it('routes query through the composed deep-module engine, not a host-owned skeleton', () => {
    // agent-host-full-migration cutover: hosts no longer own the query turn.
    // They compose the three deep modules and submit normalized HostQueries.
    for (const source of Object.values(hostShellSources)) {
      expect(source).toMatch(/composeQueryEngine\s*</)
      expect(source).toMatch(/submitHostQuery\s*\(/)
      // The legacy per-turn skeleton/pipeline/loop must be gone from the host.
      expect(source).not.toMatch(/\brunHostedQuery\s*\(/)
      // 只禁声明/调用形态，避免注释里提到历史方法名误伤。
      expect(source).not.toMatch(
        /(?:(?:async\s+)?(?:private|public|protected)\s+)?(?:async\s+)?executeQueryInternal\s*[\(<]/,
      )
    }
  })

  it('holds no shadow "runningSessions" busy Set on platform hosts', () => {
    // 阶段 4 · 删影子忙闲：忙闲权威源统一到 sharedHost.isBusy（走 coordinator
    // 的 ConversationRunQueue）。宿主不允许再挂一份 `runningSessions`
    // Set/Map 做二次真相源——检查字段声明形态，避免旧手写心智回流。
    for (const source of [...Object.values(hostShellSources), electronRuntimeSource]) {
      expect(source).not.toMatch(
        /^\s*(?:private\s+(?:readonly\s+)?)?runningSessions\b/m,
      )
      expect(source).not.toMatch(/this\.runningSessions\s*=\s*new\s+Set/)
      expect(source).not.toMatch(/this\.runningSessions\.(?:has|add|delete|clear|size)/)
    }
  })

  it('both hosts drive soft-reconfigure via canSoftReconfigureByShellTier', () => {
    // 契约测：Electron / Daemon 的 RuntimeSessionFactory adapter 都必须把
    // canSoftReconfigure 挂到 `canSoftReconfigureByShellTier`。任何"我这端
    // 不做软切换"的 side-branch 都视为漂移。
    for (const source of Object.values(runtimeParitySources)) {
      expect(source).toMatch(
        /canSoftReconfigure:\s*\(existing,\s*request\)\s*=>\s*canSoftReconfigureByShellTier\(/,
      )
    }
  })

  it('both hosts route compact through the sharedHost.submitRun facade', () => {
    // 阶段 4 · 门面：compact 旁路必须走 sharedHost.submitRun（同一 coordinator
    // FIFO），不允许再直连平台侧 coordinator。
    for (const source of Object.values(hostShellSources)) {
      expect(source).toMatch(/(?:requireSharedHost\(\)|this\.sharedHost)\.submitRun\(submission\)/)
    }
  })

  it('both hosts share SubagentManager / BudgetTracker carry-forward via resolveSubagentCarryForward', () => {
    // W4a S3③（PR2 review P1 修复）SSoT：两端 host 都必须走
    // `resolveSubagentCarryForward`（`@tabtin/agent-host/runtime`）决定
    // Manager 复用 + budgetTracker 条件式复用，避免任一端漏改让"后台子跑 +
    // runtime 硬重建 → 并发击穿 maxActive"或"复用旧 Manager 但没 rebind live
    // deps"这类根因型 bug 复活。
    for (const source of Object.values(runtimeParitySources)) {
      expect(source).toMatch(/\bresolveSubagentCarryForward\s*\(/)
      // 完成通知的 spaceId 也统一走 helper，避免两端派生顺序漂移。
      expect(source).toMatch(/\bresolveSubagentCompletionSpaceId\s*\(/)
    }
  })

  it('both hosts provide a QueryTurnDataPort instead of driving the pipeline inline', () => {
    // agent-host-full-migration cutover: the PD-13 authoritative mutate +
    // attachment/effective-prompt + main loop now live inside QueryTurnPipeline
    // (agent-host). Each host only supplies a QueryTurnDataPort (data/IO) and a
    // QueryRequest → HostQuery mapper; it must NOT call the pipeline/loop itself.
    for (const source of Object.values(hostShellSources)) {
      expect(source).toMatch(/QueryTurnDataPort</)
      expect(source).toMatch(/mapToHostQuery\s*\(/)
      expect(source).not.toMatch(/\brunQueryExecutionPipeline\s*(?:<[^>]*>)?\s*\(/)
      expect(source).not.toMatch(/\brunQueryStreamTurn\s*\(/)
    }
  })

  it('does not pass legacy conversation execute through AgentPlatformAdapter', () => {
    for (const source of Object.values(hostShellSources)) {
      expect(source).not.toMatch(/AgentHost\.start[\s\S]{0,6000}conversation:\s*\{/)
    }
  })

  it('does not route facade APIs through sharedHost-with-core fallback', () => {
    for (const source of Object.values(hostShellSources)) {
      expect(source).not.toMatch(/sharedHost\?\.\w+\([^)]*\)\s*\?\?\s*this\.core\.\w+/)
      expect(source).not.toMatch(/\?\?\s*this\.core\.submitRun\s*\(/)
    }
  })

  it('must not inject a platform-owned coordinator into AgentHost.start adapter', () => {
    for (const source of Object.values(hostShellSources)) {
      expect(source).not.toMatch(/coordinator:\s*this\.core/)
    }
  })

  it('must not construct AgentHostCoordinator inside platform host shells', () => {
    for (const source of Object.values(hostShellSources)) {
      expect(source).not.toMatch(/\bnew AgentHostCoordinator\s*[<(]/)
    }
  })

  it('both hosts装配 CostCap 走 buildCostCapConfig（W2.3-fix F8）', () => {
    // v2 execution_limits 归一 + CostCapInit 组合的 SSoT。两端 host 必须走
    // `buildCostCapConfig`（`@tabtin/agent-host/runtime`），不允许再自己 inline
    // `new CostCap({ config: { execution_limits: {...} } })` —— 那种写法在
    // Django stringify max_credits 场景下会静默失效（F8 根因）。
    for (const source of Object.values(runtimeParitySources)) {
      expect(source).toMatch(/\bbuildCostCapConfig\s*\(/)
    }
  })

  it('both assemblies route W6a storage + permission shell through agent-host helpers', () => {
    // createRuntime 装配下沉：SessionStorage 束 + ApprovalMemo/permission 外壳
    // 必须走 `@tabtin/agent-host/runtime` 的共享 helper，禁止双端再各自
    // `new SessionStorage` / `createApprovalMemoStore` 内联一份。
    for (const source of Object.values(runtimeParitySources)) {
      expect(source).toMatch(/\bcreateSessionStorageBundle\s*\(/)
      expect(source).toMatch(/\bassemblePermissionShell\s*\(/)
      expect(source).not.toMatch(/\bnew SessionStorage\s*\(/)
      expect(source).not.toMatch(/\bcreateApprovalMemoStore\s*\(/)
    }
  })
})
