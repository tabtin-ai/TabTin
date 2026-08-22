/**
 * Wave 5a (L-W4-1) — RunSession observation → LLM 上下文注入器（Electron 端）。
 *
 * 用途：作为 `EngineConfig.getRecentRunObservations` 的具体实现 —— 每轮
 * ReAct loop 起始时 `agent-runtime` 调它一次，宿主从 `RunSessionManager`
 * 把当前 spaceId 下"自上次以来新增的"observation 拼成人话注入到 LLM。
 *
 * 设计要点：
 *   - **跨包契约**：`agent-runtime` 不直接 import `RunSessionManager` —— 通过
 *     此 callback 让 Electron 自己读取，与 `skillCredentialResolver` 注入模
 *     式同构。
 *   - **per-runtime 状态**：`lastReadTimestamp` 是闭包局部变量，跟随 runtime
 *     生命周期；多次调用幂等（"已读"自动推进）。session 切换 / runtime 重建
 *     会拿到新闭包 → lastReadTimestamp 自动重置为创建时刻，避免读到 runtime
 *     重建前的历史 observation 干扰新对话。
 *   - **类型映射**：把内部 observation type（`AGENT_AUTOFILL_FAILED` /
 *     `SPACE_ENV_CHANGED`）映射成给 LLM 看的人话；LLM 不该感知内部 type
 *     枚举，"凭据可能已过期"这类描述才是它需要的决策依据。
 *   - **安全硬底线**：humanReadable 文本**绝不**含密码、credential_id 明文。
 *     credentialId 字段我们只取前 6 字符（与 W4 短 hash 同模式，防 jwt 泄漏
 *     场景批量 reveal）。**任何**新增 observation type 在 formatter 落地前
 *     都必须人工确认 humanReadable 不携带敏感原文 — 见 Wave 4 反思 6
 *     文档化的"L-W4-1 P0 安全清单"。
 *   - **AGENT_AUTOFILL_SUCCESS 默认静默**：成功路径 Agent 看到登录后页面就
 *     够了，不重复打扰；如未来需要可通过 `includeSuccessObservation` 打开。
 *
 * Daemon 端独立实现一份对称版本（`apps/tabtin-daemon/src/agent/run-observation-injector.ts`）。
 */

import type { RunObservationInjection } from '@tabtin/agent-runtime/engine'
import type { RunObservationEvent } from '@shared/run-session-snapshot'
import { createLogger } from '../../logger'

const log = createLogger('RunObservationInjector')

/**
 * Lazy dynamic import：避免 RunSessionManager 在 module evaluation 阶段被拉入测试
 * 进程（autofill-service.ts 的 `recordAgentAutofillObservation` 同模式）。
 * RunSessionManager 间接依赖 electron `app.getPath` —— 单测环境中不希望
 * 仅因 import 类型就崩溃。
 *
 * W4.6 修复（2026-04-29 dogfood 现场）：原版用 CommonJS `require('../run-session/RunSessionManager')`，
 * electron-vite 把 ElectronAgentHost 打成 ESM `.mjs` chunk 后，require2 = createRequire(import.meta.url)
 * 按 bundle 文件位置（`out/main/ElectronAgentHost-<hash>.mjs`）解析相对路径，
 * 实际找的是 `out/run-session/RunSessionManager` —— 不存在 → 每轮 ReAct loop emit
 * `run_observation_inject_error` system_notice 污染日志，且本 callback 形同虚设。
 *
 * 改成 `await import(...)` 后 vite 能静态分析路径，把 RunSessionManager 跟着
 * 打进 bundle，运行时按 chunk 位置正确解析（已验证 RunSessionManager class 在
 * `main-app-<hash>.mjs` 中可用）。dynamic import 仍是 lazy —— 模块 evaluation
 * 阶段不会触发 RunSessionManager 加载，单测隔离的设计意图保留。
 */
async function getRunSessionManagerLazy(): Promise<{
  listObservationsBySpaceSince: (spaceId: string, since: number) => RunObservationEvent[]
}> {
  const mod = await import('../../run-session/RunSessionManager')
  return mod.getRunSessionManager()
}

/**
 * Wave 5a：仅以下 type 会被注入到 LLM 上下文。新增 type **必须**：
 *   1. 在 formatter 中加分支，确认 humanReadable 不含敏感原文；
 *   2. 在文档（PRD / 总控）登记新 observation 的语义；
 *   3. 在 e2e 加扫密码 sentinel 的安全断言。
 */
const LLM_INJECTABLE_OBSERVATION_TYPES = new Set([
  'AGENT_AUTOFILL_FAILED',
  'SPACE_ENV_CHANGED',
])

interface AutofillFailedData {
  credentialId?: string
  domain?: string
  matchCount?: number
  code?: string
  detail?: string
  submitVia?: string
}

interface SpaceEnvChangedData {
  spaceId?: string
  reason?: string
  environmentId?: string
  diagnosticNote?: string
}

/**
 * 截短 credentialId 为前 6 字符 + `…`，避免完整 ID 泄漏到 LLM 上下文（即便
 * credential_id 本身不是密码，泄漏给 LLM 也违反 PRD §Story 5 V1 安全约束）。
 *
 * 注意：保留前 6 字符够给排查路径"截屏给运维"提供索引线索，又不给"泄漏后
 * 批量 reveal"提供完整 ID。
 */
function shortCredentialIdHint(id: string | undefined): string {
  if (!id || typeof id !== 'string') return ''
  if (id.length <= 6) return ` (cred:${id})`
  return ` (cred:${id.slice(0, 6)}…)`
}

/**
 * 把 AGENT_AUTOFILL_FAILED 的 code 字段映射成给 LLM 看的人话。
 *
 * 不暴露内部 code 字面量（`credential-unavailable` / `fill-failed` 等）—
 * 让 Agent 看到的是"凭据可能已过期"这种业务级描述，方便 LLM 直接对用户
 * 转述或决策下一步。
 */
function reasonForAutofillCode(code: string | undefined): string {
  switch (code) {
    case 'credential-unavailable':
      return '凭据可能已过期或失效，建议提示用户更新密码'
    case 'fill-failed':
      return '页面表单结构异常或域名不匹配，无法填入凭据'
    case 'submit-failed':
      return '密码已填入登录表单但未自动提交，建议提示用户手动点击登录'
    case 'reveal-fn-not-configured':
      return '凭据库尚未就绪（可能需要用户重新登录主账号）'
    default:
      return code ? `失败原因：${code}` : '未知失败原因'
  }
}

function formatAutofillFailed(obs: RunObservationEvent): string {
  const data = (obs.data ?? {}) as AutofillFailedData
  const domain = data.domain || '该网站'
  const reason = reasonForAutofillCode(data.code)
  const credHint = shortCredentialIdHint(data.credentialId)
  return `[Browser autofill] 自动登录 ${domain} 失败：${reason}${credHint}。`
}

function formatSpaceEnvChanged(obs: RunObservationEvent): string {
  const data = (obs.data ?? {}) as SpaceEnvChangedData
  const reason = data.reason ? `（原因：${data.reason}）` : ''
  return `[Browser env] 当前 Space 的登录环境已被切换${reason}。本次任务继续使用旧 session 跑到结束；如需切到新 session，请等当前 run 完成后再发起新任务。`
}

function formatObservation(obs: RunObservationEvent): RunObservationInjection | null {
  if (!LLM_INJECTABLE_OBSERVATION_TYPES.has(obs.type)) return null
  let humanReadable: string
  switch (obs.type) {
    case 'AGENT_AUTOFILL_FAILED':
      humanReadable = formatAutofillFailed(obs)
      break
    case 'SPACE_ENV_CHANGED':
      humanReadable = formatSpaceEnvChanged(obs)
      break
    default:
      return null
  }
  return {
    humanReadable,
    type: obs.type,
    timestamp: obs.timestamp,
  }
}

export interface RunObservationInjectorHandle {
  injector: () => Promise<RunObservationInjection[]>
}

/**
 * 测试 hooks —— 仅暴露给单测 / e2e。
 *
 * 三视角 Review 视角 3 P2#3 + 视角 2 P1#5 自修：把 `__resetForTest` /
 * `__getLastReadTimestampForTest` 从正式 handle 接口剥离到独立类型，
 * 避免生产代码不慎调用。运行时仍走同一闭包，只是**不在** Handle 上挂。
 *
 * 单测 / e2e 通过 `getRunObservationInjectorTestHooks(handle)` 获取。
 */
export interface RunObservationInjectorTestHooks {
  getLastReadTimestamp: () => number
  reset: (newTs?: number) => void
}

const TEST_HOOKS = new WeakMap<RunObservationInjectorHandle, RunObservationInjectorTestHooks>()

/**
 * 仅供单测 / e2e 使用：拿到 injector 的 test hooks（重置游标 / 读游标）。
 * 生产代码若调用此函数等同于声明"我在做侵入式调试"——属于风格红线。
 */
export function getRunObservationInjectorTestHooks(
  handle: RunObservationInjectorHandle,
): RunObservationInjectorTestHooks | undefined {
  return TEST_HOOKS.get(handle)
}

export interface RunObservationInjectorOptions {
  spaceId: string | null | undefined
  /**
   * 测试桩：替代真实 `getRunSessionManager()`。允许单测注入 stub manager 而
   * 不必接 Electron 主进程依赖图。
   */
  rsmAccessor?: () => {
    listObservationsBySpaceSince: (
      spaceId: string,
      since: number,
    ) => RunObservationEvent[]
  }
}

/**
 * 构造 `EngineConfig.getRecentRunObservations` 的具体实现。
 *
 * 缺省 spaceId（runtime 未拿到当前 Space）→ 返回的 injector 永远 yield 空数组，
 * 安全降级（不 throw）—— 与"无 Space 上下文"的 ToolContext 行为对齐。
 */
export function createRunObservationInjector(
  options: RunObservationInjectorOptions,
): RunObservationInjectorHandle {
  const { spaceId, rsmAccessor } = options
  // 创建时间作为初始游标——避免读到 runtime 重建前的历史 observation。
  let lastReadTimestamp = Date.now()

  const injector = async (): Promise<RunObservationInjection[]> => {
    if (!spaceId) return []
    const rsm = rsmAccessor ? rsmAccessor() : await getRunSessionManagerLazy()
    let raw: RunObservationEvent[]
    try {
      raw = rsm.listObservationsBySpaceSince(spaceId, lastReadTimestamp)
    } catch (err) {
      // RunSessionManager 异常时不打断 ReAct loop；仅 warn。
      log.warn('listObservationsBySpaceSince 失败（降级为空注入）', { spaceId }, err)
      return []
    }
    if (raw.length === 0) return []

    const formatted: RunObservationInjection[] = []
    for (const obs of raw) {
      const item = formatObservation(obs)
      if (item) formatted.push(item)
    }

    // 推进游标：哪怕 formatter 全部 filter 掉（type 不在白名单），也按 raw
    // 最大 timestamp 推进。否则下一轮还会重新扫这些 observation —— O(n²)
    // 退化、且空 inject 路径没收益。
    const maxTs = raw[raw.length - 1]!.timestamp
    if (maxTs > lastReadTimestamp) lastReadTimestamp = maxTs

    return formatted
  }

  const handle: RunObservationInjectorHandle = { injector }
  TEST_HOOKS.set(handle, {
    getLastReadTimestamp: () => lastReadTimestamp,
    reset: (newTs?: number) => {
      lastReadTimestamp = newTs ?? Date.now()
    },
  })
  return handle
}
