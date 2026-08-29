import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Device } from '@tabtin/app-shell'
import { buildDevInspectorBridge } from './dev-inspector-bridge'
import type { LocalNetworkAddress } from '../shared/types/local-network'
import {
  invokeIpc,
  sendIpc,
  PlatformIpcError,
  LEGACY_HANDLERS,
  subscribeIpcCalls,
} from './ipc-shim'
import {
  getAccessTokenDeduped,
  installAuthTokenInvalidationListeners,
} from './auth-token-dedup'
import { createLoginRelayPreloadApi } from './login-relay'
import type { LoginRelayAPI } from '../shared/types/login-relay'
import type { BrowserTabControlSnapshot } from '../main/browser-tab-lock/browserTabInputLock'
import {
  BROWSER_CONTEXT_MENU_ADD_TO_CONTEXT_CHANNEL,
  type BrowserContextMenuAddToContextPayload,
} from '../shared/browser-context-menu-channels'
import {
  OSS_CANCEL_PRESIGNED_DOWNLOAD_CHANNEL,
  OSS_CANCEL_PRESIGNED_OBJECT_CHANNEL,
  OSS_GET_PRESIGNED_OBJECT_CHANNEL,
  OSS_PUT_PRESIGNED_OBJECT_CHANNEL,
  OSS_PUT_PRESIGNED_OBJECT_PROGRESS_CHANNEL,
  type OssGetPresignedObjectPayload,
  type OssGetPresignedObjectResult,
  type OssPutPresignedObjectPayload,
  type OssPutPresignedObjectProgress,
  type OssPutPresignedObjectResult,
} from '../shared/oss-presigned-upload-ipc'
import { hasAgentEngineUserInputContent } from '../shared/agent-engine-query-validation'
import { parseBrowserContainerModeFromArgv } from '../shared/browser-container-mode'
import type {
  ReplaceInFilesRequest,
  ReplaceInFilesResponse,
  RipgrepSearchOptions,
  RipgrepSearchResponse,
} from '../shared/ripgrep-search-types'
import {
  SESSION_CODE_ROOT_CHANGED_CHANNEL,
  type SessionCodeRootChangedEvent,
} from '../shared/session-code-root-events'
// 外部 Agent 导入 surface 契约类型（type-only，构建期擦除、零运行时字节）。
import type {
  ImportDetectOutput,
  ImportScanInput,
  ImportScanResult,
  ImportRunInput,
  ImportRunOutput,
  ImportStatusInput,
  ImportStatusOutput,
  ImportCancelInput,
  ImportCancelOutput,
  ImportRollbackInput,
  ImportRollbackOutput,
  ImportProgressEvent,
} from '@tabtin/cli-server-core'

installAuthTokenInvalidationListeners()

// W2-α (contract) — preload 内 ipc-shim 已接管所有 IPC 调用入口。
// 文件内剩余的 ipcRenderer 直接引用，业务 invoke/send 全部为 0 处：
//   - 1 处 ipcRenderer.sendSync('pty:snapshot-save-sync', ...) — 同步 IPC 特例
//     （W2-δ 会单独加 sender guard，行号见下方实际调用点）
//   - 1 处 ipcRenderer.setMaxListeners(100) — 文件末尾全局阈值放宽
//   - 各处 ipcRenderer.on / removeListener / once / removeAllListeners — 事件
//     订阅模式（不属于 invoke/send，本期不归 ipc-shim 管，W2-ζ IpcInspector
//     的 HTTP 路径接管 main → renderer push 一类）
// 业务 invoke/send 全部走 invokeIpc / sendIpc。renderer 端通过 window.tabtin.*
// 调用，preload 不需要再 import ipc-shim 之外的东西。
//
// PlatformIpcError / LEGACY_HANDLERS / subscribeIpcCalls 三个 symbol 在这里
// "保活"——它们是给 IpcInspector / withToast / 后续 review 工具用的同一份
// 契约定义，避免别处横切 import 走错版本。
void PlatformIpcError
void LEGACY_HANDLERS
void subscribeIpcCalls

export interface OrganizationDeviceModelPreferences {
  mainModelId?: string
  subagentModelId?: string
}

/**
 * overlay 事件订阅样板：`ipcRenderer.on(channel)` + 返回取消订阅函数。
 * window.tabtin.overlay 的多个 onX（subscribePush / onConfirmResult / ...）共用。
 */
function overlayOn<T = unknown>(channel: string) {
  return (callback: (payload: T) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
}

type ApiProxyRequest = {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  multipartEntries?: Array<{ name: string; filename?: string; contentType?: string; base64: string }>
  retryConfig?: {
    maxRetries?: number
    retryDelay?: number
    retryBackoff?: number
    retryableStatuses?: number[]
  }
}

type ApiProxyResponse<T = any> = {
  status: number
  statusText?: string
  headers?: Record<string, string | string[] | undefined>
  data?: T
  retryAfter?: number
}

type BrowserZoomLevelChangedPayload = {
  tabId: string
  level: number
}

type AuthStorageData = {
  accessToken?: string | null
  refreshToken?: string | null
  userInfo?: any | null
}

type AuthGetLegacyResult =
  | { success: true; data?: AuthStorageData | null }
  | { success: false; error?: string }

type AuthLoadResult = {
  accessToken: string | null
  refreshToken: string | null
  user: any | null
}

type AuthRefreshResult = {
  accessToken: string
  errorCode?: string
  isTransient?: boolean
}

type AuthRefreshLegacyResult =
  | { success: true; accessToken: string }
  | { success: false; errorCode: string; message: string; isTransient: boolean }

function unwrapAuthGetResult(result: AuthGetLegacyResult): AuthStorageData | null {
  if (result.success) return result.data ?? null
  throw new Error(result.error || 'Failed to get auth bundle')
}

function unwrapAuthRefreshResult(result: AuthRefreshLegacyResult): AuthRefreshResult {
  if (result.success) return { accessToken: result.accessToken }

  const error = new Error(result.message || 'Token refresh failed') as Error & {
    authErrorCode?: string
    isTransient?: boolean
  }
  error.authErrorCode = result.errorCode
  error.isTransient = result.isTransient
  throw error
}

// ── agentEngine 运行时校验 ──────────────────────────────────────────
// 不用 zod 是因为 preload bundle 体积敏感，不能 import @tabtin/agent-wire。
// 手写的轻量校验在 IPC 边界拦截结构错误（如 agentMode 拼错成 agentmodel），
// 让错误在 renderer → main 跨进程之前暴露，而非到了主进程才静默 undefined。
//
// VALID_AGENT_MODES 直接从 SSoT `AGENT_MODE_NAMES` 构造，未来新增 mode（如已
// 含的 'yolo' / 未来可能的其它档）自动同步——避免历史 bug：白名单缺 'yolo'
// 导致用户在 ChatInput 选 Yolo IPC throw（H1）。

const VALID_AGENT_MODES = new Set<string>(AGENT_MODE_NAMES)
//  三档审批策略：approvalMode 枚举校验与 agentMode 同构（SSoT 构造）。
const VALID_APPROVAL_MODES = new Set<string>(APPROVAL_MODE_NAMES)
// VALID_PLAN_OUTCOMES：旧 plan_exit 审批通道字段，已随 PlanProposalCard 重构移除。

/**
 * 合法 ContentBlock.type 白名单。
 *
 * **SYNCED FROM** `packages/agent-wire/src/block-types.ts` `ALL_BLOCK_TYPES`
 * （22 case = 16 标准 Anthropic + 6 tabtin_*）。
 *
 * preload 是 sandbox 环境不能 runtime-import @tabtin/agent-wire 包（bundle
 * 体积敏感 + 子路径解析限制），所以这里做静态白名单——**新增 ContentBlock
 * 变体时必须同步更新本常量与 block-types.ts ALL_BLOCK_TYPES**，否则：
 * - 含新 type 的历史 IPC 装填会被 preload 静默拒收
 * - 含 tabtin_* block 的 history 在 IPC 边界直接被拒
 *
 * **W4c 联合 Review P1-3 修复**：之前只列 5 类（text/tool_use/tool_result/
 * thinking/image），与 W4a/W4b 实际渲染的 22 类不一致——含 tabtin_skill_invocation
 * / tabtin_approval_request / tabtin_rich_content 等的 history 在 preload
 * 边界被拒。本次扩展到完整 22 类，与 ALL_BLOCK_TYPES 1:1 同步。
 *
 * **W7 收口**：把 ALL_BLOCK_TYPES 从 @tabtin/agent-wire vendored 进 preload
 * sandbox（拷贝构建脚本而非 runtime import），实现编译期联锁。
 *
 * @see packages/agent-wire/src/block-types.ts - 单源契约
 */
const VALID_CONTENT_BLOCK_TYPES = new Set<string>([
  // 16 标准 Anthropic block.type（v2 §2.2.1）
  'text',
  'tool_use',
  'tool_result',
  'thinking',
  'redacted_thinking',
  'image',
  'document',
  'server_tool_use',
  'web_search_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'mcp_tool_use',
  'mcp_tool_result',
  'container_upload',
  'search_result',
  // 6 TabTin 受控扩展 block.type（v2 §2.2.3 + W4c 全栈渲染）
  'tabtin_rich_content',
  'tabtin_composer_preset',
  'tabtin_ask_user_fields',
  'tabtin_skill_invocation',
  'tabtin_source_ref',
  'tabtin_approval_request',
])

export function validateAgentEngineQuery(req: unknown): void {
  if (req == null || typeof req !== 'object') {
    throw new Error('Invalid agentEngine.query payload: expected an object')
  }
  const r = req as Record<string, unknown>
  if (typeof r.prompt !== 'string') {
    throw new Error('Invalid agentEngine.query payload: prompt must be a string')
  }
  // §17.6 D4：字段从原 `sessionId` 改名 `threadId`（与
  // `AgentEngineQueryRequest`/main 端 `QueryRequest`/`LocalAgentClient` 对齐）。
  // 改名重构曾遗漏此校验器，导致 client 传 `threadId` 但 preload 仍卡
  // `sessionId` → 整条 IPC 在 preload 边界静默挂死、主进程收不到 query。
  if (typeof r.threadId !== 'string' || !r.threadId) {
    throw new Error('Invalid agentEngine.query payload: threadId must be a non-empty string')
  }
  if (typeof r.workspaceId !== 'string' || !r.workspaceId) {
    throw new Error('Invalid agentEngine.query payload: workspaceId must be a non-empty string')
  }
  if (r.executionTarget !== undefined) {
    const target = r.executionTarget as Record<string, unknown> | null
    if (
      !target
      || typeof target !== 'object'
      || Array.isArray(target)
      || target.kind !== 'bound_device'
      || typeof target.device_identity_key !== 'string'
      || !target.device_identity_key
    ) {
      throw new Error('Invalid agentEngine.query payload: executionTarget is invalid')
    }
  }
  if (r.displayMessage !== undefined && typeof r.displayMessage !== 'string') {
    throw new Error('Invalid agentEngine.query payload: displayMessage must be a string')
  }
  //  斜杠命令直链 Skill：skillSlashInvoke 可选，形态 { skillKey: string, args?: string }。
  if (r.skillSlashInvoke !== undefined) {
    const ssi = r.skillSlashInvoke as { skillKey?: unknown; args?: unknown } | null
    if (!ssi || typeof ssi !== 'object' || Array.isArray(ssi) || typeof ssi.skillKey !== 'string' || !ssi.skillKey) {
      throw new Error('Invalid agentEngine.query payload: skillSlashInvoke.skillKey must be a non-empty string')
    }
    if (ssi.args !== undefined && typeof ssi.args !== 'string') {
      throw new Error('Invalid agentEngine.query payload: skillSlashInvoke.args must be a string')
    }
  }
  if (r.agentMode !== undefined && !VALID_AGENT_MODES.has(r.agentMode as string)) {
    throw new Error(
      `Invalid agentEngine.query payload: agentMode must be one of ${[...VALID_AGENT_MODES].join(', ')}; got "${String(r.agentMode)}"`,
    )
  }
  if (r.approvalMode !== undefined && !VALID_APPROVAL_MODES.has(r.approvalMode as string)) {
    throw new Error(
      `Invalid agentEngine.query payload: approvalMode must be one of ${[...VALID_APPROVAL_MODES].join(', ')}; got "${String(r.approvalMode)}"`,
    )
  }
  if (r.maxTurns !== undefined && (typeof r.maxTurns !== 'number' || r.maxTurns < 1)) {
    throw new Error('Invalid agentEngine.query payload: maxTurns must be a positive number')
  }
  if (r.attachments !== undefined && !Array.isArray(r.attachments)) {
    throw new Error('Invalid agentEngine.query payload: attachments must be an array')
  }
  if (r.userMessageBlocks !== undefined) {
    if (!Array.isArray(r.userMessageBlocks)) {
      throw new Error('Invalid agentEngine.query payload: userMessageBlocks must be an array')
    }
    for (let i = 0; i < r.userMessageBlocks.length; i++) {
      const block = r.userMessageBlocks[i]
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new Error(`Invalid agentEngine.query payload: userMessageBlocks[${i}] must be an object`)
      }
    }
  }
  //  引用回复：replyTo 可选，形态 { messageId: string, preview?: {...} }。
  if (r.replyTo !== undefined) {
    const rt = r.replyTo as { messageId?: unknown } | null
    if (!rt || typeof rt !== 'object' || Array.isArray(rt) || typeof rt.messageId !== 'string' || !rt.messageId) {
      throw new Error('Invalid agentEngine.query payload: replyTo.messageId must be a non-empty string')
    }
  }
  // ：原始 @ / preset blocks；Host ACK 后拼装。
  if (r.contextBlocks !== undefined) {
    if (!Array.isArray(r.contextBlocks)) {
      throw new Error('Invalid agentEngine.query payload: contextBlocks must be an array')
    }
    for (let i = 0; i < r.contextBlocks.length; i++) {
      const block = r.contextBlocks[i]
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new Error(`Invalid agentEngine.query payload: contextBlocks[${i}] must be an object`)
      }
    }
  }
  if (!hasAgentEngineUserInputContent(r.prompt, r.attachments, r.contextBlocks)) {
    throw new Error('Invalid agentEngine.query payload: prompt, attachments, or contextBlocks must contain user content')
  }
  // W7b M3：宽松校验 — memoryCapability 必须是 boolean；operationSwitches 必须是 plain object
  // 其内部 key/value 由后端 mergeOperationSwitches 做合法性过滤（非法值忽略），
  // preload 不强校验避免与 @tabtin/security-policy 形成耦合。
  if (r.memoryCapability !== undefined && typeof r.memoryCapability !== 'boolean') {
    throw new Error('Invalid agentEngine.query payload: memoryCapability must be a boolean')
  }
  // work_mode：workingDirType 驱动 system prompt 的 `<work_mode>` 段。边界只挡
  // 形式（必须是合法枚举或缺省）；非法值在 main 装配阶段被 normalize 成
  // undefined（跳过段注入），与 memoryCapability 边界宽松校验同构。
  if (
    r.workingDirType !== undefined
    && r.workingDirType !== 'code'
    && r.workingDirType !== 'doc'
    && r.workingDirType !== 'mixed'
  ) {
    throw new Error('Invalid agentEngine.query payload: workingDirType must be one of code/doc/mixed')
  }
  if (r.workingDir !== undefined && (typeof r.workingDir !== 'string' || !r.workingDir.trim())) {
    throw new Error('Invalid agentEngine.query payload: workingDir must be a non-empty string when provided')
  }
  // Hilt v3 / W6 M1：yoloMode 必须是 boolean。缺省视为 false（同 createRuntimeForSession 默认）。
  if (r.yoloMode !== undefined && typeof r.yoloMode !== 'boolean') {
    throw new Error('Invalid agentEngine.query payload: yoloMode must be a boolean')
  }
  // PR4-yolo (PRD v3 §5.4.2)：isGroupSpace 必须是 boolean（非 strict——缺省
  // false 即可，不抛）。main 进程 policyContext.isGroupSpace 用此字段闭合
  // group ⊥ yolo 互斥的本机闸；任意非 boolean 形态在边界 fail-fast 暴露。
  if (r.isGroupSpace !== undefined && typeof r.isGroupSpace !== 'boolean') {
    throw new Error('Invalid agentEngine.query payload: isGroupSpace must be a boolean')
  }
  // ：会话代码根绑定——只挡形式（非空字符串 / 有限数字），真正的
  // 存在性 + Git worktree 校验在 main 端 `resolveExecutionWorkspaceRoot` /
  // `bind-session-code-root` 完成（preload 不碰文件系统）。
  if (r.boundCodeRoot !== undefined && (typeof r.boundCodeRoot !== 'string' || !r.boundCodeRoot.trim())) {
    throw new Error('Invalid agentEngine.query payload: boundCodeRoot must be a non-empty string when provided')
  }
  if (
    r.boundCodeRootRevision !== undefined
    && (typeof r.boundCodeRootRevision !== 'number' || !Number.isFinite(r.boundCodeRootRevision))
  ) {
    throw new Error('Invalid agentEngine.query payload: boundCodeRootRevision must be a finite number when provided')
  }
  if (r.operationSwitches !== undefined && (
    r.operationSwitches === null
    || typeof r.operationSwitches !== 'object'
    || Array.isArray(r.operationSwitches)
  )) {
    throw new Error('Invalid agentEngine.query payload: operationSwitches must be a plain object')
  }
  // W2.3-fix（F8）：v2 cost.execution_limits 透传给主进程装配 CostCap.config。
  // preload 只挡形式（必须是 plain object 或缺省）；字段类型 / 范围由主进程
  // `normalizeExecutionLimitsForCostCap` 统一归一（含 string max_credits 接受、
  // 0 / 负数视作未配置等业务规则）。这样规则只在一处维护，避免双端 drift。
  if (r.executionLimits !== undefined && (
    r.executionLimits === null
    || typeof r.executionLimits !== 'object'
    || Array.isArray(r.executionLimits)
  )) {
    throw new Error('Invalid agentEngine.query payload: executionLimits must be a plain object')
  }
  // W1b：模型能力数据校验 — 可选有限正整数。旧版渲染层不传（undefined），主进程 fallback。
  // 注意 NaN < 1 为 false，必须用 Number.isFinite 显式排除。
  if (r.modelContextWindow !== undefined && (typeof r.modelContextWindow !== 'number' || !Number.isFinite(r.modelContextWindow) || r.modelContextWindow < 1)) {
    throw new Error('Invalid agentEngine.query payload: modelContextWindow must be a positive finite number')
  }
  if (r.modelMaxOutput !== undefined && (typeof r.modelMaxOutput !== 'number' || !Number.isFinite(r.modelMaxOutput) || r.modelMaxOutput < 1)) {
    throw new Error('Invalid agentEngine.query payload: modelMaxOutput must be a positive finite number')
  }
  // 当前 chat 所属 Space / Organization id —— 主进程优先于 `getCLISpaceId()` 单例
  // 使用，根因修复"全局单例 race 导致 session 落 _unscoped + ShellCap 撞硬契约"
  // 的链路（详见 ElectronAgentHost.QueryRequest.spaceId 注释）。renderer 缺省
  // 传时主进程 fallback 到 CLI 单例，仍保留老行为。
  if (r.spaceId !== undefined && (typeof r.spaceId !== 'string' || r.spaceId.length === 0)) {
    throw new Error('Invalid agentEngine.query payload: spaceId must be a non-empty string when provided')
  }
  if (r.organizationId !== undefined && (typeof r.organizationId !== 'string' || r.organizationId.length === 0)) {
    throw new Error('Invalid agentEngine.query payload: organizationId must be a non-empty string when provided')
  }
  if (r.history !== undefined) {
    if (!Array.isArray(r.history)) {
      throw new Error('Invalid agentEngine.query payload: history must be an array')
    }
    for (let i = 0; i < r.history.length; i++) {
      const item = r.history[i] as { role?: unknown; content?: unknown } | null | undefined
      if (!item || typeof item !== 'object') {
        throw new Error(`Invalid agentEngine.query payload: history[${i}] must be an object`)
      }
      if (item.role !== 'user' && item.role !== 'assistant') {
        throw new Error(
          `Invalid agentEngine.query payload: history[${i}].role must be "user" or "assistant"; got "${String(item.role)}"`,
        )
      }
      // Wave "连续对话成熟化 P · 事 1"：content 升级到 `string | ContentBlock[]`，
      // 历史 tool_use / tool_result 对通过 block 数组形态跨 IPC 透传到 main → runtime。
      //   - string：MVP 兼容路径（纯文本 user / assistant）
      //   - ContentBlock[]：带 tool 链（至少一个 text / tool_use / tool_result block）
      // 校验目标：把"坏 payload"在 IPC 边界挡下而不是到 main / LLM 才报错。
      const content = item.content
      if (typeof content === 'string') {
        if (content.trim().length === 0) {
          throw new Error(
            `Invalid agentEngine.query payload: history[${i}].content must be non-empty`,
          )
        }
      } else if (Array.isArray(content)) {
        if (content.length === 0) {
          throw new Error(
            `Invalid agentEngine.query payload: history[${i}].content must be a non-empty array`,
          )
        }
        for (let j = 0; j < content.length; j++) {
          const block = content[j] as { type?: unknown } | null | undefined
          if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
            throw new Error(
              `Invalid agentEngine.query payload: history[${i}].content[${j}] must be an object with string type`,
            )
          }
          // 只接受 runtime `ContentBlock` union 认识的 type。thinking 虽在
          // whitelist 但 @tabtin/agent-runtime/history 的装填逻辑会显式丢弃——
          // 这里保留 thinking 白名单仅为前向兼容（万一未来启用装填），
          // 不是鼓励当前 renderer 传 thinking。
          const t = block.type
          if (!VALID_CONTENT_BLOCK_TYPES.has(t)) {
            throw new Error(
              `Invalid agentEngine.query payload: history[${i}].content[${j}].type "${t}" is not a supported ContentBlock type`,
            )
          }
          if (t === 'tool_use') {
            const b = block as { id?: unknown; name?: unknown }
            if (typeof b.id !== 'string' || b.id.length === 0) {
              throw new Error(
                `Invalid agentEngine.query payload: history[${i}].content[${j}] tool_use.id must be a non-empty string`,
              )
            }
            if (typeof b.name !== 'string' || b.name.length === 0) {
              throw new Error(
                `Invalid agentEngine.query payload: history[${i}].content[${j}] tool_use.name must be a non-empty string`,
              )
            }
          }
          if (t === 'tool_result') {
            const b = block as { tool_use_id?: unknown; content?: unknown }
            if (typeof b.tool_use_id !== 'string' || b.tool_use_id.length === 0) {
              throw new Error(
                `Invalid agentEngine.query payload: history[${i}].content[${j}] tool_result.tool_use_id must be a non-empty string`,
              )
            }
            // Review B P2 · preload 二次防线：runtime `ToolResultBlock.content`
            // 契约是 `string | ContentBlock[]`，旧 MVP 不校验会让 null / number /
            // object 穿过 IPC 边界到 LLM provider 才 400。
            if (
              b.content !== undefined
              && typeof b.content !== 'string'
              && !Array.isArray(b.content)
            ) {
              throw new Error(
                `Invalid agentEngine.query payload: history[${i}].content[${j}] tool_result.content must be a string or an array of ContentBlock (got ${typeof b.content})`,
              )
            }
          }
        }
      } else {
        throw new Error(
          `Invalid agentEngine.query payload: history[${i}].content must be a string or an array of ContentBlock`,
        )
      }
    }
  }
}

function validateModeSwitchExecutePayload(payload: unknown): void {
  if (payload == null || typeof payload !== 'object') {
    throw new Error('Invalid executeModeSwitch payload: expected an object')
  }
  const p = payload as Record<string, unknown>
  if (typeof p.sessionId !== 'string' || !p.sessionId) {
    throw new Error('Invalid executeModeSwitch payload: sessionId must be a non-empty string')
  }
  if (typeof p.proposalId !== 'string' || !p.proposalId) {
    throw new Error('Invalid executeModeSwitch payload: proposalId must be a non-empty string')
  }
  if (p.outcome !== 'approved' && p.outcome !== 'cancelled') {
    throw new Error('Invalid executeModeSwitch payload: outcome must be approved or cancelled')
  }
}

// Phase 3 F8/F9：UI 直接 setAgentMode 时通知主进程同步 cancel HITL + 记录 mode transition reminder
function validateNotifyModeSwitchedPayload(payload: unknown): void {
  if (payload == null || typeof payload !== 'object') {
    throw new Error('Invalid notifyModeSwitched payload: expected an object')
  }
  const p = payload as Record<string, unknown>
  if (typeof p.sessionId !== 'string' || !p.sessionId) {
    throw new Error('Invalid notifyModeSwitched payload: sessionId must be a non-empty string')
  }
  if (typeof p.toMode !== 'string' || !p.toMode) {
    throw new Error('Invalid notifyModeSwitched payload: toMode must be a non-empty string')
  }
  if (p.fromMode !== undefined && typeof p.fromMode !== 'string') {
    throw new Error('Invalid notifyModeSwitched payload: fromMode must be a string when provided')
  }
}

// ：UI 切审批档时通知主进程 live 更新运行中 session 的请求档 + 重拉权威 grant
function validateNotifyApprovalModeChangedPayload(payload: unknown): void {
  if (payload == null || typeof payload !== 'object') {
    throw new Error('Invalid notifyApprovalModeChanged payload: expected an object')
  }
  const p = payload as Record<string, unknown>
  if (typeof p.sessionId !== 'string' || !p.sessionId) {
    throw new Error('Invalid notifyApprovalModeChanged payload: sessionId must be a non-empty string')
  }
  if (typeof p.approvalMode !== 'string' || !p.approvalMode) {
    throw new Error('Invalid notifyApprovalModeChanged payload: approvalMode must be a non-empty string')
  }
}

function validateInvalidateAgentConfigCachePayload(payload: unknown): void {
  if (payload === undefined || payload === null) return
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid invalidateAgentConfigCache payload: expected an object')
  }
  const p = payload as Record<string, unknown>
  if (p.agentId !== undefined && typeof p.agentId !== 'string') {
    throw new Error('Invalid invalidateAgentConfigCache payload: agentId must be a string when provided')
  }
  if (p.workspaceId !== undefined && typeof p.workspaceId !== 'string') {
    throw new Error('Invalid invalidateAgentConfigCache payload: workspaceId must be a string when provided')
  }
}

function validateUpsertHostTurnStatePayload(payload: unknown): void {
  if (payload === undefined || payload === null) {
    throw new Error('Invalid upsertHostTurnState payload: expected an object')
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid upsertHostTurnState payload: expected an object')
  }
  const p = payload as Record<string, unknown>
  if (p.agent !== undefined) {
    if (typeof p.agent !== 'object' || p.agent === null || Array.isArray(p.agent)) {
      throw new Error('Invalid upsertHostTurnState payload: agent must be an object')
    }
    const agent = p.agent as Record<string, unknown>
    if (typeof agent.id !== 'string' || !agent.id.trim()) {
      throw new Error('Invalid upsertHostTurnState payload: agent.id must be a non-empty string')
    }
    if (
      agent.detail !== undefined
      && (typeof agent.detail !== 'object'
        || agent.detail === null
        || Array.isArray(agent.detail))
    ) {
      throw new Error('Invalid upsertHostTurnState payload: agent.detail must be an object')
    }
  }
  if (p.workspace !== undefined) {
    if (typeof p.workspace !== 'object' || p.workspace === null || Array.isArray(p.workspace)) {
      throw new Error('Invalid upsertHostTurnState payload: workspace must be an object')
    }
    const workspace = p.workspace as Record<string, unknown>
    if (typeof workspace.id !== 'string' || !workspace.id.trim()) {
      throw new Error('Invalid upsertHostTurnState payload: workspace.id must be a non-empty string')
    }
  }
  if (p.agent === undefined && p.workspace === undefined) {
    throw new Error('Invalid upsertHostTurnState payload: agent or workspace required')
  }
}

// ── 全局 console 拦截 ──────────────────────────────────────────────
// Electron console-message 事件对多参数 console.log('msg', obj) 只提供
// Chromium 预序列化的字符串，对象变成 [object Object]。
// contextIsolation=true 时 preload 和 renderer 主世界的 console 是两个对象，
// 需要分别拦截：preload context 直接重写，renderer 主世界通过 webFrame 注入。
const _consoleInterceptScript = `(function(){
  var _c={log:console.log,info:console.info,warn:console.warn,error:console.error,debug:console.debug};
  function s(o){
    if(o instanceof Error)return JSON.stringify({message:o.message,stack:o.stack});
    try{return JSON.stringify(o,null,0)}catch(e){
      try{var seen=new WeakSet();return JSON.stringify(o,function(k,v){
        if(typeof v==='object'&&v!==null){if(seen.has(v))return'[Circular]';seen.add(v)}return v
      },0)}catch(e2){return String(o)}
    }
  }
  function ser(a){return a.map(function(x){
    return x===void 0?'undefined':(typeof x==='object'&&x!==null)?s(x):x
  })}
  ['log','info','warn','error','debug'].forEach(function(l){
    var orig=_c[l];console[l]=function(){return orig.apply(console,ser([].slice.call(arguments)))}
  });
})()`;

// Preload context 拦截
;(() => {
  const _console = { ...console }
  function safeStringify(obj: unknown): string {
    if (obj instanceof Error) return JSON.stringify({ message: obj.message, stack: obj.stack })
    try { return JSON.stringify(obj, null, 0) } catch {
      try {
        const seen = new WeakSet()
        return JSON.stringify(obj, (_k, v) => {
          if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[Circular]'; seen.add(v) }
          return v
        }, 0)
      } catch { return String(obj) }
    }
  }
  function serialize(args: unknown[]): unknown[] {
    return args.map(a => a === undefined ? 'undefined' : (typeof a === 'object' && a !== null) ? safeStringify(a) : a)
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = _console[level]
    ;(console as any)[level] = (...args: unknown[]) => orig.apply(console, serialize(args))
  }
})()

// Renderer 主世界注入（跨越 contextIsolation 边界）
webFrame.executeJavaScript(_consoleInterceptScript).catch(() => {})
import type {
  RecommendationGeneratorResult,
  HistoryRecommendationResponse
} from '@tabtin/crawl-contracts/recommendation'
import {
  DownloadIPCChannels,
  type DownloadItemData,
  type DownloadIPCResult,
  type StreamProgressEvent,
  type StreamCompletedEvent,
  type StreamFailedEvent,
} from '@shared/types/download'
import type {
  PaneStatus,
  PaneStatusEvent,
  TerminalSnapshot,
  SnapshotManifest,
} from '@shared/types/terminal'
import type {
  DetectedBrowser,
  DetectBrowsersResult,
  IPCCookie,
  ExtractCookiesResult,
  ExtractPasswordsResult,
  CookieDomainSummary,
  PartitionCookieSummary,
} from '@shared/types/credential'
import type {
  BrowserEnvBinding,
  BrowserEnvBindResult,
  BrowserEnvDeleteResult,
  BrowserEnvGetPartitionResult,
  BrowserEnvironment,
  BrowserEnvWriteResult,
} from '@shared/types/browser-env'
import type {
  NavigateTarget,
  NotificationPayload,
  NotificationPermissionStatus,
} from '../main/services/notification/types'
import type {
  LocalMcpConnectionDetail,
  LocalMcpConnectionSummary,
  LocalMcpDiscoveryResult,
  LocalMcpManualConnectionInput,
  LocalMcpOrganizationMirrorInput,
  LocalMcpProbeSummary,
} from '@shared/types/mcp'
import type {
  ResourceMonitorSnapshot,
  ResourceMonitorSnapshotMode,
} from '@shared/types/resource-monitor'
import type {
  AgentEngineCompactSessionRequest,
  AgentEngineCompactSessionResponse,
  AgentEngineQueryRequest,
} from '@shared/types/agent-engine'
// 只 import 字面量常量；必须从 `@tabtin/agent-modes/types` 子路径导入，
// 不能走 index / agent-runtime barrel（会拉到 permission-path → node:fs）。
import { AGENT_MODE_NAMES, APPROVAL_MODE_NAMES } from '@tabtin/agent-modes/types'
import { onNotificationNavigate } from './notification-channel'
import { createCheckpointApi, type CheckpointApi } from './checkpoint'
import { createFileHistoryApi, type FileHistoryApi } from './file-history'
import { createFileEditPatchesApi, type FileEditPatchesApi } from './file-edit-patches'

type CrawlViewOptions =
  | {
      profile: string
      kind: 'workspace-view'
      crawlspaceId: string
      partition: string
      isPreview?: boolean
      allowPrivateHostNavigation?: boolean
    }
  | {
      profile: string
      kind: 'normal-view'
      crawlspaceId?: never
      partition?: string
      isPreview?: boolean
      allowPrivateHostNavigation?: boolean
    }

type ScreenshotCaptureOptions = {
  format?: 'png' | 'jpeg'
  quality?: number
  rect?: { x: number; y: number; width: number; height: number }
}

function assertCrawlViewOptions(
  options: CrawlViewOptions | undefined,
  _source: string
): CrawlViewOptions {
  if (!options) {
    return { kind: 'normal-view', profile: 'user-tab' }
  }
  if (!options.profile || !options.kind) {
    return { kind: 'normal-view', profile: options.profile || 'user-tab' }
  }
  return options
}

export type {
  GitBranchMeta,
  GitBranchItem,
  GitRemoteInfo as GitRemoteItem,
  GitWorktreeInfo as GitWorktreeItem,
  GitDiffFileSummary as GitDiffSummaryFileItem,
  GitDiffSummary,
  GitDiffStatGroup,
  GitDiffStatResult,
  GitStatusEntry,
  GitStatusResult,
  GitWorktreeMergeResult,
  WorktreeRemovePreflightResult,
  WorktreeRemoveResult,
  GitStashEntry,
  GitFullStatusResult,
  GitCommitListItem,
  GitCommitDetailResult,
} from '@shared/git-types'

import type {
  GitBranchMeta,
  GitBranchItem,
  GitRemoteInfo as GitRemoteItem,
  GitWorktreeInfo as GitWorktreeItem,
  GitDiffSummary,
  GitDiffStatResult,
  GitStatusEntry,
  GitWorktreeMergeResult,
  WorktreeRemovePreflightResult,
  WorktreeRemoveResult,
  GitStashEntry,
  GitFullStatusResult,
  GitCommitListItem,
  GitCommitDetailResult,
} from '@shared/git-types'

// preload API 契约形状（内部约束用，不直接导出）
/**
 * 「Agent 产物在 Space 内的打开」专题 W7 —— renderer ResourceRouter
 * 通过 `tabtin.resourceTelemetry.emit(event)` 把 ResourceOpenEvent 转 IPC
 * 给 main 进程 telemetry queue 批量上报。
 *
 * Schema 字符级镜像 `@tabtin/resource-router/types.ResourceOpenEvent`，
 * 故意不直接 import 那个类型——preload bundle 体积敏感且 contextBridge
 * 序列化只接受 plain object，原始 type union 在跨进程边界上会被 erase。
 */
interface ResourceOpenEventPayload {
  event_name: string
  trigger_source: string
  pointer_scheme: string
  pointer_type: string | null
  pointer_id_hash: string
  hint_app_id: string | null
  resolved_carrier_app_id: string | null
  resolve_source: string
  outcome: string
  space_id: string
  user_id: string
  organization_id: string
  agent_run_id: string | null
  message_id: string | null
  tool_call_id: string | null
  duration_ms: number
  ts: number
  error_message?: string
  client: string
  client_version: string
}

// 实现对象用 `satisfies TabTinAPIShape` 约束，public 类型由 `typeof api` 推导。
// 新增 API 只需修改实现，无需同步维护类型声明。
interface TabTinAPIShape {
  // 基础通信
  ping: () => Promise<string>
  getHostname: () => Promise<string>
  getPlatform: () => string
  getArch: () => string
  getLocalNetworkAddresses: () => Promise<LocalNetworkAddress[]>

  // 自绘窗口控件（Windows/Linux frameless 标题栏的最小化/最大化/关闭）。
  // macOS 用系统红绿灯，renderer 侧不渲染这组按钮，但 API 仍可调用。
  windowControls: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    /** 订阅 maximize/unmaximize（双击拖拽区、系统快捷键等也会触发），返回取消订阅函数 */
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
    isFullScreen: () => Promise<boolean>
    /** 订阅 enter/leave-full-screen（macOS 绿灯、系统快捷键等触发），返回取消订阅函数 */
    onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void
  }

  // API代理
  apiRequest: (options: ApiProxyRequest) => Promise<ApiProxyResponse>

  // 认证管理
  auth: {
    save: (accessToken: string | null, refreshToken: string | null, userInfo: any, expiresAt?: number | null) => Promise<{ success: boolean; error?: string }>
    get: () => Promise<AuthStorageData | null>
    load: () => Promise<AuthLoadResult | null>
    clear: () => Promise<{ success: boolean; error?: string }>
    clearTokens: () => Promise<{ success: boolean; error?: string }>
    clearUserInfo: () => Promise<{ success: boolean; error?: string }>
    check: () => Promise<{ success: boolean; isValid?: boolean; error?: string }>
    saveAccessToken: (token: string) => Promise<{ success: boolean; error?: string }>
    getAccessToken: () => Promise<{ success: boolean; token?: string | null; error?: string }>
    saveRefreshToken: (token: string) => Promise<{ success: boolean; error?: string }>
    refreshAccessToken: () => Promise<AuthRefreshResult>
    saveUserInfo: (userInfo: any) => Promise<{ success: boolean; error?: string }>
    getUserInfo: () => Promise<{ success: boolean; userInfo?: any | null; error?: string }>
    isTokenExpiringSoon: (bufferMinutes?: number) => Promise<{ success: boolean; isExpiring?: boolean; error?: string }>
    onForceLogout: (callback: () => void) => () => void
    onTokenRefreshed: (callback: () => void) => () => void
  }

  openaiCodex: {
    getStatus: () => Promise<{
      connected: boolean
      expiresAt?: number
      models: Array<{ id: string; displayName: string }>
    }>
    loginBrowser: () => Promise<{ started: true }>
    loginDeviceCode: () => Promise<{ userCode: string; verificationUri: string }>
    logout: () => Promise<{ loggedOut: true }>
    cancelLogin: () => Promise<{ cancelled: true }>
    onStatusChanged: (
      callback: (payload: { status: 'connected' | 'disconnected' }) => void,
    ) => () => void
  }

  oss: {
    getPresignedObject: (payload: OssGetPresignedObjectPayload) => Promise<OssGetPresignedObjectResult>
    cancelPresignedDownload: (requestId: string) => Promise<{ cancelled: boolean }>
    putPresignedObject: (
      payload: OssPutPresignedObjectPayload,
      onProgress?: (progress: OssPutPresignedObjectProgress) => void,
    ) => Promise<OssPutPresignedObjectResult>
    cancelPresignedObject: (uploadId: string) => Promise<{ cancelled: boolean }>
  }

  // 组织管理
  organization: {
    getLocalConfig: (organizationId: string) => Promise<{ success: boolean; config?: any; error?: string }>
    saveLocalConfig: (organizationId: string, config: any) => Promise<{ success: boolean; error?: string }>
    clearLocalCache: (organizationId?: string) => Promise<{ success: boolean; error?: string }>
  }

  // 文件系统
  showSaveDialog: (options: { defaultPath?: string; defaultDirectory?: 'downloads'; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | undefined>
  showOpenDialog: (options: {
    filters?: Array<{ name: string; extensions: string[] }>
    properties?: string[]
    /** 选目录/文件对话框初始定位路径（失效重选时带到旧绑定目录）。 */
    defaultPath?: string
  }) => Promise<string[] | undefined>
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
  openPath: (targetPath: string) => Promise<{ success: boolean; error?: string }>
  showItemInFolder: (targetPath: string) => Promise<{ success: boolean; error?: string }>
  clipboard: {
    writeImage: (bytes: ArrayBuffer | Uint8Array) => Promise<{ success: boolean; error?: string }>
    writeFile: (targetPath: string) => Promise<{ success: boolean; error?: string }>
  }
  fileSystem: {
    pathExists: (targetPath: string) => Promise<{
      success: boolean
      exists: boolean
      isDirectory?: boolean
      isFile?: boolean
      error?: string
    }>
    realpath: (targetPath: string) => Promise<{
      success: boolean
      path?: string
      error?: string
    }>
    readDir: (path: string) => Promise<{
      success: boolean
      entries?: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: number | null
      }>
      error?: string
    }>
    readFilePreview: (path: string, options?: { maxBytes?: number }) => Promise<{
      success: boolean
      data?: {
        kind: 'text' | 'image' | 'pdf' | 'doc' | 'docx' | 'xlsx' | 'pptx' | 'binary'
        content?: string
        path?: string
        size?: number
        truncated?: boolean
        mime?: string
      }
      error?: string
    }>
    renderOfficePreview: (path: string) => Promise<{
      success: boolean
      data?: {
        kind: 'rendered-office'
        source: 'libreoffice' | 'powerpoint'
        pdfPath?: string
        pages: Array<{
          index: number
          path: string
          mime: 'image/png'
        }>
        pageCount: number
        cached: boolean
      }
      code?: string
      error?: string
    }>
    renderOfficePreviewData: (input: {
      fileName: string
      data: ArrayBuffer | Uint8Array
    }) => Promise<{
      success: boolean
      data?: {
        kind: 'rendered-office'
        source: 'libreoffice' | 'powerpoint'
        pdfPath?: string
        pages: Array<{
          index: number
          path: string
          mime: 'image/png'
        }>
        pageCount: number
        cached: boolean
      }
      code?: string
      error?: string
    }>
    readBinaryFile: (path: string) => Promise<{
      success: boolean
      data?: ArrayBuffer
      error?: string
    }>
    writeFile: (path: string, content: string) => Promise<{
      success: boolean
      error?: string
    }>
    writeBinaryFile: (path: string, base64Data: string) => Promise<{
      success: boolean
      error?: string
    }>
    createDir: (path: string) => Promise<{ success: boolean; error?: string }>
    rename: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
    deleteFile: (path: string) => Promise<{ success: boolean; error?: string }>
    deleteDir: (path: string) => Promise<{ success: boolean; error?: string }>
    ensureSpaceSandbox: (spaceId: string, organizationId?: string) => Promise<{ success: boolean; path?: string; skillsPath?: string; dataRoot?: string; userId?: string; error?: string }>
    ensureDefaultAgentDir: (input: string | { agentName?: string | null; spaceName?: string | null; organizationName?: string | null }) => Promise<{ success: boolean; path?: string; error?: string }>
    lookupSpaceSandbox: (spaceId: string, organizationId?: string) => Promise<{ success: boolean; path?: string; exists?: boolean; hasContent?: boolean; error?: string }>
    watch: (path: string, options?: { recursive?: boolean }) => Promise<{ success: boolean; watchId?: string; error?: string }>
    unwatch: (watchId: string) => Promise<{ success: boolean }>
    computeSkillContentHash: (skillDir: string) => Promise<{ success: boolean; hash?: string; error?: string }>
    ripgrepSearch: (options: RipgrepSearchOptions) => Promise<RipgrepSearchResponse>
    ripgrepSearchCancel: (requestId: string) => Promise<{
      success: boolean
      canceled?: boolean
      error?: string
    }>
    replaceInFiles: (input: ReplaceInFilesRequest) => Promise<ReplaceInFilesResponse>
    /** payload 类型见 `@shared/fs-watch-types.ts` 的 `FsWatchEvent`——单源管理 */
    onWatchEvent: (callback: (payload: import('@shared/fs-watch-types').FsWatchEvent) => void) => () => void
  }

  // 💻 Git 操作（TabCode 用）
  git: {
    isGitRepo: (cwd: string) => Promise<{ success: boolean; isRepo: boolean }>
    getBranch: (cwd: string) => Promise<{ success: boolean; branch: string }>
    getBranchMeta: (cwd: string) => Promise<{ success: boolean; meta: GitBranchMeta; error?: string }>
    listBranches: (cwd: string) => Promise<{
      success: boolean
      localBranches: GitBranchItem[]
      remoteBranches: string[]
      error?: string
    }>
    checkoutBranch: (
      cwd: string,
      options: { branch: string; create?: boolean; startPoint?: string; allowDirty?: boolean }
    ) => Promise<{ success: boolean; error?: string }>
    getStatus: (cwd: string) => Promise<{
      success: boolean
      files: Record<string, string>
      entries?: Record<string, GitStatusEntry>
    }>
    getDiffStat: (cwd: string) => Promise<{ success: boolean; stat: GitDiffStatResult }>
    getFileAtHead: (cwd: string, filePath: string) => Promise<{ success: boolean; content: string }>
    getFileAtStaged: (cwd: string, filePath: string) => Promise<{ success: boolean; content: string }>
    getFileAtCommit: (
      cwd: string,
      options: { filePath: string; commitHash: string; parent?: boolean },
    ) => Promise<{ success: boolean; content: string }>
    rawDiff: (cwd: string, extraArgs?: string[]) => Promise<{ success: boolean; diff?: string; error?: string }>
    stageFiles: (cwd: string, paths?: string[]) => Promise<{
      success: boolean
      error?: string
      skippedPaths?: string[]
      skippedCount?: number
    }>
    unstageFiles: (cwd: string, paths?: string[]) => Promise<{
      success: boolean
      error?: string
      skippedPaths?: string[]
      skippedCount?: number
    }>
    commit: (cwd: string, message: string) => Promise<{ success: boolean; commitHash?: string; error?: string }>
    push: (cwd: string, options?: {
      remote?: string
      branch?: string
      setUpstream?: boolean
      allowDirty?: boolean
      allowBehind?: boolean
      allowNoAhead?: boolean
    }) => Promise<{ success: boolean; error?: string }>
    pull: (cwd: string, options?: {
      remote?: string
      branch?: string
      rebase?: boolean
    }) => Promise<{ success: boolean; behind?: number; error?: string }>
    fetch: (cwd: string, options?: {
      remote?: string
      prune?: boolean
    }) => Promise<{ success: boolean; error?: string }>
    stash: (cwd: string, action: 'save' | 'pop' | 'list' | 'drop', options?: {
      message?: string
      includeUntracked?: boolean
      index?: number
    }) => Promise<{ success: boolean; entries?: GitStashEntry[]; error?: string }>
    discardFiles: (cwd: string, paths: string[]) => Promise<{ success: boolean; discardedCount?: number; error?: string }>
    listRemotes: (cwd: string) => Promise<{ success: boolean; remotes: GitRemoteItem[]; error?: string }>
    getPullRequestUrl: (cwd: string, options?: { remote?: string; baseBranch?: string; headBranch?: string }) => Promise<{
      success: boolean
      provider?: 'github' | 'gitlab'
      remote?: string
      baseBranch?: string
      headBranch?: string
      url?: string
      error?: string
    }>
    createPullRequest: (cwd: string, options?: {
      remote?: string
      baseBranch?: string
      headBranch?: string
      title?: string
      body?: string
      draft?: boolean
    }) => Promise<{
      success: boolean
      provider?: 'github' | 'gitlab'
      remote?: string
      baseBranch?: string
      headBranch?: string
      url?: string
      diffSummary?: GitDiffSummary | null
      error?: string
    }>
    listWorktrees: (cwd: string) => Promise<{ success: boolean; worktrees: GitWorktreeItem[]; error?: string }>
    createWorktree: (cwd: string, options: { path: string; branch?: string; createBranch?: boolean; baseBranch?: string }) => Promise<{ success: boolean; error?: string }>
    preflightRemoveWorktree: (cwd: string, options: { path: string }) => Promise<WorktreeRemovePreflightResult>
    removeWorktree: (cwd: string, options: { path: string; force?: boolean; assessmentToken?: string }) => Promise<WorktreeRemoveResult>
    mergeWorktree: (cwd: string, options: {
      sourceWorktreePath: string
      targetBranch: string
      deleteAfterMerge?: boolean
      deleteSourceBranch?: boolean
    }) => Promise<GitWorktreeMergeResult>
    fullStatus: (cwd: string) => Promise<GitFullStatusResult>
    listCommits: (cwd: string, options?: { limit?: number; graph?: boolean }) => Promise<{
      success: boolean
      commits: GitCommitListItem[]
      error?: string
      reason?: 'invalid_cwd' | 'path_not_found' | 'permission_denied' | 'git_error'
      headHash?: string
    }>
    getCommitDetail: (cwd: string, options: { commitHash: string }) => Promise<GitCommitDetailResult>
  }

  // Checkpoint 检查点系统（TabCode 用）
  checkpoint: CheckpointApi

  // Per-file 回退（替代 shadow git checkpoint；前端回退编排后续接入）
  fileHistory: FileHistoryApi
  /** 本机编辑工具补丁账本（Agent Turn 行级 Diff；不上传） */
  fileEditPatches: FileEditPatchesApi

  // 🆕 Chat 相关
  chat: {
    /** PlatformSurface: 导出对话为 Markdown（Wave 3 PoC） */
    exportMd: (params: { sessionId: string }) => Promise<{ markdown: string; messageCount: number }>
  }

  im: {
    openDetached: () => Promise<{ opened: true }>
    /** 把本窗口切换到的团队广播给其它窗口（主窗 ↔ 私信窗双向同步） */
    syncOrganization: (payload: { organizationId: string }) => void
    /** 监听其它窗口的团队切换，回调里把本窗口同步到目标团队 */
    onOrganizationSynced: (callback: (payload: { organizationId: string }) => void) => () => void
  }

  // 设备标识（Main 进程持久化，Renderer 共享）
  getDeviceFingerprint: () => Promise<string>
  /** 安装身份 + 同机恢复凭据。 */
  getDeviceIdentity: () => Promise<{
    fingerprint: string
    machineKey: string | null
    previousFingerprint: string | null
    recoveryFingerprints: string[]
  }>
  ensureDeviceRegistered: (organizationId: string) => Promise<Device>

  // Space 上下文
  space: {
    setActive: (
      spaceId: string | null,
      crawlspaceId?: string | null,
      organizationId?: string | null,
      organizationRoot?: string | null
    ) => Promise<{ success: boolean }>
  }

  // TabDesktop 授权管理
  // PD-11（W6 M3）：原 CLI auth preset 推送 IPC 已删除 —— CLI client 不再压低
  // Space 的 yolo 预设。`setDevicePermissions` 保留（与 yolo 正交，规范 § 6.5 仍由这条同步）。
  desktop: {
    getApprovalStatus: () => Promise<unknown>
    revokeApproval: () => Promise<unknown>
    setDevicePermissions: (perms: Record<string, string> | null) => Promise<unknown>
  }

  // OS 系统权限（macOS TCC / Windows 应用权限）
  osPermissions: {
    list: () => Promise<unknown>
    check: (kind: string) => Promise<unknown>
    request: (kind: string) => Promise<unknown>
    openSettings: (kind: string) => Promise<unknown>
  }

  // 窗口外观（跟随系统时以主进程 shouldUseDarkColors 为准，见 ）
  setAppearance: (appearance: 'light' | 'dark' | 'system') => Promise<{
    success: boolean
    appearance?: 'light' | 'dark' | 'system'
    themeSource?: 'system' | 'light' | 'dark'
    shouldUseDarkColors?: boolean
    shouldUseDarkColorsForSystemIntegratedUI?: boolean | null
    error?: string
  }>
  getAppearance: () => Promise<{
    success: boolean
    appearance?: 'light' | 'dark' | 'system'
    themeSource?: 'system' | 'light' | 'dark'
    shouldUseDarkColors?: boolean
    shouldUseDarkColorsForSystemIntegratedUI?: boolean | null
    error?: string
  }>
  onNativeThemeUpdated: (
    callback: (payload: {
      appearance: 'light' | 'dark' | 'system'
      themeSource: 'system' | 'light' | 'dark'
      shouldUseDarkColors: boolean
      shouldUseDarkColorsForSystemIntegratedUI: boolean | null
    }) => void,
  ) => () => void

  // 放映全屏控制
  slideshow: {
    enterFullscreen: () => Promise<{ success: boolean; error?: string }>
    exitFullscreen: () => Promise<{ success: boolean; error?: string }>
  }

  // TabSlide 自动保存 — 关闭保护
  slide: {
    onFlushBeforeClose: (callback: () => void) => () => void
    flushComplete: () => void
  }

  // ⌘Q / 关窗口 dirty 合并对话框（W2.5 T9）
  // main 进程在 before-quit / window close 时主动询问 renderer 当前是否有 dirty 资源；
  // renderer 弹合并对话框让用户三选（save-all / discard / cancel），结果回传 main 决定是否继续退出。
  exitGuard: {
    /** main → renderer：触发合并对话框；payload 含 reason（区分 ⌘Q vs 关窗口）+ requestId */
    onRequest: (
      callback: (payload: { reason: 'app-quit' | 'window-close'; requestId: string }) => void,
    ) => () => void
    /** renderer → main：用户做出选择，'continue' = 继续退出/关闭，'cancel' = 用户取消 */
    sendResponse: (payload: { requestId: string; choice: 'continue' | 'cancel' }) => void
  }

  // Run / Session 管理
  runSession: {
    create: (runId?: string, sessionId?: string) => Promise<any>
    get: (runId: string) => Promise<any>
    hasActiveRunForView: (viewId: string) => Promise<{ active: boolean; runId?: string }>
    registerView: (runId: string, viewInfo: { viewId: string; profile?: string; partition?: string; userAgent?: string; proxy?: any; metadata?: Record<string, any> }) => Promise<any>
    setActiveView: (runId: string, viewId?: string | null) => Promise<any>
    addEvent: (payload: { runId?: string; viewId?: string; type: string; data?: any; timestamp?: number }) => Promise<any>
    openTab: (payload: { runId?: string; id?: string; url?: string; profile?: string; partition?: string; userAgent?: string; proxy?: any; metadata?: Record<string, any> }) => Promise<any>
    switchTab: (payload: { runId?: string; viewId: string; bounds?: any }) => Promise<any>
    closeTab: (payload: { runId?: string; viewId: string; force?: boolean }) => Promise<any>
    endRun: (runId: string, options?: { destroyViews?: boolean; reason?: string }) => Promise<any>
  }

  // ========== 🆕 爬虫模块 API ==========

  // 🆕 嵌入式爬虫视图
  crawlView: {
    show: (
      urlOrTabId: string,
      boundsOrUrl: { x: number; y: number; width: number; height: number } | string,
      maybeBounds?: { x: number; y: number; width: number; height: number },
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<{ success: boolean; error?: string }>
    // 🆕 支持 runId 参数（第四位），便于主进程绑定 run/session
    hide: (tabId?: string) => Promise<{ success: boolean; error?: string }>
    setViewBounds: (tabId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean; error?: string }>
    setIgnoreMouseEventsForAttached: (ignore: boolean) => Promise<{ success: boolean; error?: string }>
    destroyTabView: (tabId: string) => Promise<{ success: boolean; error?: string }>
    hasView: (tabId: string) => Promise<{ success: boolean; exists?: boolean; error?: string }>
    touch: (tabId: string, reason?: string) => Promise<{ success: boolean; error?: string }>
    reconcileOrphans: (payload: { knownTabIds?: string[]; knownViewIds?: string[]; knownWorkspaceIds?: string[]; reason?: string }) => Promise<{ success: boolean; summary?: any; error?: string }>
    getCacheStats: () => Promise<{ success: boolean; stats?: any; error?: string }>
    cleanupCache: () => Promise<{ success: boolean; stats?: any; error?: string }>

    // 🆕 导航控制
    goBack: (tabId?: string) => Promise<{ success: boolean; canGoBack?: boolean; error?: string }>
    goForward: (tabId?: string) => Promise<{ success: boolean; canGoForward?: boolean; error?: string }>
    reload: (ignoreCache?: boolean, tabId?: string) => Promise<{ success: boolean; error?: string }>
    stop: (tabId?: string) => Promise<{ success: boolean; error?: string }>
    getNavigationState: (tabId?: string) => Promise<{
      success: boolean
      state?: {
        canGoBack: boolean
        canGoForward: boolean
        isLoading: boolean
        url: string
        title: string
      }
      error?: string
    }>
    loadUrl: (
      tabId: string,
      url: string,
      options?: {
        waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'
        timeout?: number
        waitForSelector?: string
        waitForTimeout?: number
        waitForState?: 'attached' | 'visible' | 'hidden'
      }
    ) => Promise<{
      success: boolean
      status?: 'loaded' | 'timeout' | 'error'
      finalUrl?: string
      timing?: { start: number; end: number; duration: number }
      error?: string
    }>
    waitForSelector: (
      tabId: string,
      options: {
        selector?: string
        state?: 'attached' | 'visible' | 'hidden'
        timeout?: number
        delay?: number
        pollInterval?: number
      }
    ) => Promise<{ success: boolean; elapsedMs?: number; error?: string }>

    // 🆕 页面读取（Phase 3）
    getHTML: (
      tabId?: string,
      url?: string,
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<{ success: boolean; html?: string; error?: string }>
    getPageInfo: (
      tabId?: string,
      url?: string,
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<{ success: boolean; pageInfo?: { html: string; url: string; title: string }; error?: string }>

    // 🆕 事件监听（Phase 2）
    onEvent: (callback: (event: any) => void) => () => void  // 返回取消订阅函数

    // 🆕 内容操作（Phase 2）
    executeScript: (
      script: string,
      tabId?: string,
      url?: string,
      options?: CrawlViewOptions
    ) => Promise<{ success: boolean; result?: any; error?: string }>
    cancelAnnotation: (tabId: string) => Promise<{ success: boolean; result?: any; error?: string }>
    getProcessedContent: (
      tabId?: string,
      url?: string,
      runId?: string,
      options?: CrawlViewOptions
    ) => Promise<{
      success: boolean
      cleanHtml?: string
      skeletonHtml?: string
      title?: string
      url?: string
      stats?: any
      error?: string
    }>
    screenshot: (
      options?: ScreenshotCaptureOptions,
      tabId?: string,
      url?: string,
      runId?: string,
      viewOptions?: CrawlViewOptions
    ) => Promise<{ success: boolean; data?: string; format?: string; error?: string }>

    // 🆕 CDP 集成（Phase 3）
    getCDPEndpoint: () => Promise<{ success: boolean; endpoint?: string; error?: string }>
    getWebContentsId: () => Promise<{ success: boolean; id?: number; error?: string }>

    // 🆕 Find-in-Page & Zoom
    findInPage: (tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => Promise<{ success: boolean; requestId?: number; error?: string }>
    stopFindInPage: (tabId: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => Promise<{ success: boolean; error?: string }>
    onFoundInPage: (callback: (event: any, data: { viewId: string; activeMatchOrdinal: number; matches: number; finalUpdate?: boolean }) => void) => () => void
    onCrashRecovered: (callback: (payload: { viewId: string; reason: string; url: string }) => void) => () => void
    /**
     * 监听"env 绑定变更触发的 workspace view 重建"事件。
     * 主进程销毁旧 partition 的 view 并用新 partition 重建后广播。
     */
    onPartitionRebuilt: (callback: (payload: { tabId: string; oldPartition: string; newPartition: string; reason: string }) => void) => () => void
    /**
     * 监听"partition 重建锁释放"事件（Wave 3 B2 收敛）。
     *
     * 用户连续切 env (A→B→C) 时主进程只串行处理一次 (A→B)，第二次 show 会
     * 撞 `_partitionRebuildInFlight` 锁返回 skipped。锁释放时主进程广播此事件，
     * EmbeddedCrawlView 收到后比对 `tab.metadata.partition` 与 `actualPartition`，
     * 不一致则自动再发一次 `crawl-view:show` 触发新一轮重建，确保最终收敛。
     */
    onPartitionRebuildReleased: (callback: (payload: { tabId: string; actualPartition: string }) => void) => () => void
    setZoomLevel: (tabId: string, level: number) => Promise<{ success: boolean; error?: string }>
    getZoomLevel: (tabId: string) => Promise<{ success: boolean; level?: number; error?: string }>
    onZoomLevelChanged: (callback: (payload: BrowserZoomLevelChangedPayload) => void) => () => void
    takeOverBrowser: (viewId: string) => Promise<{ success: boolean; sessionIds: string[] }>
    handBackBrowser: (viewId: string) => Promise<{
      success: boolean
      sessionIds: string[]
      releasedSessionIds?: string[]
    }>
    onAgentTabLockChanged: (callback: (snapshot: BrowserTabControlSnapshot) => void) => () => void
  }

  // ========== 🆕 webview 容器（ webview 迁移 Phase 2） ==========

  /**
   * 浏览器容器 feature flag 只读值。
   * 主进程读 `TABTIN_BROWSER_CONTAINER` env → additionalArguments 注入 →
   * preload 解析 process.argv。renderer 侧统一经
   * `@/utils/browserContainerMode` 读取，不要散落判断。
   */
  browserContainer: {
    readonly mode: 'wcv' | 'webview'
  }

  /** <webview> tag 容器的主进程协调 API（仅 flag=webview 时由 WebviewManager 使用） */
  webviewHost: {
    /** 创建 <webview> 元素前声明配置；返回元素应使用的完整 partition 字符串 */
    announce: (tabId: string, options: {
      url: string
      profile?: string
      partition?: string
      crawlspaceId?: string
      kind?: string
      isPreview?: boolean
      runId?: string
    }) => Promise<{ success: boolean; effectivePartition?: string; error?: string }>
    /** dom-ready 后上报 webContentsId 完成 tabId↔guest 权威绑定 */
    bind: (tabId: string, webContentsId: number) => Promise<{ success: boolean; already?: boolean; error?: string }>
    /**
     * 已有 guest 的地址栏导航（主进程按当前 URL 去重 + 安全校验 + 任务锁）。
     * expectedPartition：调用方 store 中的最新 partition，主进程比对权威条目，
     * 不一致返回 code='partition-mismatch' 要求销毁元素重建（env 绑定切换）。
     */
    navigate: (tabId: string, url: string, options?: { expectedPartition?: string }) => Promise<{ success: boolean; skipped?: string; code?: string; error?: string }>
    /** 元素未 attach 就被销毁时清理主进程 pending 登记 */
    discardAnnounce: (tabId: string) => Promise<{ success: boolean; error?: string }>
    /** guest 渲染进程崩溃 → renderer 应执行 webview.reload() 恢复 */
    onGuestCrashed: (callback: (payload: { tabId: string; reason: string; url: string }) => void) => () => void
    /** 主进程主动销毁 view → renderer 应移除对应 <webview> 元素 */
    onDestroyRequest: (callback: (payload: { tabId: string }) => void) => () => void
  }

  // WebContentsView 管理（create/destroy 为内部接口，不对渲染层开放）
  webcontentsview: {
    getCDPEndpoint: (viewId: string) => Promise<{
      success: boolean
      endpoint?: string
      error?: string
    }>
    getView: (viewId: string) => Promise<{
      success: boolean
      exists?: boolean
      error?: string
    }>
    getAllViews: () => Promise<{
      success: boolean
      viewIds?: string[]
      error?: string
    }>
    openDevTools: (viewId: string) => Promise<{
      success: boolean
      error?: string
    }>
    closeDevTools: (viewId: string) => Promise<{
      success: boolean
      error?: string
    }>
    // ✅ Phase 3: 已移除池化相关 API (acquire/release/getPoolStatus)
  }

  // 任务管理
  taskAPI: {
    create: (config: any) => Promise<{ success: boolean; task?: any; error?: string }>
    get: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    query: (options: any) => Promise<{ success: boolean; tasks?: any[]; total?: number; error?: string }>
    getAll: (filter?: any) => Promise<{ success: boolean; tasks?: any[]; error?: string }>
    update: (taskId: string, updates: any) => Promise<{ success: boolean; task?: any; error?: string }>
    updateMetadata: (taskId: string, metadata: Record<string, any>) => Promise<{ success: boolean; task?: any; error?: string }>
    delete: (taskId: string) => Promise<{ success: boolean; error?: string }>
    getStatistics: () => Promise<{ success: boolean; statistics?: any; error?: string }>
    cleanup: (olderThan?: number) => Promise<{ success: boolean; cleaned?: number; error?: string }>
    clear: () => Promise<{ success: boolean; error?: string }>
    getStoreInfo: () => Promise<{ success: boolean; info?: any; error?: string }>
    onStateChange: (callback: (event: any) => void) => () => void
    // 生命周期操作
    enqueue: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    start: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    pause: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    resume: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
    resumeWithPagination: (params: { taskId: string; pages: number; method: 'click' | 'scroll' | 'both' }) => Promise<{ success: boolean; task?: any; error?: string }>
    selectRecommendation: (params: {
      taskId: string
      recommendationId: string
      instruction: string
      selectionType?: 'history' | 'recommendation'
      selectionSource?: string
      schema?: any
      metadata?: Record<string, any>
      skeletonHtml?: string
    }) => Promise<{ success: boolean; task?: any; error?: string }>
    cancel: (taskId: string) => Promise<{ success: boolean; task?: any; error?: string }>
  }

  recommendationAPI: {
    getHistory: (params: { url: string; userId?: string; user_id?: string; limit?: number }) => Promise<{
      success: boolean
      data?: HistoryRecommendationResponse
      error?: string
    }>
    generate: (params: {
      cleanHtml: string
      url?: string
      skeletonHtml?: string
      maxRecommendations?: number
      pageMeta?: {
        title?: string
        httpStatus?: number
        language?: string
        isAuthenticated?: boolean
        hasCookies?: boolean
      }
    }) => Promise<{
      success: boolean
      data?: RecommendationGeneratorResult
      error?: string
    }>
    recordUsage: (params: { historyId: string; userId: string | number }) => Promise<{ success: boolean; error?: string }>
  }

  agent: {
    /**
     * 执行前端动作（由 Agent 后端通过 WS 推送）
     * @param action - 动作数据（task_id, type, params）
     * @returns Promise<ActionResult>
     */
    executeAction: (action: {
      task_id: string
      action: string
      params: Record<string, any>
      crawlTabId?: string
      sandbox_policy?: Record<string, any>
    }) => Promise<{
      success: boolean
      clean_html?: string
      skeleton_html?: string
      title?: string
      url?: string
      content_length?: number
      data?: any
      error?: string | null
    }>
    getRegisteredTools: () => Promise<string[]>
    hasToolForAction: (actionType: string) => Promise<boolean>
    /**
     * ：把当前 chat 会话绑定到一个具体的 Git worktree 目录
     * （TabCode worktree session root），取代 Space.working_dir 单根。
     * main 端校验路径存在 / 是 Git 工作树 / 会话未 busy；失败时返回
     * `{ success: false, reason }`，不抛异常。
     */
    bindSessionCodeRoot: (payload: {
      sessionId: string
      rootPath: string
      revision?: number
      tabKey?: string
      branch?: string
      title?: string
    }) => Promise<{
      success: boolean
      rootPath?: string
      revision?: number
      error?: string
      reason?: string
    }>
    getSessionCodeRoot: (payload: { sessionId: string }) => Promise<{
      success: boolean
      binding?: {
        rootPath: string
        revision: number
        tabKey?: string
        branch?: string
        title?: string
        boundAt: number
      } | null
      error?: string
    }>
    clearSessionCodeRoot: (payload: { sessionId: string }) => Promise<{
      success: boolean
      cleared?: boolean
      error?: string
    }>
    /** 批量拉取会话代码根（启动 hydration / 会话列表恢复）。 */
    listSessionCodeRoots: (payload: { sessionIds: string[] }) => Promise<{
      success: boolean
      bindings?: Record<string, {
        rootPath: string
        revision: number
        tabKey?: string
        branch?: string
        title?: string
        boundAt: number
      }>
      error?: string
    }>
    /** 草稿转正：把代码根绑定从临时 sessionId 原子迁到真 sessionId。 */
    rehomeSessionCodeRoot: (payload: {
      fromSessionId: string
      toSessionId: string
    }) => Promise<{
      success: boolean
      binding?: {
        rootPath: string
        revision: number
        tabKey?: string
        branch?: string
        title?: string
        boundAt: number
      } | null
      error?: string
    }>
  }

  agentEngine: {
    query: (request: AgentEngineQueryRequest) => Promise<{
      success: boolean
      error?: string
      aborted?: boolean
    }>
    compactSession: (request: AgentEngineCompactSessionRequest) => Promise<AgentEngineCompactSessionResponse>
    // ：IPC 实际返回 handleAbort 的 { success }——miss（session 不在本
    // host）时 success:false，renderer 据此留痕/自愈，类型别再声明成 void。
    abort: (input?: { sessionId?: string }) => Promise<{ success: boolean }>
    // ：busy 以 runtime ConversationRunQueue.isBusy 为准（running 或有排队；HITL
    // 挂起期天然 busy）——renderer 对账「会话还在不在跑」看 busy，别看 running。
    getState: (input?: { sessionId?: string }) => Promise<{
      sessionId: string | null
      busy: boolean
      running: boolean
      queuedRunIds: string[]
      activeSessions?: number
      busySessions?: Array<{
        sessionId: string
        organizationId?: string
        workspaceId?: string
        queuedRunIds: string[]
      }>
    }>
    rollbackTranscript: (payload: {
      sessionId: string
      targetMessageId?: string
      targetRole?: 'user' | 'assistant'
      targetContent?: string
      targetOccurrenceIndex?: number
      mode?: 'rollback' | 'editAndResend'
      keepMessageCount?: number
      spaceId?: string
      organizationId?: string
    }) => Promise<{ success: boolean; applied?: boolean; keepMessageCount?: number | null; error?: string }>
    rollbackSessionTimeline: (payload: {
      sessionId: string
      targetMessageId: string
      targetRole?: 'user' | 'assistant'
      targetContent?: string
      targetOccurrenceIndex?: number
      mode?: 'rollback' | 'editAndResend'
      keepMessageCount?: number
      rollbackReason?: string
      previewRevision?: string
      filePreviewRevision?: string
      fileRewindAnchorId?: string
      rollbackContractVersion?: number
      acknowledgedFilePreviewReason?: string
      safetySnapshotHash?: string
      spaceId?: string
      organizationId?: string
    }) => Promise<{ success: boolean; applied?: boolean; keepMessageCount?: number | null; backend?: unknown; error?: string }>
    unrevertTranscript: (payload: { sessionId: string; spaceId?: string; organizationId?: string }) => Promise<{ success: boolean; error?: string }>
    onStreamEvent: (callback: (data: { sessionId: string; event: { type: string; payload: Record<string, unknown> } }) => void) => () => void
    /** ：声明对某 session 的实时流观察意图（主进程据此订阅 WS 观察源）。 */
    watchSession: (
      sessionId: string,
      options?: { shareId?: string },
    ) => Promise<{ success: boolean }>
    /** ：撤销对某 session 的实时流观察意图。 */
    unwatchSession: (sessionId: string) => Promise<{ success: boolean }>
    registerProvisionalSession: (sessionId: string) => Promise<{ registered: boolean }>
    beginProvisionalSessionClaim: (sessionId: string) => Promise<{
      accepted: boolean
      tracked: boolean
      reason?: string
    }>
    completeProvisionalSessionClaim: (
      sessionId: string,
      accepted: boolean,
    ) => Promise<{ completed: boolean }>
    beginProvisionalSessionDiscard: (sessionId: string) => Promise<{
      accepted: boolean
      reason?: string
    }>
    completeProvisionalSessionDiscard: (
      sessionId: string,
      deleted: boolean,
    ) => Promise<{ completed: boolean }>
    /** ：出站遥控发送经主进程 WS 网关执行，回传 GatewayResponse（caller 自判 ok）。 */
    gatewaySend: (payload: { messageType: string; payload: Record<string, unknown>; requestOptions?: Record<string, unknown> }) => Promise<{
      ok: boolean
      type: string
      requestId?: string
      payload?: Record<string, unknown>
      error?: { code?: string; message?: string }
    }>
    /** ：出站 abort——本机 IPC 快路径 + 后端 chat.cancel 兜底，回传 AbortRunResult。 */
    abortRun: (sessionId: string) => Promise<{
      localHit: boolean
      remoteRequested: boolean
      remoteAccepted: boolean
      remotePublished: number | null
    }>
    /** Host 级插队：promote 排队 run + abort active（不清其它排队）。 */
    promoteRun: (payload: { sessionId: string; runId: string }) => Promise<{
      success: boolean
      promoted: boolean
      abortedActive: boolean
      /** ：被掐断的 active runId */
      abortedRunId: string | null
      queuedRunIds: string[]
      error?: string
    }>
    /** 取消单条 Host 排队（不 abort active）。 */
    cancelQueuedRun: (payload: { sessionId: string; runId: string }) => Promise<{
      success: boolean
      cancelled: boolean
      queuedRunIds: string[]
      error?: string
    }>
    /**
     * ：Composer Stop 撤回未答轮次（经 runtime：abort + rewind commit + 主进程投影）。
     * 渲染进程不得直打 Django。
     */
    withdrawUnansweredTurn: (payload: {
      sessionId: string
      clientMessageId: string
      localMessageId?: string
      targetContent?: string
      spaceId?: string
      organizationId?: string
    }) => Promise<{
      success: boolean
      aborted: {
        localHit: boolean
        remoteRequested: boolean
        remoteAccepted: boolean
        remotePublished: number | null
      }
      runtimeApplied: boolean
      keepMessageCount: number | null
      backendProjected: boolean
      /** ：空会话时后端已取消标题生成并复位默认标题 */
      titleReset?: boolean
      title?: string | null
      titleGenerationStatus?: string | null
      error?: string
    }>
    /**
     * 审批记忆（approval_memo）变更通知：本机 always commit 成功或收到远端
     * approval_memo_updated 时，主进程推送 { agentId }，renderer 据此刷新 store 里的
     * agent config，让「已记住的授权」实时更新（不依赖 WS topic 订阅回环）。
     */
    onApprovalMemoChanged: (callback: (data: { workspaceId: string }) => void) => () => void
    /** Agent CLI 在安全边界提交 worktree 切换后，驱动 TabCode/Changes 同步。 */
    onSessionCodeRootChanged: (
      callback: (data: SessionCodeRootChangedEvent) => void,
    ) => () => void
    /**
     * v0.4 W1.5（PRD §6.7 / §7.4）：批量审批提交通道。
     * - batchId：runtime 端 LocalPermissionHandler.requestPermissionsBatch 注册的 pending key。
     * - decisions[]：N 条独立决策，runtime 内部按 tool_call_id 分发回各工具。
     */
    submitHitlBatch: (
      batchId: string,
      decisions: Array<{
        request_id?: string
        tool_call_id: string
        outcome: 'allow' | 'deny' | 'cancelled' | 'expired'
        scope?: 'once' | 'thread' | 'always'
        rejection_message?: string
      }>,
      threadId?: string,
    ) => Promise<{ success: boolean; error?: string; code?: string }>
    /** ask_user 单 request 通道（开放式问答路径，独立保留）。 */
    submitAskUserResponse: (requestId: string, response: unknown, threadId?: string) => Promise<{ success: boolean; error?: string; code?: string }>
    /**
     * renderer 显式 dismiss HITL 面板 → main 把 pending 收敛为「用户取消」终态
     * （HitlInteractionEvent status='cancelled'）。区别于 skipped（LLM 换问再问）：
     * cancelled 让 LLM 知道用户不想再回答同一件事，不去 re-open。
     */
    cancelHitlInteraction: (payload: {
      kind: 'approval' | 'ask'
      requestKey: string
      reason?: string
    }) => Promise<{ success: boolean; error?: string; code?: string }>
    executeModeSwitch: (payload: {
      sessionId: string
      proposalId: string
      outcome: 'approved' | 'cancelled'
    }) => Promise<{
      success: boolean
      outcome?: 'approved' | 'cancelled'
      error?: string
    }>
    /**
     * Phase 3 F8+F9：UI 直接切 mode 时同步通知主进程，让主进程立即
     *   - cancel 该 session 的 pending HITL（F8）
     *   - 任意合法 mode 切换后记录一次 mode transition reminder（F9）
     */
    notifyModeSwitched: (payload: {
      sessionId: string
      fromMode?: string
      toMode: string
    }) => Promise<{
      success: boolean
      cancelledHitlBatchCount?: number
      modeTransitionReminderSet?: boolean
      error?: string
    }>
    /**
     * ：UI 切审批档（自动通过 / 全部允许 / 请求批准）时同步通知主进程，
     * live 更新运行中 session 的 `policyContext.requestedApprovalMode` + 重拉权威
     * grant，使同轮下一个工具即按新档判决（不必等下一条消息）。
     */
    notifyApprovalModeChanged: (payload: {
      sessionId: string
      approvalMode: string
    }) => Promise<{
      success: boolean
      applied?: boolean
      error?: string
    }>
    /** Settings / chat 授权写入成功后，主动失效 main 进程的权威 agent_config cache。 */
    invalidateAgentConfigCache: (payload?: {
      agentId?: string
      workspaceId?: string
    }) => Promise<{ success: true }>
    /**
     * 前端维护的 Agent / Workspace 变更推送到 Host turn 状态仓库。
     * 发送路径优先读此状态，避免每轮 DETAIL。
     */
    upsertHostTurnState: (payload: {
      agent?: {
        id: string
        detail?: Record<string, unknown>
        display_name?: string | null
        name?: string | null
        custom_rules?: string | null
        personal_rules?: string | null
        agent_config?: unknown
        organization_allow_member_yolo?: boolean | null
      }
      workspace?: {
        id: string
        custom_rules?: string | null
        execution_limits?: {
          max_iterations_per_run?: number | null
          max_credits_per_run?: number | string | null
          enabled?: boolean | null
        } | null
        approval_grant?: 'always_ask' | 'auto' | 'full_access' | null
      }
    }) => Promise<{ success: boolean; error?: string }>
    /**
     * 设置页撤销 approval_memo 后调用：让 main 进程重拉该 Agent 的 runtime memoStore，
     * 移除已删 entry，否则对话里 getAlways 仍命中、撤销不在对话中生效。
     */
    refreshApprovalMemo: (payload?: { workspaceId?: string }) => Promise<{ success: true }>
    cancelSubagent: (input: string | { childId: string; sessionId?: string }) => Promise<boolean>
    /**
     * 「异步任务感知」B：列出当前会话仍在跑的本地后台 shell 命令（turn 结束后 pull
     * 渲染 pending 预告条）。`sessionId` = renderer chat sessionId（host 内部 = record.threadId）；
     * `spaceId` 作回落归属（record 缺 threadId 的边角场景）。
     */
    listRunningBackgroundTasks: (input: { sessionId: string; spaceId?: string }) => Promise<Array<{ sessionId: string; command: string; startedAt: number }>>
    retryTool: (sessionId: string, toolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>
    updateContext: (sessionId: string, appContext: { appType?: string | null; appMeta?: Record<string, unknown> | null; openTabs?: Array<{ type: string; id?: string; title?: string; active?: boolean; group_id?: string; app_key?: string; display_name?: string; is_home?: boolean; app_home?: string; path?: string; kind?: string; url?: string; session_id?: string }> | null; spaceId?: string | null }) => Promise<{ success: boolean }>
    /**
     * LH2-D2：登出 / 切账号时调用，清主进程对应账号的 sync 目录与
     * 正在运行的 SyncQueue。**严格按 owner 匹配**——只动当前账号的桶，
     * 其他账号的目录原样保留。
     */
    resetAccountSync: (payload: { userId: string; organizationId: string }) => Promise<{ success: boolean; clearedFiles: boolean; error?: string }>
    /**
     * ：登录 / 登出 / 切组织时统一失效主进程常驻能力目录。
     * 渲染层本地缓存（ActiveRunBinding / superseded / HostTurnPush）由
     * `initCapabilityIdentity` 服务一并清；本 IPC 只打主进程。
     */
    initCapabilityIdentity: (payload?: {
      reason?: 'login' | 'logout' | 'auth-changed' | 'organization-switch' | 'manual'
      organizationId?: string | null
    }) => Promise<{ success: true; rewarmed: boolean }>
    checkPending: (threadId: string) => Promise<{ pending_count: number; thread_ids: string[] }>
    onProactiveReport: (callback: (data: { threadId: string; content: string; runIds: string[] }) => void) => () => void
    /**
     * Wave 5b S2 review#1：Skill 凭据缓存主动失效。
     *
     * 渲染层在保存 SkillConfig 成功 / 删除凭据后调用，主进程遍历所有 active
     * runtime 让共享 resolver 立刻丢弃匹配的 60s LRU 缓存条目，避免
     * "用户改了密钥 → 漂移期内 Agent 仍按旧密钥跑"的窗口（与 PD-4 自动允许叠加风险）。
     *
     * 不传 filter / filter 字段都为空 → 清空所有缓存（删凭据时用，影响面最广）。
     * 仅传 spaceId / 仅传 skillKey / 同时传 → 由 resolver 各自匹配清单条。
     */
    invalidateSkillCredentialCache: (
      filter?: { spaceId?: string; skillKey?: string },
    ) => Promise<{ success: boolean; sessions?: number; error?: string }>
    /**
     * ：失效主进程 Agent Skill 启用快照（SkillEnablementMapCache）。
     * 面板启用/停用/携带集变更后调用，避免斜杠直链读到旧 map。
     */
    invalidateSkillEnablementCache: (
      filter?: { agentId?: string },
    ) => Promise<{ success: boolean; error?: string }>
    /**
     * M1.4 / v0.2 per-Organization：手动失效主进程 USER 画像缓存。
     *
     * 前端在用户成功提交 hint / 主动触发 distill（且 distill_dispatched / accepted 为 true）
     * 后调用该方法，让对话里下一轮 runtime 立刻拉到新画像，
     * 避免最长 10 分钟的旧缓存窗口（M1.4 缓存策略：成功 10min / 负 1min）。
     *
     * @param organizationId 失效该 Organization 槽位；不传 / 空字符串清空全部
     * @param agentId 指定 Agent 时只失效该 (org, agent) 槽位；省略则失效该 org 下全部 Agent 画像缓存
     */
    invalidateUserPortraitCache: (organizationId?: string, agentId?: string) => Promise<{ success: true }>
    /**
     *  阶段 C：草稿 session 预 acquire Runtime（不跑对话）。
     * 失败不阻断发送；success:false 时首发仍走冷建。
     */
    prewarmRuntime: (input: {
      threadId: string
      workspaceId: string
      spaceId: string
      organizationId: string
      agentId: string
      modelId: string
      agentMode?: string
      approvalMode?: string
      workingDir?: string
      workingDirType?: 'code' | 'doc' | 'mixed'
      enabledApps?: ReadonlyArray<{
        key: string
        cliKey?: string
        displayName: string
        capability: string
        aliases?: readonly string[]
      }>
      operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>
      memoryCapability?: boolean
      modelContextWindow?: number
      modelMaxOutput?: number
      modelSupportsVision?: boolean
      modelSupportsFunctionCalling?: boolean
      modelCapabilitiesConfig?: Record<string, unknown>
      modelProvider?: string
      isByokMode?: boolean
      spaceName?: string
      organizationName?: string
      isGroupSpace?: boolean
    }) => Promise<{ success: boolean; error?: string }>
    getDeviceModelPreferences: (organizationId: string) => Promise<{
      preferences: OrganizationDeviceModelPreferences
    }>
    setDeviceModelPreferences: (
      organizationId: string,
      preferences: OrganizationDeviceModelPreferences,
    ) => Promise<{ preferences: OrganizationDeviceModelPreferences }>
    setSessionContextTier: (sessionId: string, tierId: string | null) => Promise<{ success: true }>
    setSessionModelParamOverrides: (sessionId: string, overrides: Record<string, unknown> | null) => Promise<{ success: true }>
    readSnapshots: (sessionId: string, ctx?: { spaceId?: string; organizationId?: string }) => Promise<{ success: boolean; snapshots?: unknown[]; error?: string }>
    /**
     * ：判据探盘——该会话盘上是否有非空 messages.jsonl。冷启动区分本机会话
     * （runtime 正文权威）与观察端（回落 DB 只读）；热路径按内容态保留未落库。
     */
    hasLocalTranscript: (sessionId: string, ctx?: { spaceId?: string; organizationId?: string }) => Promise<{ success: boolean; hasLocal?: boolean; error?: string }>
    /**
     * ：云端 fork 后复制本机 SessionStorage 归档到新 session，并 remap
     * tool_use id。源无本机正文时 skipped（success 仍为 true）。
     */
    forkLocalSession: (input: {
      sourceSessionId: string
      newSessionId: string
      spaceId?: string
      organizationId?: string
      forkAnchorMessageId?: string
      toolIdRemap?: Record<string, string>
    }) => Promise<{
      success: boolean
      copied?: boolean
      skipped?: boolean
      reason?: string
      remappedToolIds?: number
      truncatedAtForkPoint?: boolean
      error?: string
    }>
    /**
     * ：读本机 transcript（messages.jsonl 重建成结构化消息）。本机会话正文
     * 唯一权威，返回 ReconstructedTranscriptMessage[]（跨 IPC 结构化克隆）。
     */
    readSessionTranscript: (sessionId: string, ctx?: { spaceId?: string; organizationId?: string }) => Promise<{ success: boolean; messages?: unknown[]; error?: string }>
    /**
     * W2（2026-05-26）：读子 Agent 三件套（messages / snapshots / events）。
     * D8 决策：合并成单 IPC，按 `kind` 区分。
     *
     * 路径解析由主进程读 `subagents.jsonl` 索引解析（不需要 renderer 知道落盘
     * 布局）。失败返回 `{ ok: false, error }`，error 是固定枚举值
     * （`subagent_not_found` / `invalid_subagent_run_id` / `file_missing` 等），
     * renderer 按需要走 i18n。
     */
    readSubagentSession: (input: {
      parentSessionId: string
      subagentRunId: string
      kind: 'messages' | 'snapshots' | 'events'
      /**
       * W2 三视角 review P0-D（2026-05-27）：renderer 传 organizationId / spaceId
       * 时主进程走归档读盘，不再要求 parent session 仍在内存 alive——避免历史
       * 会话（重启 Electron 后 sessions Map 没有该 sessionId）抽屉打不开。
       * 不传则回退看 live session（向后兼容）。
       */
      organizationId?: string
      spaceId?: string
    }) => Promise<
      | {
          ok: true
          lines: unknown[]
          truncated?: boolean
          format?: 'transcript' | 'envelopes'
        }
      // v3.2 envelope-error 修复后：main 端失败统一返回 `{ok:false, error:{code,message}}`，
      // 然后 ipc-shim 会把 envelope ok:false 直接 throw 成 PlatformIpcError，
      // **caller 实际拿不到这个分支**——保留 union 仅供 TS 类型完整性 & 测试 stub
      // 直接返回该形态时的兜底兼容。caller 失败路径必须靠 catch (err) 拿 err.code。
      | { ok: false; error: { code: string; message: string } | string }
    >
    /**
     * 列出父 session 派出过的所有子 Agent run（用 `subagents.jsonl` 索引重建）。
     *
     * **解决的问题**：SUBAGENT_* 事件不进父 events.jsonl / messages.jsonl，
     * 用户刷新页面 / 切走再回 / 重启 Electron 后，`subagentRunsBySessionId`
     * 没数据 → SubagentProgressCard 反查 store miss → 显示"状态同步中"。
     * renderer 加载历史消息后调本 IPC 把 status / task / parentToolCallId /
     * startedAt / endedAt / durationMs reconcile 回 store。
     *
     * 不恢复实时态字段（toolHistory / stepCount / latestTool）——这些只在
     * SUBAGENT_PROGRESS 事件流里有，索引文件不持久化。展开历史卡片看不到
     * "每一步工具调用"是当前架构的妥协，待后续从子 events.jsonl 扫描补全。
     */
    listSubagentRuns: (input: {
      parentSessionId: string
      organizationId?: string
      spaceId?: string
    }) => Promise<
      | {
          ok: true
          runs: Array<{
            subagentRunId: string
            parentToolCallId?: string
            task?: string
            label?: string
            role?: string
            model?: string
            childThreadId?: string
            status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
            startedAt?: number
            endedAt?: number
            error?: string
            stats?: { duration_ms?: number }
          }>
        }
      // 同 readSubagentSession：失败路径实际走 PlatformIpcError throw，caller 拿不到
      | { ok: false; error: { code: string; message: string } | string }
    >
  }

  telemetry: {
    /**
     * 标记 MTTR 开始。返回分配的 incident_id（未传则自动生成）。
     * 被 120/60s 共享限流桶保护，超限返回 `{ success: false, reason: 'rate_limited' }`（不带 incident_id）。
     */
    mttrStart: (req?: { incident_id?: string; description?: string; reporter?: string; session_id?: string; severity?: string }) => Promise<{ success: boolean; incident_id?: string; reason?: string }>
    /** 标记 MTTR 根因定位完成。duration_ms 由调用方计算（结束时间 - 开始时间）。同样受 120/60s 限流保护。 */
    mttrResolved: (req: { incident_id: string; resolution?: string; duration_ms?: number; resolver?: string; session_id?: string; error_class?: string }) => Promise<{ success: boolean; reason?: string }>
    /** 通用出口：DevTools 里 window.api.telemetry.emit 发送任意事件（不接明文敏感字段）。 */
    emit: (req: { event_name: string; payload?: Record<string, unknown>; session_id?: string; agent_id?: string; trace_id?: string }) => Promise<{ success: boolean; reason?: string }>
  }

  cli: {
    getCoreCommandCatalog: () => Promise<Array<{
      name: string
      description: string
      examples: string[]
    }>>
  }

  capabilityDiscovery: {
    getSummary: (spaceId: string) => Promise<Record<string, any>>
    refreshExecution: (spaceId: string) => Promise<Record<string, any>>
  }

  resourceMonitor: {
    getSnapshot: (options?: {
      mode?: ResourceMonitorSnapshotMode
      force?: boolean
    }) => Promise<ResourceMonitorSnapshot>
  }

  localMcp: {
    discover: () => Promise<LocalMcpDiscoveryResult>
    listConnections: () => Promise<LocalMcpConnectionSummary[]>
    getConnectionDetail: (
      connectionId: string,
      options?: { includeSecrets?: boolean },
    ) => Promise<LocalMcpConnectionDetail>
    shareConnectionToOrganization: (
      connectionId: string,
      organizationId: string,
    ) => Promise<{ id: string; name: string }>
    importCandidate: (
      candidateId: string,
      options?: { attachToAgentId?: string; name?: string }
    ) => Promise<LocalMcpConnectionSummary>
    saveManualConnection: (
      input: LocalMcpManualConnectionInput
    ) => Promise<LocalMcpConnectionSummary>
    upsertOrganizationMirror: (
      input: LocalMcpOrganizationMirrorInput
    ) => Promise<LocalMcpConnectionSummary>
    attachConnection: (
      connectionId: string,
      agentId: string,
      attached: boolean
    ) => Promise<LocalMcpConnectionSummary>
    setConnectionEnabled: (
      connectionId: string,
      enabled: boolean
    ) => Promise<LocalMcpConnectionSummary>
    deleteConnection: (connectionId: string) => Promise<{ ok: true }>
    probeConnection: (
      connectionId: string,
      options?: { timeoutMs?: number; openOAuthWindow?: boolean },
    ) => Promise<LocalMcpProbeSummary>
    cancelProbe: (connectionId: string) => Promise<{ cancelled: boolean }>
    waitForPlatformOAuthTicket: (input: {
      authorizeUrl: string
      donePathIncludes?: string
      timeoutMs?: number
    }) => Promise<{ ticket: string; login?: string }>
    closePlatformOAuthWindow: () => Promise<{ ok: true }>
  }

  resourceDetection: {
    getResources: (payload: {
      viewId: string
      category?: string
      captureStatus?: string
      capability?: string
      limit?: number
      probeMedia?: boolean
      hideSegments?: boolean
    }) => Promise<any>
    listResources: (payload: {
      viewId: string
      category?: string
      captureStatus?: string
      capability?: string
      limit?: number
      probeMedia?: boolean
      hideSegments?: boolean
    }) => Promise<any>
    inspectResource: (payload: { resourceId: string; viewId?: string }) => Promise<any>
    captureResource: (payload: { resourceId?: string; url?: string; viewId?: string; force?: boolean }) => Promise<any>
    downloadResource: (payload: { resourceId?: string; url?: string; viewId?: string; filename?: string; headers?: Record<string, string> }) => Promise<any>
    /**
     * 远程媒体拉进内存（不落盘）。第三方 CDN 不走 api-proxy 白名单。
     *  file-ref 拖回 Composer / 附件 blob 缓存。
     */
    fetchBuffer: (payload: {
      url: string
      headers?: Record<string, string>
      maxBytes?: number
    }) => Promise<{
      success: boolean
      data?: { buffer: ArrayBuffer; mimeType: string; size: number }
      error?: string
    }>
    downloadBatch: (payload: {
      resourceIds?: string[]
      urls?: string[]
      headers?: Record<string, string>
      concurrency?: number
      viewId?: string
    }) => Promise<any>
    parseM3U8: (payload: { resourceId?: string; url?: string; viewId?: string; headers?: Record<string, string> }) => Promise<any>
    parseStream: (payload: { resourceId?: string; url?: string; viewId?: string; headers?: Record<string, string> }) => Promise<any>
    downloadStream: (payload: {
      resourceId?: string
      url?: string
      viewId?: string
      quality?: string
      filename?: string
      outputPath?: string
      headers?: Record<string, string>
      concurrency?: number
    }) => Promise<any>
  }

  // PTY API（交互式终端）
  pty: {
    /**
     * 创建 pty 会话
     */
    spawn: (sessionId: string, options?: {
      cwd?: string
      env?: Record<string, string>
      cols?: number
      rows?: number
      /** 真实执行 Space；主进程据此设置 shell 的 TABTIN_SPACE_ID（桌面终端不传） */
      spaceId?: string
    }) => Promise<{ success: boolean }>

    /**
     * 向 pty 写入数据
     */
    write: (sessionId: string, data: string) => Promise<{ success: boolean }>

    /**
     * 调整 pty 大小
     */
    resize: (sessionId: string, cols: number, rows: number) => Promise<{ success: boolean }>

    /**
     * 终止 pty 会话
     */
    kill: (sessionId: string) => Promise<{ success: boolean }>

    /**
     * 终止 Agent 终端命令会话（杀真子进程，仅限 agent- 前缀 sessionId）
     */
    agentKill: (sessionId: string) => Promise<{ success: boolean }>

    /**
     * 将 Agent 前台命令转入后台（不杀进程，仅限 agent- 前缀 sessionId）
     */
    agentDetach: (sessionId: string) => Promise<{ success: boolean }>

    /**
     * 检查 pty 会话是否存在
     */
    has: (sessionId: string) => Promise<{ exists: boolean }>

    list: () => Promise<{ sessions: string[] }>

    readOutput: (sessionId: string, options?: { tail?: number }) => Promise<{
      success: boolean
      output?: string
      pid?: number
      cwd?: string
      isRunning?: boolean
      lastOutputAt?: number
      error?: { message: string; code: string }
    }>

    listWithStatus: (spaceId?: string) => Promise<{
      success: boolean
      sessions: Array<{
        id: string
        pid: number
        cwd: string
        isRunning: boolean
        lastOutputAt: number
        createdAt: number
        lastExitCode: number | null
        lastCommandCompletedAt: number | null
        hasPendingCommand: boolean
      }>
    }>

    onData: {
      (callback: (sessionId: string, data: string) => void): () => void
      (sessionId: string, callback: (data: string) => void): () => void
    }

    onExit: {
      (callback: (sessionId: string, exitCode: number, signal?: number) => void): () => void
      (sessionId: string, callback: (exitCode: number, signal?: number) => void): () => void
    }

    // P1-B (WP2)：payload 加 `description?: string | null` 字段，让 useAgentTerminalSync
    // hook 走 description ∶∶ command 截断 ∶∶ sessionId 的 Tab title fallback 链
    // （agent-bridge.ts hook L96-98）。bridge 旧 schema emit 与本 schema 字面一致。
    // L-WP6-1：补 `command?: string | null` 字段—— bridge 路径（LLM 起命令）
    // 必传完整命令字符串；4 件套人控路径（`PtyManager.spawnAgentSession`）emit
    // 时不传（无 LLM 命令上下文）。hook 端三级 fallback 兜底 command 缺失。
    onAgentSessionCreated: {
      (callback: (info: { sessionId: string; spaceId?: string; threadId: string | null; cwd: string; description?: string | null; command?: string | null }) => void): () => void
      (spaceId: string, callback: (info: { sessionId: string; spaceId?: string; threadId: string | null; cwd: string; description?: string | null; command?: string | null }) => void): () => void
    }

    onAgentSessionClosed: {
      (callback: (info: {
        sessionId: string
        spaceId?: string
        reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout'
      }) => void): () => void
      (spaceId: string, callback: (info: {
        sessionId: string
        spaceId?: string
        reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout'
      }) => void): () => void
    }

    // P1-H (WP2)：onAgentSessionTitle 已退役（D3 决策 + agent-bridge.ts L168-174）。

    onAutoRespondTriggered: {
      (callback: (info: {
        sessionId: string
        spaceId?: string | null
        pattern: string
        responseLength: number
        timestamp: number
      }) => void): () => void
      (spaceId: string, callback: (info: {
        sessionId: string
        spaceId?: string | null
        pattern: string
        responseLength: number
        timestamp: number
      }) => void): () => void
    }

    releaseThreadSession: (threadId: string) => Promise<{ success: boolean }>

    onPaneStatus: (callback: (event: PaneStatusEvent) => void) => () => void

    getPaneStatuses: () => Promise<{
      success: boolean
      statuses: Record<string, PaneStatus>
    }>

    snapshotSave: (snapshots: TerminalSnapshot[]) => Promise<{ success: boolean; saved?: number; failed?: number }>

    snapshotLoad: (sessionId: string, currentSize?: { cols: number; rows: number }) => Promise<{
      success: boolean
      snapshot?: TerminalSnapshot | null
    }>

    snapshotManifest: () => Promise<{
      success: boolean
      manifest?: SnapshotManifest | null
    }>

    snapshotSaveSync: (snapshots: TerminalSnapshot[]) => { success: boolean; saved?: number; failed?: number }

    snapshotDelete: (sessionId: string) => Promise<{ success: boolean }>

    snapshotClear: () => Promise<{ success: boolean }>

    /**
     * 粘贴图片到终端：保存剪贴板图片到本地，返回文件路径
     */
    pasteImage: (params: {
      imageBase64: string
      mimeType: string
      spaceId?: string
    }) => Promise<{ success: boolean; filePath?: string; error?: string }>
  }

  // 🆕 原生菜单 API（解决右键菜单被 WebContentsView 遮挡的问题）
  nativeMenu: {
    /**
     * 打开原生右键菜单
     * @param template 菜单模板（二维数组，每个子数组是一个分组）
     * @param x 菜单 X 坐标
     * @param y 菜单 Y 坐标
     * @returns 清理函数，用于移除事件监听器
     */
    open: (
      template: Array<Array<{
        id: string
        label?: string
        type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
        checked?: boolean
        enabled?: boolean
        accelerator?: string
        submenu?: Array<{
          id: string
          label?: string
          type?: 'normal' | 'separator'
          enabled?: boolean
        }>
      }>>,
      callbacks: Record<string, () => void>,
      x?: number,
      y?: number,
      onClose?: () => void
    ) => () => void
  }

  // 右键上下文菜单（主进程侧 locale 同步）
  contextMenu: {
    setLocale: (locale: string) => void
    onAddToContextRequest: (
      callback: (payload: BrowserContextMenuAddToContextPayload) => void,
    ) => () => void
  }

  // 透明 overlay view：toast / 全局模态
  overlay: {
    push: (payload: import('@shared/overlay/types').OverlayPushPayload) => Promise<{ success: boolean }>
    notifyReady: () => void
    focusOverlay: () => Promise<{ success: boolean }>
    syncGlobalSearchClosed: () => void
    subscribePush: (
      callback: (payload: import('@shared/overlay/types').OverlayPushPayload) => void,
    ) => () => void
    onConfirmResult: (
      callback: (payload: import('@shared/overlay/types').OverlayConfirmResultPayload) => void,
    ) => () => void
    sendUpdatePromptAction: (payload: import('@shared/overlay/types').OverlayUpdatePromptActionPayload) => void
    onUpdatePromptAction: (
      callback: (payload: import('@shared/overlay/types').OverlayUpdatePromptActionPayload) => void,
    ) => () => void
    onGlobalSearchClosed: (callback: () => void) => () => void
    sendConfirmResult: (payload: import('@shared/overlay/types').OverlayConfirmResultPayload) => void
    navigateSearchResult: (payload: unknown) => void
    onNavigateSearchResult: (callback: (payload: unknown) => void) => () => void
    sendNotificationAction: (payload: unknown) => void
    onNotificationAction: (callback: (payload: unknown) => void) => () => void
    notificationClosed: () => void
    onNotificationClosed: (callback: () => void) => () => void
    syncTheme: (snapshot: unknown) => void
    onSyncTheme: (callback: (snapshot: unknown) => void) => () => void
    syncLocale: (locale: string) => void
    onSyncLocale: (callback: (locale: unknown) => void) => () => void
    /**
     * 驱动 modal 子窗口 show/hide。像"保存密码条""自动填充建议"
     * 这类跑在 modal 子窗口的浮层，数据由主进程被动推送，但显隐由 renderer 按
     * "当前是否有可见内容"来驱动：有内容传 true（modal show、可点），无内容传
     * false（撤出该 source，无其他 source 时 hide、网页恢复交互）。
     * source 只能是 renderer 自己拥有的浮层（主进程侧白名单校验）。
     */
    setModalSourceOpen: (
      source: 'save-password' | 'autofill-suggest',
      open: boolean,
    ) => Promise<{ success: boolean; error?: string }>
    /**
     * 提示型浮层（自动填充建议）上报卡片实际尺寸，主进程据此把贴角小窗调整到
     * 刚好覆盖卡片（渲染进程用 ResizeObserver 驱动）。
     */
    setHintSize: (
      size: { width: number; height: number },
    ) => Promise<{ success: boolean; error?: string }>
    /**
     * toast 子窗口按命中区切换鼠标穿透（ 过渡期兜底）。
     * 仅 toast overlay renderer 应调用；指针在卡片上传 false，离开传 true。
     * 贴卡片收窗启用后主路径改走 setToastStackSize。
     */
    setToastIgnoreMouseEvents: (
      ignore: boolean,
    ) => Promise<{ success: boolean; error?: string }>
    /**
     * 当前指针相对 toast 内容区的 client 坐标。
     * toast 刚出现且指针静止时，用此结果做一次命中同步。
     */
    getToastCursorClientPoint: () => Promise<{ clientX: number; clientY: number } | null>
    /**
     * toast 贴卡片：上报可见栈尺寸，主进程收成顶栏小窗并捕获点击。
     * 无可见 toast 时传 null，恢复全屏穿透。
     */
    setToastStackSize: (
      size: { width: number; height: number } | null,
    ) => Promise<{ success: boolean; error?: string }>
    /**
     * toast 是否有可见卡片（仅 toast overlay renderer）。
     * Windows 上无卡片时主进程隐藏子窗，避免 OLE HTML5 拖拽被顶层 HWND 打断。
     */
    setToastContentVisible: (
      visible: boolean,
    ) => Promise<{ success: boolean; error?: string }>
    /**
     * HTML5 拖拽会话屏蔽 toast（主 renderer，同步 IPC）。
     * dragstart 内必须同步完成，否则 Win32 OLE 会话会在 hide 前取消。
     */
    setHtml5DragShieldSync: (active: boolean) => { success: boolean; error?: string }
  }

  // 🔔 统一通知服务
  notification: {
    show: (payload: NotificationPayload) => void
    getPermissionStatus: () => Promise<NotificationPermissionStatus>
    getHostState: () => Promise<{ hasMainWindow: boolean }>
    getPrefs: () => Promise<{
      enabled: boolean
      desktopEnabled: boolean
      dockBadgeEnabled: boolean
      soundEnabled: boolean
      dndEnabled: boolean
      dndSchedule?: { start: string; end: string; days: number[] }
      categoryOverrides: Record<string, {
        desktopEnabled?: boolean
        soundEnabled?: boolean
        dockBadgeEnabled?: boolean
      }>
    }>
    setPrefs: (prefs: Record<string, unknown>) => Promise<{ success: boolean }>
    setBadgeCount: (count: number) => Promise<{ success: boolean }>
    clearBadge: () => Promise<{ success: boolean }>
    checkPermission: () => Promise<NotificationPermissionStatus>
    onNavigate: (callback: (data: NavigateTarget) => void) => () => void
    onHostStateChanged: (callback: (data: { hasMainWindow: boolean }) => void) => () => void
    onShown: (callback: (data: Record<string, unknown>) => void) => () => void
    onToastFallback: (callback: (data: { type: string; title: string; body: string }) => void) => () => void
    onSessionViewed: (callback: (data: { sessionId: string }) => void) => () => void
    // IA Phase 2：通知偏好跨设备同步
    syncPrefsFromServer: () => Promise<{ success: boolean }>
    notifyRemotePrefsChanged: (data: { value?: unknown; updatedAt?: number }) => void
    onPrefsChanged: (callback: (prefs: Record<string, unknown>) => void) => () => void
  }

  /**
   * 应用级桌面行为设置（设备级，存主进程 app-config.json，不进后端 ui_settings）：
   * 桌面后台常驻开关 + 开机自启。set 后主进程立即生效
   * （创建/销毁托盘、更新系统登录项）。
   */
  appSettings: {
    get: () => Promise<{ minimizeToTray: boolean; autoStart: boolean }>
    set: (partial: { minimizeToTray?: boolean; autoStart?: boolean }) => Promise<{
      success: boolean
      settings?: { minimizeToTray: boolean; autoStart: boolean }
      error?: string
    }>
  }

  // 深链接事件
  deepLink: {
    onDeepLink: (callback: (data: { path: string; url: string }) => void) => () => void
  }

  /**
   * W3 改造（专题"Agent 产物在 Space 内的打开" RFC §4.2 / §4.3）：
   * 主窗口 / crawlspace 的 setWindowOpenHandler 兜底 IPC 通道——把 main 拦截到的
   * 新窗口请求转发给 renderer ResourceRouter 接管派发，避免 main 进程重新实现一套。
   */
  resourceRouter: {
    onOpenFallback: (
      callback: (data: {
        url: string
        source: string
        viewId?: string
        disposition?: string
        filename?: string
        mimeType?: string
        assetId?: string
      }) => void,
    ) => () => void
  }

  // NOTE: W7 resource_open 埋点 IPC 通道 contract 在下方 `resourceTelemetry` 块（行 ~1726）
  // 统一声明——renderer 端 `services/resourceTelemetryEmitter.ts` 读 `tabtin.resourceTelemetry`。
  // 早期设计稿曾起名 `resourceOpenTelemetry`，已与 `resourceTelemetry` 合并，避免双轨。

  /** 进程监控连续上报失败且主进程已停止全部 Monitor 时触发（与 monitor:emitInterrupted 文案配套） */
  agentMonitor: {
    onEmitInterrupted: (callback: () => void) => () => void
  }

  // 🆕 应用更新
  updater: {
    getAppVersion: () => Promise<string>
    getState: () => Promise<any>
    getReleaseHistory: (options?: {
      platform?: 'mac' | 'win' | 'linux'
      arch?: 'x64' | 'arm64'
      channel?: 'stable' | 'beta' | 'alpha'
      limit?: number
      locale?: string
    }) => Promise<any[]>
    checkForUpdates: () => Promise<any>
    downloadUpdate: () => Promise<any>
    quitAndInstall: () => void
    onUpdateEvent: (callback: (payload: { event: string; data?: any }) => void) => () => void
  }

  // 🆕 客户端诊断日志导出
  diagnostics: {
    readLogs: () => Promise<import('../shared/diagnostics-types').DiagnosticsLogSnapshot>
    getHostEnv: () => Promise<import('../shared/diagnostics-types').DiagnosticsHostEnv>
    saveBundle: (
      payload: import('../shared/diagnostics-types').DiagnosticsBundlePayload,
    ) => Promise<import('../shared/diagnostics-types').DiagnosticsSaveResult>
    queueSupportUpload: (
      payload: import('../shared/diagnostics-types').DiagnosticsBundlePayload,
    ) => Promise<import('../shared/diagnostics-types').DiagnosticsSupportUploadResult>
    openLogDir: () => Promise<import('../shared/diagnostics-types').DiagnosticsOpenDirResult>
    onTriggerExport: (callback: () => void) => () => void
    onTriggerCopy: (callback: () => void) => () => void
  }

  /** ：协作 WS 握手持久挂起时的网络栈软自愈（closeAllConnections + clearHostResolverCache） */
  network: {
    recoverStack: (payload: { reason: string }) => Promise<{
      performed: boolean
      cooldownRemainingMs: number
    }>
  }

  /** 卸载 / 重置：清登录凭证与可选全量本地数据 */
  appCleanup: {
    wipeCredentials: () => Promise<{
      ok: boolean
      removed: string[]
      failed: Array<{ path: string; errorCode: 'busy' | 'permission' | 'unknown' }>
      credentialsCleared?: boolean
    }>
    wipeLocalData: () => Promise<{
      ok: boolean
      removed: string[]
      failed: Array<{ path: string; errorCode: 'busy' | 'permission' | 'unknown' }>
      credentialsCleared?: boolean
      /** 已预约重启清理，应用即将退出并自动重启（安装包） */
      willRelaunch?: boolean
      /** 开发模式无法自动 relaunch：需手动重启 pnpm dev */
      needsManualDevRestart?: boolean
    }>
    uninstallApp: (options?: {
      deleteLocalData?: boolean
    }) => Promise<{
      ok: boolean
      credentials: {
        ok: boolean
        removed: string[]
        failed: Array<{ path: string; errorCode: 'busy' | 'permission' | 'unknown' }>
        credentialsCleared?: boolean
      }
      localData: {
        ok: boolean
        removed: string[]
        failed: Array<{ path: string; errorCode: 'busy' | 'permission' | 'unknown' }>
        credentialsCleared?: boolean
      } | null
      willExit: boolean
    }>
    listCleanupPaths: () => Promise<{
      credentials: string[]
      configAndCache: string[]
      fullWipe: string[]
    }>
  }

  power: {
    preventSleep: () => Promise<void>
    allowSleep: () => Promise<void>
  }

  marketplace: {
    /** Device 级 app 安装：下载本地二进制（返 envelope 由 invokeIpc 自动解包/throw）。 */
    installApp: (appId: string, manifest: Record<string, unknown>) => Promise<unknown>
    /** Device 级 app 卸载：清本地二进制。 */
    uninstallApp: (appId: string) => Promise<unknown>
    /** 列出本地已安装 device 级 app（返 `Record<appId, manifest>` 或 null）。 */
    listInstalled: () => Promise<Record<string, unknown> | null>
  }

  appDiscovery: {
    /** 推送 url patterns 到 main 端 AppDiscoveryService（fire-and-forget）。 */
    updatePatterns: (
      patterns: Array<{ appId: string; appName: string; patterns: string[] }>,
      sourceId?: string,
    ) => void
  }

  screenshot: {
    readFileAsDataURL: (filePath: string) => Promise<string>
  }

  // 🆕 下载管理
  downloads: {
    getAll: () => Promise<DownloadIPCResult>
    pause: (id: string) => Promise<DownloadIPCResult>
    resume: (id: string) => Promise<DownloadIPCResult>
    cancel: (id: string) => Promise<DownloadIPCResult>
    open: (id: string) => Promise<DownloadIPCResult>
    showInFolder: (id: string) => Promise<DownloadIPCResult>
    removeItem: (id: string) => Promise<DownloadIPCResult>
    clearCompleted: () => Promise<DownloadIPCResult>
    retry: (id: string) => Promise<DownloadIPCResult>
    deleteFile: (id: string) => Promise<DownloadIPCResult>
    getActiveCount: () => Promise<DownloadIPCResult>
    onStarted: (callback: (info: DownloadItemData) => void) => () => void
    onProgress: (callback: (info: DownloadItemData) => void) => () => void
    onCompleted: (callback: (info: DownloadItemData) => void) => () => void
    cancelStream: (id: string) => Promise<DownloadIPCResult>
    onStreamProgress: (callback: (progress: StreamProgressEvent) => void) => () => void
    onStreamCompleted: (callback: (data: StreamCompletedEvent) => void) => () => void
    onStreamFailed: (callback: (data: StreamFailedEvent) => void) => () => void
  }

  zoom: {
    setZoomFactor: (factor: number) => void
    getZoomFactor: () => number
  }

  sandbox: {
    clearApprovalCache: (target?: 'session' | 'persisted') => Promise<{ sessionCount: number; persistedCount: number }>
    clearApprovalByActionType: (actionType: string) => Promise<{ sessionCount: number; persistedCount: number }>
    getApprovalCacheStats: () => Promise<{ sessionCount: number; persistedCount: number }>
    syncApprovalPreferences: () => Promise<{ sessionCount: number; persistedCount: number }>
    notifyRemoteApprovalPreferencesChanged: (preferences: Record<string, unknown>) => void
  }

  captcha: {
    onInterventionRequired: (callback: (payload: { tabId: string; captchaType: string; message: string }) => void) => () => void
    resolveIntervention: (tabId: string) => void
  }

  /**
   * 外部 Agent 工具（Cursor / Codex / Claude Code / WorkBuddy）本地会话导入
   * （Layer B 宿主编排，spec §2.5）。detect/scan 轻量只读；run 异步返回 jobId，
   * 进度经 onProgress 订阅 import:progress 事件。
   */
  import: {
    detect: () => Promise<ImportDetectOutput>
    scan: (input: ImportScanInput) => Promise<ImportScanResult>
    run: (input: ImportRunInput) => Promise<ImportRunOutput>
    status: (input: ImportStatusInput) => Promise<ImportStatusOutput>
    cancel: (input: ImportCancelInput) => Promise<ImportCancelOutput>
    rollback: (input: ImportRollbackInput) => Promise<ImportRollbackOutput>
    listArchives: (organizationId: string) => Promise<unknown[]>
    getArchive: (input: {
      organizationId: string
      source: string
      sourceSessionId: string
    }) => Promise<{ meta: unknown; messages: unknown[] } | null>
    /** 删除单条本机外部档案。 */
    deleteArchive: (input: {
      organizationId: string
      source: string
      sourceSessionId: string
    }) => Promise<{ deleted: number }>
    /** 删 Workspace 时顺带清本机外部档案（按 workspaceId 或同 workingDir）。 */
    deleteArchivesForWorkspace: (input: {
      organizationId: string
      workspaceId: string
      workingDir?: string | null
    }) => Promise<{ deleted: number }>
    /** 绑定档案首次展开后的真会话，再次点击复用。 */
    bindOpenedSession: (input: {
      organizationId: string
      source: string
      sourceSessionId: string
      sessionId: string
    }) => Promise<{ ok: boolean; seeded?: boolean; reason?: string }>
    /** 把本机导入档案写入 session transcript，供 Agent 跨轮读取。 */
    seedSessionTranscript: (input: {
      organizationId: string
      source: string
      sourceSessionId: string
      sessionId: string
      spaceId?: string
    }) => Promise<{ seeded: boolean; reason?: string }>
    /** 订阅导入进度事件；返回取消订阅函数。 */
    onProgress: (callback: (payload: ImportProgressEvent) => void) => () => void
  }

  codexSessionShare: {
    projects: () => Promise<Array<{ id: string; name: string; path: string }>>
    read: (sessionId: string) => Promise<{
      sessionId: string
      title: string
      fileName: string
      size: number
      buffer: ArrayBuffer
    }>
    import: (input: {
      filePath: string
      projectId: string
      projectPath: string
      expectedSessionId?: string
      expectedSessionName?: string
    }) => Promise<{
      sessionId: string
      importedPath: string
      alreadyImported: boolean
    }>
    open: (sessionId: string, projectId: string, projectPath: string) => Promise<{ opened: boolean }>
  }

  credentialVault: {
    detectBrowsers: () => Promise<DetectBrowsersResult>
    extractCookies: (payload: {
      browser: string
      profilePath: string
      options?: { domains?: string[]; includeExpired?: boolean }
    }) => Promise<ExtractCookiesResult>
    injectCookies: (payload: {
      partition: string
      cookies: IPCCookie[]
    }) => Promise<{ success: boolean; injected: number; failed: number; error?: string }>
    getPartitionCookies: (payload: {
      partition: string
    }) => Promise<{
      success: boolean
      summary?: PartitionCookieSummary
      error?: string
    }>
    clearPartitionCookies: (payload: {
      partition: string
      domain?: string
    }) => Promise<{ success: boolean; removed: number; error?: string }>
    checkLoginStatus: (payload: {
      partition: string
      domain: string
    }) => Promise<{
      success: boolean
      domain?: string
      hasCookies?: boolean
      cookieCount?: number
      hasSessionCookie?: boolean
      error?: string
    }>
    exportCookiesJson: (payload: {
      partition: string
    }) => Promise<{ success: boolean; path?: string; count?: number; error?: string }>
    importCookiesJson: () => Promise<{
      success: boolean
      cookies?: IPCCookie[]
      count?: number
      error?: string
    }>
    extractPasswords: (payload: {
      browser: string
      profilePath: string
    }) => Promise<ExtractPasswordsResult>
    onAutofillSuggest: (callback: (payload: {
      tabId: string
      credentials: Array<{ id: string; url: string; username: string; masked_password: string }>
      formInfo: { hasPassword: boolean; hasUsername: boolean; domain: string }
    }) => void) => () => void
    /**
     * 主进程通知「清掉该 tab 的自动填充建议卡片」。用于用户在提示上没操作、
     * 但页面已真实跳转（如手动登录成功）时，避免卡片残留在角落。
     */
    onAutofillClear: (callback: (payload: { tabId: string }) => void) => () => void
    autofillSelect: (payload: { tabId: string; credentialId: string }) => Promise<{ success: boolean; error?: string }>
    autofillDismiss: (payload: { tabId: string }) => Promise<{ success: boolean }>
    /**
     * Wave 3 G3：保存密码提示。主进程在用户提交登录表单且验证成功后发出。
     * payload.mode 决定 SavePasswordBar 的文案（save / update / new-account）。
     *
     * **安全约定**：payload **不**包含 password 字段——密码留在主进程
     * `pendingSavePasswords` map，renderer 通过 saveConfirm({tabId}) 触发
     * 主进程内部反查取密码 + 调后端。
     */
    onSavePrompt: (callback: (payload: {
      tabId: string
      mode: 'save' | 'update' | 'new-account'
      domain: string
      url: string
      username: string
      credentialId?: string
      existingUsernames?: string[]
    }) => void) => () => void
    /**
     * 用户点"保存" — renderer 只发 tabId，主进程根据 pending map 取密码 + 走
     * POST /website/create 或 PUT /{id}。密码全程不出主进程。
     */
    saveConfirm: (payload: {
      tabId: string
    }) => Promise<{ success: boolean; mode?: string; data?: unknown; error?: string }>
    /** 用户点"不为此网站保存"——主进程把 domain 入黑名单（PD-8 后端持久化） */
    saveDismiss: (payload: { domain: string }) => Promise<{ success: boolean; error?: string }>
    /**
     * Wave 3 P0 视角 2#1：撤销加黑——用户在 5s 撤销窗口内反悔。
     * 主进程同时清本地 cache（5min TTL 不再漂移），调后端 DELETE。
     */
    saveUndismiss: (payload: { domain: string }) => Promise<{ success: boolean; error?: string }>
    /**
     * Wave 4 视角 1+2 P0 自修：Agent 后台 view 自动登录失败通知。
     *
     * 触发时机：Agent 后台 view 命中已存凭据 → 自动 reveal+fill+submit 流程
     * 中任一步失败时主进程会发出。renderer 订阅后展示 Toast / 状态徽章，
     * 兑现 PRD Story 5 异常路径"自动登录 {domain} 失败，密码可能已过期，
     * 请手动更新"。
     *
     * code 取值：
     *   - reveal-fn-not-configured：主进程未注入 reveal fn（生产环境不应发生）
     *   - credential-unavailable：后端 410 / 401 / 网络失败 → 凭据可能失效
     *   - fill-failed：表单填充失败（域名不匹配 / DOM 不可达）
     */
    onAgentAutofillFailed: (callback: (payload: {
      tabId: string
      code: string
      credentialId?: string
      domain?: string
      detail?: string
      /**
       * Wave 4 真·真 Review 视角 2 P1 发现 3 自修：透传 spaceId 让 renderer
       * 通过 useSpaceStore 反查 Agent 名字，多 Agent 协作场景下用户能区分
       * "是哪个 Agent 在动"。spaceId 不是敏感数据，零安全风险。
       */
      spaceId?: string
    }) => void) => () => void

    /**
     * Wave 4 三视角 Review 视角 2 P1 发现 2 自修：成功路径也通知用户。
     *
     * **为什么必须订阅**：PD-9 不挡 Agent 自动登录任何网站（含银行/支付）；
     * 不通知 = "TabTin 擅自动我账户" → 用户信任崩盘。
     *
     * payload **不含密码** 且 ``maskedUsername`` 已经在主进程脱敏
     * （`alice@example.com → a***@example.com`）。
     */
    onAgentAutofillSucceeded: (callback: (payload: {
      tabId: string
      domain: string
      maskedUsername: string
      credentialId: string
      /**
       * Wave 4 真·真 Review 视角 2 P1 发现 3 自修：透传 spaceId 让 renderer
       * 反查 Agent 名字。
       */
      spaceId?: string
    }) => void) => () => void
  }

  loginRelay: LoginRelayAPI

  browserEnv: {
    /**
     * 读全量本地快照：environments + Space bindings。
     *
     * 本地化退役 Wave 1 后该接口同步从 `BrowserEnvLocalStore` 读 —— 永远
     * 立即返回,不再有 HTTP / pending 概念。
     */
    list: () => Promise<
      | ({ success: true; environments: BrowserEnvironment[]; bindings: BrowserEnvBinding[] })
      | { success: false; code?: string; error?: string }
    >
    create: (payload: { name: string }) => Promise<BrowserEnvWriteResult>
    rename: (payload: { id: string; name: string }) => Promise<BrowserEnvWriteResult>
    delete: (payload: { id: string }) => Promise<BrowserEnvDeleteResult>
    bindSpace: (payload: { spaceId: string; environmentId: string }) => Promise<BrowserEnvBindResult>
    /** 同步 IPC：走 invoke 异步链但主进程端是纯同步查询，毫秒级返回。 */
    getPartition: (payload: { spaceId: string }) => Promise<string>
    getEnvironmentForSpace: (payload: { spaceId: string }) => Promise<BrowserEnvGetPartitionResult>
    /** 订阅主进程缓存变更（settings 改名 / 绑定切换都会触发）。 */
    onChanged: (callback: (payload: { reason: string; environmentId?: string; spaceId?: string }) => void) => () => void
  }

  tabsite: {
    initTemplate: (siteId: string, spaceId: string) => Promise<{
      success: boolean
      code_project_path?: string
      already_exists?: boolean
      template?: string
      token_provisioned?: boolean
      token_warning?: string
      token_expires_soon?: boolean
      error?: string
    }>
    startDevServer: (siteId: string, projectPath: string) => Promise<{
      success: boolean
      url?: string
      port?: number
      error?: string
      already_running?: boolean
    }>
    stopDevServer: (siteId: string) => Promise<{ stopped: boolean }>
    getDevServerStatus: (siteId: string) => Promise<{
      running: boolean
      url?: string
      port?: number
    }>
  }

  tins: {
    getActivationStates: () => Promise<unknown[]>
    togglePanel: (instanceId: string, visible?: boolean) => Promise<void>
    setInstances: (instances: unknown[]) => Promise<void>
    prepareSandbox: (instanceId: string) => Promise<{ htmlPath: string; preloadPath: string } | null>
    cleanupSandbox: (instanceId: string) => Promise<void>
    getResolvedVariables: (instanceId: string) => Promise<Record<string, unknown>>
    getPageContext: () => Promise<{ url: string; title: string; language?: string }>
    syncPageContext: (context: { url: string; title: string }) => Promise<void>
    onActivationChanged: (callback: (data: { states: unknown[] }) => void) => () => void
    onPersistVariable: (callback: (data: { instanceId: string; name: string; value: unknown }) => void) => () => void
    onToast: (callback: (data: { message: string; type: string }) => void) => () => void
    onAgentRequest: (callback: (data: { requestId: string; instruction: string; organizationId: string }) => void) => () => void
    respondAgent: (requestId: string, result: { reply?: string; error?: string }) => void
    registerWebview: (instanceId: string, contentsId: number) => Promise<void>
    unregisterWebview: (instanceId: string) => Promise<void>
    onTriggerGoal: (callback: (data: { instanceId: string; goalId: string; params?: Record<string, unknown> }) => void) => () => void
    onWriteTable: (callback: (data: { instanceId: string; tableId: string; records: Record<string, unknown>[]; organizationId: string }) => void) => () => void
  }

  system: {
    onSuspend: (callback: () => void) => () => void
    onResume: (callback: () => void) => () => void
  }

  browserPrefs: {
    syncSearchEngine: (urlTemplate: string) => void
    syncAccessPolicy: (policy: string) => void
  }

  agentGateway: {
    onStatusChange: (callback: (status: string) => void) => () => void
    getStatus: () => Promise<unknown>
    onEvent: (callback: (envelope: Record<string, unknown>) => void) => () => void
    onReconnected: (callback: () => void) => () => void
    request: (payload: { messageType: string; payload?: Record<string, unknown>; requestOptions?: Record<string, unknown> }) => Promise<{
      ok: boolean
      type: string
      requestId?: string
      payload?: Record<string, unknown>
      error?: { code?: string; message?: string }
    }>
    send: (payload: { messageType: string; payload?: Record<string, unknown>; requestOptions?: Record<string, unknown> }) => Promise<{
      ok: boolean
      error?: { code?: string; message?: string }
    }>
    subscribe: (payload: { topics: string[]; options?: { topicContexts?: Record<string, Record<string, unknown>> } }) => Promise<{
      ok: boolean
      type: string
      requestId?: string
      payload?: Record<string, unknown>
      error?: { code?: string; message?: string }
    }>
    unsubscribe: (payload: { topics: string[] }) => Promise<{
      ok: boolean
      type: string
      requestId?: string
      payload?: Record<string, unknown>
      error?: { code?: string; message?: string }
    }>
    reconnect: () => Promise<boolean>
    getOrganizationIds: () => Promise<string[]>
  }

  skill: {
    /** 列出当前 Space 的本地 Skills catalog（host 会先 ensureSpaceSkills）。 */
    list: (params: {
      spaceId: string
      organizationId: string
    }) => Promise<{
      skills: Array<{
        skill_id: string
        name: string
        description?: string
        version?: string
        source: 'platform' | 'app' | 'device' | 'user'
        app_id?: string | null
        skill_key: string
        path?: string
        doc_path?: string
        tags?: string[]
        category?: string | null
        status?: string
        meta?: Record<string, unknown>
        enabled?: boolean
        primary_env?: string
      }>
    }>
    install: (params: {
      skillKey: string
      /** @deprecated  本地落盘不再按 space */
      spaceId?: string
      /** ：必填真实 userId（禁止落到 `_unscoped`） */
      userId?: string
      organizationId?: string
      files: Array<{ path: string; sha256: string; size: number; download_url: string; content_type: string }>
      meta?: { source: string; version: string; installedAt: string; packageId: string; slug?: string; canonicalKey?: string; versionSeq?: number; bundleSha256?: string }
    }) => Promise<{ ok: boolean; filesWritten: number; error?: string }>
    /** ：从 npm 包安装到 ~/.agents/skills（面板「从 npm」页签）。 */
    installNpm: (params: {
      package: string
      spaceId?: string
      organizationId?: string | null
      importToSpace?: boolean
      enableSpaceIds?: string[]
    }) => Promise<{
      success: boolean
      data?: {
        package: string
        agents_skills_dir: string
        discovered_slugs: string[]
        imported: unknown[]
        note?: string
      }
      error?: string
    }>
    /** marketplace 分发的 app skill 按需物化到本地（商店安装闭环， app 子案）。 */
    materializeApp: (params: {
      /** @deprecated  本地落盘不再按 space */
      spaceId?: string
      organizationId: string
      userId?: string
      appId: string
      slug: string
    }) => Promise<{ installed: number; skipped: number }>
    uninstall: (params: {
      skillKey: string
      /** @deprecated  */
      spaceId?: string
      userId?: string
      organizationId?: string
    }) => Promise<{ ok: boolean }>
    readContent: (params: {
      skillKey: string
      spaceId?: string | null
      organizationId?: string | null
      userId?: string | null
      sourceDocPath?: string | null
    }) => Promise<{ content: string | null }>
    /** 把草稿 SKILL.md 写入 platform-data；organizationId 必传，避免落到 `_unscoped`。 */
    writeContent: (params: {
      spaceId: string
      organizationId: string
      skillKey: string
      content: string
    }) => Promise<{ mdPath: string; skillDir: string }>
    /** 查询 skill 在本地的绝对路径（不创建目录） */
    resolvePath: (params: {
      spaceId: string
      organizationId: string
      skillKey: string
    }) => Promise<{ skillDir: string; mdPath: string; exists: boolean; mdExists: boolean }>
    /**
     * ：扫描 Workspace 根下目录自带 Skill。纯发现无 Trust 门控。
     * invokeIpc 已 unwrap envelope → 成功直接得 data；失败抛 PlatformIpcError。
     */
    workspaceScan: (params: { workspaceRoot: string; force?: boolean }) => Promise<{
      truncated?: boolean
      skills: Array<{
        key: string
        slug: string
        name: string
        display_name?: string
        description?: string
        emoji?: string
        rel_path?: string
        doc_path?: string
        content_hash?: string
        realpath?: string
      }>
    }>
  }

  /**
   * Widget Wave 7 补丁：UI theme 同步 channel。renderer 的 useIsDarkMode
   * 变化时调本 API 告诉 main 当前 theme——show-widget 烤图链路
   * `resolveUITheme()` 取的就是这个值。
   */
  uiTheme: {
    report: (theme: 'light' | 'dark') => Promise<{ ok: boolean; theme: 'light' | 'dark' }>
  }

  /**
   * Widget Wave 7 补丁：widget sendPrompt audit log。renderer 每次成功触发
   * sendPrompt 后 fire-and-forget 调本 API 把事件落 `~/.tabtin/widget-audit.log`。
   */
  widgetAudit: {
    append: (entry: {
      timestamp: number
      session_id: string
      widget_id: string
      text: string
      meta?: unknown
      trigger_source?: 'widget'
    }) => Promise<{ ok: boolean }>
  }

  /**
   * 「Agent 产物在 Space 内的打开」专题 W7：ResourceRouter 派发事件埋点上报。
   *
   * renderer 的 ResourceRouter 每次完成 `open()` 都会通过本 API 把事件
   * 转给 main 进程 telemetry queue（5s flush 或 100 条 flush 触发批量
   * POST 到 Django），最终落 PG `agent_engine_resource_open_event` 表，
   * 供抽样脚本跑 PRD §6 三个成功标准的真实数字。
   *
   * fire-and-forget 语义：永远 ok=true。失败永远不能阻塞用户点链接。
   */
  resourceTelemetry: {
    emit: (event: ResourceOpenEventPayload) => Promise<{ ok: boolean }>
  }

  agentSecurity: {
    // setYoloMode / revokeMemo 已移除：状态变更统一走 useSpaceStore action
    // （见 ElectronAgentHost.ts L-10 的历史背景注释）。本接口只保留只读查询。
    getWorkspaceSnapshot: (spaceId: string) => Promise<any>
    buildApprovalKey: (params: {
      toolName: string
      subcmd: string
      input: unknown
      inWorkspace: boolean
      scope: 'exact' | 'scoped' | 'wildcard'
      kind?: string
    }) => Promise<string>
    buildScopeDescription: (params: {
      toolName: string
      subcmd: string
      scope: string
    }) => Promise<string>
  }

  workspace: {
    /**
     * 通知主进程当前 Space 的工作区路径快照（单根契约 break 版）。
     *
     * 见 docs/single-root-space-prd.md §2.2：
     *   - `spaceId`：必填——main 端按 spaceId 路由到对应 session 的 snapshot
     *     mutate；spaceId 缺失（renderer 没拿到 active Space）→ main 端 fail-closed
     *     不动任何 session
     *   - `workingDir`：该 Space 绑定 Agent 的 `working_dir`（已 realpath）。
     *     空字符串 = Agent 没设置工作目录（allowedPaths 只剩 sandbox 兜底）
     *
     * 调用时机：renderer store mutate / 启动 hydrate / Space 切换 hydrate /
     * Agent working_dir 修改后。
     */
    notifyPathsChanged: (payload: {
      spaceId: string
      workingDir: string
    }) => Promise<void>
    /**
     * 把审批通过的路径加进当前 session 的 `allowedPaths`（不持久化）。
     *
     * 单根契约 §2.4：ApprovalPanel "添加路径并批准"通过本接口，让审批通过的
     * 路径**真的能被 Agent 后续访问**——session 内一次审批，所有 fs/git/checkpoint
     * 等访问全部放行。session 重启 / 切 Space / 切 Agent 后失效，需要重新审批。
     *
     * 不写 store、不进 UI 列表（避免污染单根契约）。过宽路径（`/`、`/Users` 等）
     * 在 main 端被 fail-closed 过滤。
     */
    appendSessionAllowedPath: (payload: {
      spaceId: string
      sessionId?: string
      path: string
    }) => Promise<{ ok: boolean; data?: { mutated: boolean } } | void>
  }

  /**
   * Dev-only inspector bridge — contract W2-ζ。
   *
   * 仅在 dev / test build 下非 null（preload 用 process.env.NODE_ENV
   * guard，prod build esbuild dead-code-eliminate 整段为 null）。
   * renderer 端 IpcInspector 通过判 null 决定是否挂载浮层。
   *
   * subscribeIpcCalls 当前是 W2-α 接管点的 placeholder——W2-α 的
   * invokeIpc 完成时通过 preload 内部 `notifyIpcCallForInspector` 触发
   * 通知；W2-α 上线前 IPC 路径暂时空着，不影响 HTTP 路径。
   */
  devInspector: {
    subscribeIpcCalls: (cb: (record: unknown) => void) => () => void
    subscribeHttpCalls: (cb: (record: unknown) => void) => () => void
  } | null
}

// P1-H (WP2)：'agent-session-title' 已退役（D3 + agent-bridge.ts L168-174）。
type PtyScopedSubscriptionEventType =
  | 'data'
  | 'exit'
  | 'agent-session-created'
  | 'agent-session-closed'
  | 'auto-respond-triggered'

const ptySubscriptionRefCounts: Record<PtyScopedSubscriptionEventType, Map<string, number>> = {
  data: new Map<string, number>(),
  exit: new Map<string, number>(),
  'agent-session-created': new Map<string, number>(),
  'agent-session-closed': new Map<string, number>(),
  'auto-respond-triggered': new Map<string, number>(),
}

const GLOBAL_PTY_SUBSCRIPTION_KEY = '*'

const normalizePtySubscriptionScopeId = (scopeId?: string): string | undefined => {
  const normalized = scopeId?.trim()
  return normalized ? normalized : undefined
}

const retainPtySubscription = (
  eventType: PtyScopedSubscriptionEventType,
  scopeId?: string,
) => {
  const normalizedScopeId = normalizePtySubscriptionScopeId(scopeId)
  const key = normalizedScopeId || GLOBAL_PTY_SUBSCRIPTION_KEY
  const bucket = ptySubscriptionRefCounts[eventType]
  const nextCount = (bucket.get(key) ?? 0) + 1
  bucket.set(key, nextCount)
  if (nextCount === 1) {
    sendIpc(`pty:subscribe-${eventType}`, normalizedScopeId)
  }
  return key
}

const releasePtySubscription = (
  eventType: PtyScopedSubscriptionEventType,
  subscriptionKey: string,
) => {
  const bucket = ptySubscriptionRefCounts[eventType]
  const currentCount = bucket.get(subscriptionKey) ?? 0
  if (currentCount <= 1) {
    bucket.delete(subscriptionKey)
    const scopeId = subscriptionKey === GLOBAL_PTY_SUBSCRIPTION_KEY
      ? undefined
      : subscriptionKey
    sendIpc(`pty:unsubscribe-${eventType}`, scopeId)
    return
  }
  bucket.set(subscriptionKey, currentCount - 1)
}

function ptyOnData(callback: (sessionId: string, data: string) => void): () => void
function ptyOnData(sessionId: string, callback: (data: string) => void): () => void
function ptyOnData(
  sessionIdOrCallback: string | ((sessionId: string, data: string) => void),
  maybeCallback?: (data: string) => void,
): () => void {
  const scopedSessionId = typeof sessionIdOrCallback === 'string'
    ? normalizePtySubscriptionScopeId(sessionIdOrCallback)
    : undefined
  const callback = typeof sessionIdOrCallback === 'function'
    ? sessionIdOrCallback
    : maybeCallback

  if (!callback) return () => {}

  const subscriptionKey = retainPtySubscription('data', scopedSessionId)
  const listener = (_event: any, sessionId: string, data: string) => {
    if (scopedSessionId) {
      if (sessionId === scopedSessionId) {
        ;(callback as (data: string) => void)(data)
      }
      return
    }
    ;(callback as (sessionId: string, data: string) => void)(sessionId, data)
  }
  ipcRenderer.on('pty:data', listener)

  return () => {
    ipcRenderer.removeListener('pty:data', listener)
    releasePtySubscription('data', subscriptionKey)
  }
}

function ptyOnExit(callback: (sessionId: string, exitCode: number, signal?: number) => void): () => void
function ptyOnExit(sessionId: string, callback: (exitCode: number, signal?: number) => void): () => void
function ptyOnExit(
  sessionIdOrCallback: string | ((sessionId: string, exitCode: number, signal?: number) => void),
  maybeCallback?: (exitCode: number, signal?: number) => void,
): () => void {
  const scopedSessionId = typeof sessionIdOrCallback === 'string'
    ? normalizePtySubscriptionScopeId(sessionIdOrCallback)
    : undefined
  const callback = typeof sessionIdOrCallback === 'function'
    ? sessionIdOrCallback
    : maybeCallback

  if (!callback) return () => {}

  const subscriptionKey = retainPtySubscription('exit', scopedSessionId)
  const listener = (_event: any, sessionId: string, exitCode: number, signal?: number) => {
    if (scopedSessionId) {
      if (sessionId === scopedSessionId) {
        ;(callback as (exitCode: number, signal?: number) => void)(exitCode, signal)
      }
      return
    }
    ;(callback as (sessionId: string, exitCode: number, signal?: number) => void)(sessionId, exitCode, signal)
  }
  ipcRenderer.on('pty:exit', listener)

  return () => {
    ipcRenderer.removeListener('pty:exit', listener)
    releasePtySubscription('exit', subscriptionKey)
  }
}

// L-WP6-1：payload 加 `description?` / `command?` 字段（与 type 声明严格同源）。
// 两个字段都可空：description 由 LLM 是否显式传决定；command 由 emit 来源决定
// （bridge 路径必传、4 件套人控路径不传）。hook 端三级 fallback 兜底。
type AgentSessionCreatedPayload = {
  sessionId: string
  spaceId?: string
  threadId: string | null
  cwd: string
  description?: string | null
  command?: string | null
}

function ptyOnAgentSessionCreated(
  callback: (info: AgentSessionCreatedPayload) => void,
): () => void
function ptyOnAgentSessionCreated(
  spaceId: string,
  callback: (info: AgentSessionCreatedPayload) => void,
): () => void
function ptyOnAgentSessionCreated(
  spaceIdOrCallback: string | ((info: AgentSessionCreatedPayload) => void),
  maybeCallback?: (info: AgentSessionCreatedPayload) => void,
): () => void {
  const scopedSpaceId = typeof spaceIdOrCallback === 'string'
    ? normalizePtySubscriptionScopeId(spaceIdOrCallback)
    : undefined
  const callback = typeof spaceIdOrCallback === 'function'
    ? spaceIdOrCallback
    : maybeCallback

  if (!callback) return () => {}

  const subscriptionKey = retainPtySubscription('agent-session-created', scopedSpaceId)
  const listener = (_event: any, info: AgentSessionCreatedPayload) => {
    if (scopedSpaceId && info.spaceId !== scopedSpaceId) {
      return
    }
    callback(info)
  }
  ipcRenderer.on('pty:agent-session-created', listener)

  return () => {
    ipcRenderer.removeListener('pty:agent-session-created', listener)
    releasePtySubscription('agent-session-created', subscriptionKey)
  }
}

function ptyOnAgentSessionClosed(
  callback: (info: {
    sessionId: string
    spaceId?: string
    reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout'
  }) => void,
): () => void
function ptyOnAgentSessionClosed(
  spaceId: string,
  callback: (info: {
    sessionId: string
    spaceId?: string
    reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout'
  }) => void,
): () => void
function ptyOnAgentSessionClosed(
  spaceIdOrCallback:
    | string
    | ((info: {
      sessionId: string
      spaceId?: string
      reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout'
    }) => void),
  maybeCallback?: (info: {
    sessionId: string
    spaceId?: string
    reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout'
  }) => void,
): () => void {
  const scopedSpaceId = typeof spaceIdOrCallback === 'string'
    ? normalizePtySubscriptionScopeId(spaceIdOrCallback)
    : undefined
  const callback = typeof spaceIdOrCallback === 'function'
    ? spaceIdOrCallback
    : maybeCallback

  if (!callback) return () => {}

  const subscriptionKey = retainPtySubscription('agent-session-closed', scopedSpaceId)
  const listener = (_event: any, info: {
    sessionId: string
    spaceId?: string
    reason?: 'exit' | 'kill' | 'cleanup' | 'idle_timeout'
  }) => {
    if (scopedSpaceId && info.spaceId !== scopedSpaceId) {
      return
    }
    callback(info)
  }
  ipcRenderer.on('pty:agent-session-closed', listener)

  return () => {
    ipcRenderer.removeListener('pty:agent-session-closed', listener)
    releasePtySubscription('agent-session-closed', subscriptionKey)
  }
}

// P1-H (WP2)：ptyOnAgentSessionTitle 已退役（agent-bridge.ts L168-174 硬契约
// — D3 决策每次命令独立 session 后标题在 created 时一次定死）。

function ptyOnAutoRespondTriggered(
  callback: (info: {
    sessionId: string
    spaceId?: string | null
    pattern: string
    responseLength: number
    timestamp: number
  }) => void,
): () => void
function ptyOnAutoRespondTriggered(
  spaceId: string,
  callback: (info: {
    sessionId: string
    spaceId?: string | null
    pattern: string
    responseLength: number
    timestamp: number
  }) => void,
): () => void
function ptyOnAutoRespondTriggered(
  spaceIdOrCallback:
    | string
    | ((info: {
      sessionId: string
      spaceId?: string | null
      pattern: string
      responseLength: number
      timestamp: number
    }) => void),
  maybeCallback?: (info: {
    sessionId: string
    spaceId?: string | null
    pattern: string
    responseLength: number
    timestamp: number
  }) => void,
): () => void {
  const scopedSpaceId = typeof spaceIdOrCallback === 'string'
    ? normalizePtySubscriptionScopeId(spaceIdOrCallback)
    : undefined
  const callback = typeof spaceIdOrCallback === 'function'
    ? spaceIdOrCallback
    : maybeCallback

  if (!callback) return () => {}

  const subscriptionKey = retainPtySubscription('auto-respond-triggered', scopedSpaceId)
  const listener = (_event: any, info: {
    sessionId: string
    spaceId?: string | null
    pattern: string
    responseLength: number
    timestamp: number
  }) => {
    if (scopedSpaceId && info.spaceId !== scopedSpaceId) {
      return
    }
    callback(info)
  }
  ipcRenderer.on('pty:auto-respond-triggered', listener)

  return () => {
    ipcRenderer.removeListener('pty:auto-respond-triggered', listener)
    releasePtySubscription('auto-respond-triggered', subscriptionKey)
  }
}

// 实现 API（类型由下方 `satisfies` + `typeof` 推导，无需手工同步接口声明）
const api = {
  ping: () => invokeIpc('ping'),
  getHostname: () => invokeIpc('system:getHostname'),
  getPlatform: () => process.platform,
  getArch: () => process.arch,
  getLocalNetworkAddresses: () =>
    invokeIpc<LocalNetworkAddress[]>('system:get-local-network-addresses'),

  // 自绘窗口控件 — 见 TabTinAPIShape.windowControls 说明
  windowControls: {
    minimize: () => sendIpc('window:minimize'),
    toggleMaximize: () => sendIpc('window:toggleMaximize'),
    close: () => sendIpc('window:close'),
    isMaximized: () => invokeIpc<boolean>('window:isMaximized'),
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => {
      const handler = (_event: unknown, isMaximized: boolean) => callback(Boolean(isMaximized))
      ipcRenderer.on('window:maximize-changed', handler)
      return () => { ipcRenderer.removeListener('window:maximize-changed', handler) }
    },
    isFullScreen: () => invokeIpc<boolean>('window:isFullScreen'),
    onFullScreenChange: (callback: (isFullScreen: boolean) => void) => {
      const handler = (_event: unknown, isFullScreen: boolean) => callback(Boolean(isFullScreen))
      ipcRenderer.on('window:fullscreen-changed', handler)
      return () => { ipcRenderer.removeListener('window:fullscreen-changed', handler) }
    },
  },

  // API代理
  apiRequest: async (options) => {
    return await invokeIpc<ApiProxyResponse>('api:request', options)
  },

  // 认证管理
  auth: {
    save: (accessToken: string | null, refreshToken: string | null, userInfo: any, expiresAt?: number | null) =>
      invokeIpc('auth:save', accessToken, refreshToken, userInfo, expiresAt ?? null),
    get: async () => {
      const result = await invokeIpc<AuthGetLegacyResult>('auth:get')
      return unwrapAuthGetResult(result)
    },
    // load 方法：包装 get 方法，返回格式化的认证数据。
    // auth:get 在 LEGACY_HANDLERS 内 → invokeIpc 透传 main 端原 legacy
    // 形态 `{ success, data?, error? }`；显式给泛型让 result.success
    // 等访问能 typecheck（unknown 默认会报 TS18046）。
    load: async (): Promise<AuthLoadResult | null> => {
      try {
        const result = await invokeIpc<AuthGetLegacyResult>('auth:get')
        const data = unwrapAuthGetResult(result)
        if (data) {
          // 将 data 中的字段映射到 useAuthStore 期望的格式
          return {
            accessToken: data.accessToken || null,
            refreshToken: data.refreshToken || null,
            user: data.userInfo || null, // 注意：这里是 userInfo 映射到 user
          }
        }
        return null
      } catch (error) {
        console.error('加载认证信息失败:', error)
        return null
      }
    },
    clear: () => invokeIpc('auth:clear'),
    clearTokens: () => invokeIpc('auth:clearTokens'),
    clearUserInfo: () => invokeIpc('auth:clearUserInfo'),
    check: () => invokeIpc('auth:check'),
    saveAccessToken: (token: string) => invokeIpc('auth:saveAccessToken', token),
    // ER-9: in-flight Promise dedup + 500ms TTL cache。renderer 端多个 caller
    // 在启动 burst 期间并发拿 token 不再各打一次 IPC。语义对调用方完全等价。
    // 实现见 auth-token-dedup.ts。
    getAccessToken: () => getAccessTokenDeduped(),
    saveRefreshToken: (token: string) => invokeIpc('auth:saveRefreshToken', token),
    refreshAccessToken: async () => {
      const result = await invokeIpc<AuthRefreshLegacyResult>('auth:refreshAccessToken')
      return unwrapAuthRefreshResult(result)
    },
    saveUserInfo: (userInfo: any) => invokeIpc('auth:saveUserInfo', userInfo),
    getUserInfo: () => invokeIpc('auth:getUserInfo'),
    isTokenExpiringSoon: (bufferMinutes: number = 5) =>
      invokeIpc('auth:isTokenExpiringSoon', bufferMinutes),
    onForceLogout: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('auth:force-logout', handler)
      return () => { ipcRenderer.removeListener('auth:force-logout', handler) }
    },
    onTokenRefreshed: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('auth:token-refreshed-signal', handler)
      return () => { ipcRenderer.removeListener('auth:token-refreshed-signal', handler) }
    },
  },

  openaiCodex: {
    getStatus: () => invokeIpc<{
      connected: boolean
      expiresAt?: number
      models: Array<{ id: string; displayName: string }>
    }>('openai-codex:get-status'),
    loginBrowser: () => invokeIpc<{ started: true }>('openai-codex:login-browser'),
    loginDeviceCode: () => invokeIpc<{ userCode: string; verificationUri: string }>(
      'openai-codex:login-device-code',
    ),
    logout: () => invokeIpc<{ loggedOut: true }>('openai-codex:logout'),
    cancelLogin: () => invokeIpc<{ cancelled: true }>('openai-codex:cancel-login'),
    onStatusChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { status: 'connected' | 'disconnected' },
      ) => {
        callback(payload)
      }
      ipcRenderer.on('openai-codex:status-changed', handler)
      return () => {
        ipcRenderer.removeListener('openai-codex:status-changed', handler)
      }
    },
  },

  oss: {
    getPresignedObject: (payload) => invokeIpc<OssGetPresignedObjectResult>(
      OSS_GET_PRESIGNED_OBJECT_CHANNEL,
      payload,
    ),
    cancelPresignedDownload: (requestId) => invokeIpc<{ cancelled: boolean }>(
      OSS_CANCEL_PRESIGNED_DOWNLOAD_CHANNEL,
      requestId,
    ),
    putPresignedObject: async (payload, onProgress) => {
      const handler = (_event: unknown, progress: OssPutPresignedObjectProgress) => {
        if (progress?.uploadId === payload.uploadId) {
          onProgress?.(progress)
        }
      }

      if (onProgress) {
        ipcRenderer.on(OSS_PUT_PRESIGNED_OBJECT_PROGRESS_CHANNEL, handler)
      }

      try {
        return await invokeIpc<OssPutPresignedObjectResult>(
          OSS_PUT_PRESIGNED_OBJECT_CHANNEL,
          payload,
        )
      } finally {
        if (onProgress) {
          ipcRenderer.removeListener(OSS_PUT_PRESIGNED_OBJECT_PROGRESS_CHANNEL, handler)
        }
      }
    },
    cancelPresignedObject: (uploadId) =>
      invokeIpc<{ cancelled: boolean }>(OSS_CANCEL_PRESIGNED_OBJECT_CHANNEL, uploadId),
  },

  // 组织管理
  organization: {
    getLocalConfig: (organizationId: string) => invokeIpc('organization:getLocalConfig', organizationId),
    saveLocalConfig: (organizationId: string, config: any) => invokeIpc('organization:saveLocalConfig', organizationId, config),
    clearLocalCache: (organizationId?: string) => invokeIpc('organization:clearLocalCache', organizationId),
  },

  // 文件系统
  showSaveDialog: (options) => invokeIpc('dialog:showSave', options),
  showOpenDialog: (options) => invokeIpc('dialog:showOpen', options),
  openExternal: (url: string) => invokeIpc('shell:openExternal', url),
  openPath: (targetPath: string) => invokeIpc('shell:openPath', targetPath),
  showItemInFolder: (targetPath: string) => invokeIpc('shell:showItemInFolder', targetPath),
  clipboard: {
    writeImage: (bytes) => invokeIpc('clipboard:writeImage', bytes),
    writeFile: (targetPath) => invokeIpc('clipboard:writeFile', targetPath),
  },
  fileSystem: {
    pathExists: (targetPath: string) => invokeIpc('fs:pathExists', targetPath),
    realpath: (targetPath: string) => invokeIpc('fs:realpath', targetPath),
    readDir: (dirPath: string) => invokeIpc('fs:readDir', dirPath),
    readFilePreview: (filePath: string, options?: { maxBytes?: number }) =>
      invokeIpc('fs:readFilePreview', filePath, options),
    renderOfficePreview: (filePath: string) =>
      invokeIpc('fs:renderOfficePreview', filePath),
    renderOfficePreviewData: (input: { fileName: string; data: ArrayBuffer | Uint8Array }) =>
      invokeIpc('fs:renderOfficePreviewData', input),
    readBinaryFile: (filePath: string) =>
      invokeIpc('fs:readBinaryFile', filePath),
    writeFile: (filePath: string, content: string) =>
      invokeIpc('fs:writeFile', filePath, content),
    writeBinaryFile: (filePath: string, base64Data: string) =>
      invokeIpc('fs:writeBinaryFile', filePath, base64Data),
    createDir: (dirPath: string) => invokeIpc('fs:createDir', dirPath),
    rename: (oldPath: string, newPath: string) => invokeIpc('fs:rename', oldPath, newPath),
    deleteFile: (filePath: string) => invokeIpc('fs:deleteFile', filePath),
    deleteDir: (dirPath: string) => invokeIpc('fs:deleteDir', dirPath),
    ensureSpaceSandbox: (spaceId: string, organizationId?: string) => invokeIpc('fs:ensureSpaceSandbox', spaceId, organizationId),
    ensureDefaultAgentDir: (input: string | { agentName?: string | null; spaceName?: string | null; organizationName?: string | null }) =>
      invokeIpc('fs:ensureDefaultAgentDir', input),
    lookupSpaceSandbox: (spaceId: string, organizationId?: string) => invokeIpc('fs:lookupSpaceSandbox', spaceId, organizationId),
    watch: (dirPath: string, options?: { recursive?: boolean }) => invokeIpc('fs:watch', dirPath, options),
    unwatch: (watchId: string) => invokeIpc('fs:unwatch', watchId),
    computeSkillContentHash: (skillDir: string) => invokeIpc('fs:computeSkillContentHash', skillDir),
    ripgrepSearch: (options: RipgrepSearchOptions) =>
      invokeIpc('fs:ripgrepSearch', options),
    ripgrepSearchCancel: (requestId: string) =>
      invokeIpc('fs:ripgrepSearchCancel', requestId),
    replaceInFiles: (input: ReplaceInFilesRequest) =>
      invokeIpc('fs:replaceInFiles', input),
    onWatchEvent: (callback) => {
      const handler = (_event: unknown, payload: any) => {
        callback(payload)
      }
      ipcRenderer.on('fs:watch-event', handler)
      return () => ipcRenderer.removeListener('fs:watch-event', handler)
    }
  },

  // 💻 Git 操作 API（TabCode 用）
  git: {
    isGitRepo: (cwd: string) => invokeIpc('git:isRepo', cwd),
    getBranch: (cwd: string) => invokeIpc('git:branch', cwd),
    getBranchMeta: (cwd: string) => invokeIpc('git:branchMeta', cwd),
    listBranches: (cwd: string) => invokeIpc('git:branches', cwd),
    checkoutBranch: (cwd: string, options: { branch: string; create?: boolean; startPoint?: string; allowDirty?: boolean }) =>
      invokeIpc('git:checkout', cwd, options),
    getStatus: (cwd: string) => invokeIpc('git:status', cwd),
    getDiffStat: (cwd: string) => invokeIpc('git:diffStat', cwd),
    getFileAtHead: (cwd: string, filePath: string) => invokeIpc('git:showFile', cwd, filePath),
    getFileAtStaged: (cwd: string, filePath: string) => invokeIpc('git:showStaged', cwd, filePath),
    getFileAtCommit: (
      cwd: string,
      options: { filePath: string; commitHash: string; parent?: boolean },
    ) => invokeIpc('git:showAtCommit', cwd, options),
    rawDiff: (cwd: string, extraArgs?: string[]) => invokeIpc('git:rawDiff', cwd, extraArgs),
    stageFiles: (cwd: string, paths?: string[]) => invokeIpc('git:stage', cwd, paths),
    unstageFiles: (cwd: string, paths?: string[]) => invokeIpc('git:unstage', cwd, paths),
    commit: (cwd: string, message: string) => invokeIpc('git:commit', cwd, message),
    push: (cwd: string, options?: {
      remote?: string
      branch?: string
      setUpstream?: boolean
      allowDirty?: boolean
      allowBehind?: boolean
      allowNoAhead?: boolean
    }) =>
      invokeIpc('git:push', cwd, options),
    listRemotes: (cwd: string) => invokeIpc('git:remotes', cwd),
    getPullRequestUrl: (cwd: string, options?: { remote?: string; baseBranch?: string; headBranch?: string }) =>
      invokeIpc('git:pullRequestUrl', cwd, options),
    createPullRequest: (cwd: string, options?: {
      remote?: string
      baseBranch?: string
      headBranch?: string
      title?: string
      body?: string
      draft?: boolean
    }) =>
      invokeIpc('git:createPullRequest', cwd, options),
    listWorktrees: (cwd: string) => invokeIpc('git:worktrees', cwd),
    createWorktree: (cwd: string, options: { path: string; branch?: string; createBranch?: boolean; baseBranch?: string }) =>
      invokeIpc('git:worktreeCreate', cwd, options),
    preflightRemoveWorktree: (cwd: string, options: { path: string }) =>
      invokeIpc('git:worktreeRemovePreflight', cwd, options),
    removeWorktree: (cwd: string, options: { path: string; force?: boolean; assessmentToken?: string }) =>
      invokeIpc('git:worktreeRemove', cwd, options),
    mergeWorktree: (cwd: string, options: {
      sourceWorktreePath: string
      targetBranch: string
      deleteAfterMerge?: boolean
      deleteSourceBranch?: boolean
    }) =>
      invokeIpc('git:worktreeMerge', cwd, options),
    pull: (cwd: string, options?: { remote?: string; branch?: string; rebase?: boolean }) =>
      invokeIpc('git:pull', cwd, options),
    fetch: (cwd: string, options?: { remote?: string; prune?: boolean }) =>
      invokeIpc('git:fetch', cwd, options),
    stash: (cwd: string, action: string, options?: { message?: string; includeUntracked?: boolean; index?: number }) =>
      invokeIpc('git:stash', cwd, action, options),
    discardFiles: (cwd: string, paths: string[]) =>
      invokeIpc('git:discardFiles', cwd, paths),
    fullStatus: (cwd: string) =>
      invokeIpc('git:fullStatus', cwd),
    listCommits: (cwd: string, options?: { limit?: number; graph?: boolean }) =>
      invokeIpc('git:log', cwd, options),
    getCommitDetail: (cwd: string, options: { commitHash: string }) =>
      invokeIpc('git:commitDetail', cwd, options),
  },

  // Checkpoint 检查点系统 API 实现
  checkpoint: createCheckpointApi(),

  // Per-file 回退 API 实现
  fileHistory: createFileHistoryApi(),
  fileEditPatches: createFileEditPatchesApi(),

  // 🆕 Chat 相关 API 实现
  chat: {
    // PlatformSurface: 导出对话为 Markdown（Wave 3 PoC，走 envelope 不走 LEGACY）
    exportMd: (params: { sessionId: string }) => invokeIpc<{ markdown: string; messageCount: number }>('chat:export-md', params),
  },

  im: {
    openDetached: () => invokeIpc<{ opened: true }>('im:openDetached'),
    syncOrganization: (payload) => sendIpc('im:syncOrganization', payload),
    onOrganizationSynced: (callback) => {
      const listener = (_event: any, payload: { organizationId: string }) => callback(payload)
      ipcRenderer.on('im:organizationSynced', listener)
      return () => {
        ipcRenderer.removeListener('im:organizationSynced', listener)
      }
    },
  },

  // 设备标识
  getDeviceFingerprint: () => invokeIpc('device:getFingerprint'),
  getDeviceIdentity: () => invokeIpc('device:getIdentity'),
  ensureDeviceRegistered: (organizationId: string) =>
    invokeIpc('device:ensureRegistered', { organizationId }),

  // Space 上下文
  space: {
    setActive: (spaceId: string | null, crawlspaceId?: string | null, organizationId?: string | null, organizationRoot?: string | null) =>
      invokeIpc('space:setActive', { spaceId, crawlspaceId, organizationId, organizationRoot }),
  },

  // TabDesktop 授权管理（Wave 2 · 规范 § 6.3 / § 6.4）
  desktop: {
    /** 设置面板查询当前授权状态（granted / grantedAt / remainingMs / reason） */
    getApprovalStatus: () => invokeIpc('desktop:getApprovalStatus'),
    /** 设置面板撤销"总是允许"授权，下次 screenshot 重新弹审批 */
    revokeApproval: () => invokeIpc('desktop:revokeApproval'),
    // PD-11（W6 M3）：原 CLI auth preset 推送 IPC 已删除 —— CLI client 不再压低 Space yolo。
    /**
     * Space 切换时推送当前 device_permissions 到主进程（Wave 2.1 · 规范 § 6.5）。
     * 主进程缓存后 `/desktop/*` 路由在入口读 `desktop_observe`，block 则直接拒绝。
     */
    setDevicePermissions: (perms: Record<string, string> | null) =>
      invokeIpc('desktop:setDevicePermissions', { perms }),
  },

  // OS 系统权限管理（macOS TCC / Windows 应用权限）
  // 与上面 desktop:* 业务授权正交：这里只描述 OS 给 App 的能力。
  osPermissions: {
    list: () => invokeIpc('osPermissions:list'),
    check: (kind: string) => invokeIpc('osPermissions:check', kind),
    request: (kind: string) => invokeIpc('osPermissions:request', kind),
    openSettings: (kind: string) => invokeIpc('osPermissions:openSettings', kind),
  },

  // 窗口外观（ 回传 shouldUseDarkColors）
  setAppearance: (appearance: 'light' | 'dark' | 'system') => invokeIpc('window:setAppearance', appearance),
  getAppearance: () => invokeIpc('window:getAppearance'),
  onNativeThemeUpdated: (callback) => {
    const handler = (
      _event: unknown,
      payload: {
        appearance: 'light' | 'dark' | 'system'
        themeSource: 'system' | 'light' | 'dark'
        shouldUseDarkColors: boolean
        shouldUseDarkColorsForSystemIntegratedUI: boolean | null
      },
    ) => {
      callback(payload)
    }
    ipcRenderer.on('appearance:native-theme-updated', handler)
    return () => {
      ipcRenderer.removeListener('appearance:native-theme-updated', handler)
    }
  },

  // 放映全屏控制（利用 Electron setFullScreen 实现真全屏）
  slideshow: {
    enterFullscreen: () => invokeIpc('slideshow:enterFullscreen'),
    exitFullscreen: () => invokeIpc('slideshow:exitFullscreen'),
  },

  // TabSlide 自动保存 — 关闭保护
  slide: {
    onFlushBeforeClose: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('slide:flush-before-close', handler)
      return () => { ipcRenderer.removeListener('slide:flush-before-close', handler) }
    },
    flushComplete: () => sendIpc('slide:flush-complete'),
  },

  exitGuard: {
    onRequest: (
      callback: (payload: { reason: 'app-quit' | 'window-close'; requestId: string }) => void,
    ) => {
      const handler = (
        _event: unknown,
        payload: { reason: 'app-quit' | 'window-close'; requestId: string },
      ) => callback(payload)
      ipcRenderer.on('app:exit-guard:request', handler)
      return () => { ipcRenderer.removeListener('app:exit-guard:request', handler) }
    },
    sendResponse: (payload: { requestId: string; choice: 'continue' | 'cancel' }) => {
      sendIpc('app:exit-guard:response', payload)
    },
  },

  // Run / Session 管理（为 Agent 提供上下文与事件）
  runSession: {
    create: (runId?: string, sessionId?: string) => invokeIpc('run-session:create', runId, sessionId),
    get: (runId: string) => invokeIpc('run-session:get', runId),
    //  Phase 3：webview 容器 keepalive 判定——该 view 是否有进行中的 Agent run
    hasActiveRunForView: (viewId: string) => invokeIpc('run-session:hasActiveRunForView', viewId),
    registerView: (runId: string, viewInfo: { viewId: string; profile?: string; partition?: string; userAgent?: string; proxy?: any; metadata?: Record<string, any> }) =>
      invokeIpc('run-session:registerView', runId, viewInfo),
    setActiveView: (runId: string, viewId?: string | null) => invokeIpc('run-session:setActiveView', runId, viewId),
    addEvent: (payload: { runId?: string; viewId?: string; type: string; data?: any; timestamp?: number }) =>
      invokeIpc('run-session:addEvent', payload),
    openTab: (payload: { runId?: string; id?: string; url?: string; profile?: string; partition?: string; userAgent?: string; proxy?: any; metadata?: Record<string, any> }) =>
      invokeIpc('run-session:openTab', payload),
    switchTab: (payload: { runId?: string; viewId: string; bounds?: any }) =>
      invokeIpc('run-session:switchTab', payload),
    closeTab: (payload: { runId?: string; viewId: string; force?: boolean }) =>
      invokeIpc('run-session:closeTab', payload),
    endRun: (runId: string, options?: { destroyViews?: boolean; reason?: string }) =>
      invokeIpc('run-session:endRun', runId, options),
  },

  // ========== 🆕 爬虫模块 API 实现 ==========

  // 🆕 嵌入式爬虫视图
  crawlView: {
    // 兼容签名：
    // - show(url, bounds)
    // - show(tabId, url, bounds, runId?)
    // - show(tabId, url, bounds, runId?, options?)
    show: (urlOrTabId, boundsOrUrl, maybeBounds, runId, options) => {
      const validated = assertCrawlViewOptions(options, 'show')
      return invokeIpc('crawl-view:show', urlOrTabId, boundsOrUrl, maybeBounds, runId, validated)
    },
    hide: (tabId) => invokeIpc('crawl-view:hide', tabId),
    setViewBounds: (tabId, bounds) => invokeIpc('crawl-view:setViewBounds', tabId, bounds),
    setIgnoreMouseEventsForAttached: (ignore: boolean) =>
      invokeIpc('crawl-view:setIgnoreMouseEventsForAttached', ignore),
    destroyTabView: (tabId) => invokeIpc('crawl-view:destroyTabView', tabId),
    hasView: (tabId) => invokeIpc('crawl-view:hasView', tabId),
    touch: (tabId, reason) => invokeIpc('crawl-view:touch', tabId, reason),
    // 🆕 Renderer 重载兜底：清理孤儿 View/Run（仅清理非用户视图/工作区相关资源）
    reconcileOrphans: (payload: { knownTabIds?: string[]; knownViewIds?: string[]; knownWorkspaceIds?: string[]; reason?: string }) =>
      invokeIpc('crawl-view:reconcileOrphans', payload),
    getCacheStats: () => invokeIpc('crawl-view:getCacheStats'),
    cleanupCache: () => invokeIpc('crawl-view:cleanupCache'),

    // 🆕 导航控制
    goBack: (tabId?: string) => invokeIpc('crawl-view:goBack', tabId),
    goForward: (tabId?: string) => invokeIpc('crawl-view:goForward', tabId),
    reload: (ignoreCache = false, tabId?: string) =>
      invokeIpc('crawl-view:reload', ignoreCache, tabId),
    stop: (tabId?: string) => invokeIpc('crawl-view:stop', tabId),
    getNavigationState: (tabId?: string) => invokeIpc('crawl-view:getNavigationState', tabId),
    loadUrl: (tabId: string, url: string, options?: any) =>
      invokeIpc('crawl-view:loadUrl', tabId, url, options),
    waitForSelector: (tabId: string, options: any) =>
      invokeIpc('crawl-view:waitForSelector', tabId, options),

    // 🆕 页面读取（Phase 3）
    getHTML: (tabId?: string, url?: string, runId?: string, options?: any) => {
      const validated = assertCrawlViewOptions(options, 'getHTML')
      return invokeIpc('crawl-view:getHTML', tabId, url, runId, validated)
    },
    getPageInfo: (tabId?: string, url?: string, runId?: string, options?: any) => {
      const validated = assertCrawlViewOptions(options, 'getPageInfo')
      return invokeIpc('crawl-view:getPageInfo', tabId, url, runId, validated)
    },

    onEvent: (callback) => {
      const listener = (_event: any, data: any) => callback(data)
      ipcRenderer.on('crawl-view:event', listener)
      return () => {
        ipcRenderer.removeListener('crawl-view:event', listener)
      }
    },
    onCrashRecovered: (callback: (payload: { viewId: string; reason: string; url: string }) => void) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('crawl-view:crash-recovered', handler)
      return () => { ipcRenderer.removeListener('crawl-view:crash-recovered', handler) }
    },
    /**
     * 监听"主进程因 env 绑定变更主动重建 workspace view"事件。
     *
     * 触发条件：用户改 Space → BrowserEnvironment 绑定时，已打开的 workspace
     * tab 的 partition 与新绑定不一致 → 主进程销毁旧 view + 用新 partition 重建。
     * Renderer 收到此事件后弹一条友好 toast 让用户知道"环境刚切了"。
     */
    onPartitionRebuilt: (callback: (payload: { tabId: string; oldPartition: string; newPartition: string; reason: string }) => void) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('crawl-view:partition-rebuilt', handler)
      return () => { ipcRenderer.removeListener('crawl-view:partition-rebuilt', handler) }
    },
    /**
     * 监听"partition 重建锁释放"事件（Wave 3 B2 收敛）。
     *
     * 见 ipc-handlers.ts: 用户连续切 env 时被锁挡住的 show 不会原地重建；
     * 锁释放时广播实际 partition，让 EmbeddedCrawlView 比对 store 决定是否
     * 再发一次 show 触发新一轮重建。
     */
    onPartitionRebuildReleased: (callback: (payload: { tabId: string; actualPartition: string }) => void) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('crawl-view:partition-rebuild-released', handler)
      return () => { ipcRenderer.removeListener('crawl-view:partition-rebuild-released', handler) }
    },

    // 🆕 内容操作（Phase 2）
    // ✅ 修复时序问题：支持传递 URL 参数
    executeScript: (script, tabId, url, options) => {
      const validated = assertCrawlViewOptions(options, 'executeScript')
      return invokeIpc('crawl-view:executeScript', script, tabId, url, validated)
    },
    cancelAnnotation: (tabId) => invokeIpc('crawl-view:cancelAnnotation', tabId),
    getProcessedContent: (tabId, url, runId, options) => {
      const validated = assertCrawlViewOptions(options, 'getProcessedContent')
      return invokeIpc('crawl-view:getProcessedContent', tabId, url, runId, validated)
    },
    screenshot: (options, tabId, url, runId, viewOptions) => {
      const validated = assertCrawlViewOptions(viewOptions, 'screenshot')
      return invokeIpc('crawl-view:screenshot', options, tabId, url, runId, validated)
    },

    // 🆕 CDP 集成（Phase 3）
    getCDPEndpoint: () => invokeIpc('crawl-view:getCDPEndpoint'),
    getWebContentsId: () => invokeIpc('crawl-view:getWebContentsId'),

    // 🆕 页面内查找 (Find-in-Page)
    findInPage: (tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) =>
      invokeIpc('crawl-view:findInPage', tabId, text, options),
    stopFindInPage: (tabId: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') =>
      invokeIpc('crawl-view:stopFindInPage', tabId, action),
    onFoundInPage: (callback: (event: any, result: { viewId: string; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => {
      ipcRenderer.on('crawl-view:found-in-page', callback)
      return () => { ipcRenderer.removeListener('crawl-view:found-in-page', callback) }
    },

    // 🆕 缩放控制
    setZoomLevel: (tabId: string, level: number) =>
      invokeIpc('crawl-view:setZoomLevel', tabId, level),
    getZoomLevel: (tabId: string) =>
      invokeIpc('crawl-view:getZoomLevel', tabId),
    onZoomLevelChanged: (callback: (payload: BrowserZoomLevelChangedPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: BrowserZoomLevelChangedPayload) => callback(payload)
      ipcRenderer.on('crawl-view:zoom-level-changed', handler)
      return () => { ipcRenderer.removeListener('crawl-view:zoom-level-changed', handler) }
    },
    takeOverBrowser: (viewId: string) =>
      invokeIpc('browser-tab-control:take-over', viewId),
    handBackBrowser: (viewId: string) =>
      invokeIpc('browser-tab-control:hand-back', viewId),
    onAgentTabLockChanged: overlayOn<BrowserTabControlSnapshot>('browser-tab-lock:changed'),
  },

  // ========== 🆕 webview 容器（ webview 迁移 Phase 2） ==========

  browserContainer: {
    mode: parseBrowserContainerModeFromArgv(process.argv),
  },

  webviewHost: {
    announce: (tabId: string, options) =>
      invokeIpc('webview-host:announce', tabId, options),
    bind: (tabId: string, webContentsId: number) =>
      invokeIpc('webview-host:bind', tabId, webContentsId),
    navigate: (tabId: string, url: string, options?: { expectedPartition?: string }) =>
      invokeIpc('webview-host:navigate', tabId, url, options),
    discardAnnounce: (tabId: string) =>
      invokeIpc('webview-host:discard-announce', tabId),
    onGuestCrashed: (callback: (payload: { tabId: string; reason: string; url: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { tabId: string; reason: string; url: string }) => callback(payload)
      ipcRenderer.on('webview-host:guest-crashed', handler)
      return () => { ipcRenderer.removeListener('webview-host:guest-crashed', handler) }
    },
    onDestroyRequest: (callback: (payload: { tabId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { tabId: string }) => callback(payload)
      ipcRenderer.on('webview-host:destroy-request', handler)
      return () => { ipcRenderer.removeListener('webview-host:destroy-request', handler) }
    },
  },

  captcha: {
    onInterventionRequired: (callback: (payload: { tabId: string; captchaType: string; message: string }) => void) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('captcha:intervention-required', handler)
      return () => { ipcRenderer.removeListener('captcha:intervention-required', handler) }
    },
    resolveIntervention: (tabId: string) => {
      sendIpc('captcha:intervention-resolved', { tabId })
    },
  },

  // WebContentsView 管理
  webcontentsview: {
    getCDPEndpoint: (viewId: string) =>
      invokeIpc('webcontentsview:getCDPEndpoint', viewId),

    getView: (viewId: string) =>
      invokeIpc('webcontentsview:getView', viewId),

    getAllViews: () =>
      invokeIpc('webcontentsview:getAllViews'),

    openDevTools: (viewId: string) =>
      invokeIpc('webcontentsview:openDevTools', viewId),

    closeDevTools: (viewId: string) =>
      invokeIpc('webcontentsview:closeDevTools', viewId),

    // ✅ Phase 3: 已移除池化相关 API (acquire/release/getPoolStatus)
  },

  // 任务管理
  taskAPI: {
    create: (config) => invokeIpc('task:create', config),
    get: (taskId) => invokeIpc('task:get', taskId),
    query: (options) => invokeIpc('task:query', options),
    getAll: (filter) => invokeIpc('task:getAll', filter),
    update: (taskId, updates) => invokeIpc('task:update', taskId, updates),
    updateMetadata: (taskId, metadata) => invokeIpc('task:update-metadata', taskId, metadata),
    delete: (taskId) => invokeIpc('task:delete', taskId),
    getStatistics: () => invokeIpc('task:statistics'),
    cleanup: (olderThan) => invokeIpc('task:cleanup', olderThan),
    clear: () => invokeIpc('task:clear'),
    getStoreInfo: () => invokeIpc('task:storeInfo'),
    onStateChange: (callback) => {
      const listener = (_event: any, data: any) => {
        callback(data);
      };
      ipcRenderer.on('task:state:change', listener);
      return () => {
        ipcRenderer.removeListener('task:state:change', listener);
      };
    },
    // 生命周期操作
    enqueue: (taskId) => invokeIpc('task:enqueue', taskId),
    start: (taskId) => invokeIpc('task:start', taskId),
    pause: (taskId) => invokeIpc('task:pause', taskId),
    resume: (taskId) => invokeIpc('task:resume', taskId),
    resumeWithPagination: (params) => invokeIpc('task:resume-with-pagination', params),
    selectRecommendation: (params) => invokeIpc('task:select-recommendation', params),
    cancel: (taskId) => invokeIpc('task:cancel', taskId),
  },

  recommendationAPI: {
    getHistory: (params) => invokeIpc('recommendation:get-history', params),
    generate: (params) =>
      invokeIpc('recommendation:generate', {
        cleanHtml: params.cleanHtml,
        url: params.url,
        skeletonHtml: params.skeletonHtml,
        maxRecommendations: params.maxRecommendations,
        pageMeta: params.pageMeta
      }),
    recordUsage: (params) =>
      invokeIpc('recommendation:record-usage', {
        historyId: params.historyId,
        userId: params.userId
      })
  },

  // 🆕 Agent Tools API 实现
  agent: {
    executeAction: (action) => {
      console.log('🌉 [Preload] 桥接 IPC 调用: agent:execute-action', action)
      return invokeIpc('agent:execute-action', action)
    },
    getRegisteredTools: () => {
      return invokeIpc('agent:get-registered-tools')
    },
    hasToolForAction: (actionType) => {
      return invokeIpc('agent:has-tool-for-action', actionType)
    },
    bindSessionCodeRoot: (payload) => {
      return invokeIpc('agent:bind-session-code-root', payload)
    },
    getSessionCodeRoot: (payload) => {
      return invokeIpc('agent:get-session-code-root', payload)
    },
    clearSessionCodeRoot: (payload) => {
      return invokeIpc('agent:clear-session-code-root', payload)
    },
    listSessionCodeRoots: (payload) => {
      return invokeIpc('agent:list-session-code-roots', payload)
    },
    rehomeSessionCodeRoot: (payload) => {
      return invokeIpc('agent:rehome-session-code-root', payload)
    },
  },

  agentEngine: {
    query: (request: AgentEngineQueryRequest) => {
      validateAgentEngineQuery(request)
      return invokeIpc('agent-engine:query', request)
    },
    compactSession: (request: AgentEngineCompactSessionRequest) => {
      return invokeIpc('agent-engine:compact-session', request)
    },
    abort: (input?: { sessionId?: string }) => {
      return invokeIpc('agent-engine:abort', input ?? {})
    },
    getState: (input?: { sessionId?: string }) => {
      return invokeIpc('agent-engine:get-state', input ?? {})
    },
    //  对话回退（本地宿主）：截断 / 撤销本机 transcript 软标记。
    rollbackTranscript: (payload: {
      sessionId: string
      targetMessageId?: string
      targetRole?: 'user' | 'assistant'
      targetContent?: string
      targetOccurrenceIndex?: number
      mode?: 'rollback' | 'editAndResend'
      keepMessageCount?: number
      spaceId?: string
      organizationId?: string
    }) => invokeIpc('agent-engine:rollback-transcript', payload),
    rollbackSessionTimeline: (payload: {
      sessionId: string
      targetMessageId: string
      targetRole?: 'user' | 'assistant'
      targetContent?: string
      targetOccurrenceIndex?: number
      mode?: 'rollback' | 'editAndResend'
      keepMessageCount?: number
      rollbackReason?: string
      previewRevision?: string
      filePreviewRevision?: string
      fileRewindAnchorId?: string
      rollbackContractVersion?: number
      acknowledgedFilePreviewReason?: string
      safetySnapshotHash?: string
      spaceId?: string
      organizationId?: string
    }) => invokeIpc('agent-engine:rollback-session-timeline', payload),
    unrevertTranscript: (payload: { sessionId: string; spaceId?: string; organizationId?: string }) =>
      invokeIpc('agent-engine:unrevert-transcript', payload),
    onStreamEvent: (callback: (data: { sessionId: string; event: { type: string; payload: Record<string, unknown> } }) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('agent-engine:stream-event', handler)
      return () => { ipcRenderer.removeListener('agent-engine:stream-event', handler) }
    },
    // ：声明 / 撤销某 session 的 IPC stream 投递 target。后端 WS 观察
    // 只允许由主进程 agent-host 的执行路径显式开启。
    watchSession: (sessionId: string, options?: { shareId?: string }) => invokeIpc(
      'agent-engine:watch-session',
      { sessionId, ...(options?.shareId ? { shareId: options.shareId } : {}) },
    ),
    unwatchSession: (sessionId: string) => invokeIpc('agent-engine:unwatch-session', { sessionId }),
    registerProvisionalSession: (sessionId: string) =>
      invokeIpc('agent-engine:register-provisional-session', { sessionId }),
    beginProvisionalSessionClaim: (sessionId: string) =>
      invokeIpc('agent-engine:begin-provisional-session-claim', { sessionId }),
    completeProvisionalSessionClaim: (sessionId: string, accepted: boolean) =>
      invokeIpc('agent-engine:complete-provisional-session-claim', { sessionId, accepted }),
    beginProvisionalSessionDiscard: (sessionId: string) =>
      invokeIpc('agent-engine:begin-provisional-session-discard', { sessionId }),
    completeProvisionalSessionDiscard: (sessionId: string, deleted: boolean) =>
      invokeIpc('agent-engine:complete-provisional-session-discard', { sessionId, deleted }),
    // ：出站遥控发送（chat.send_message 等）经主进程 WS 网关执行，回传 GatewayResponse。
    gatewaySend: (payload: { messageType: string; payload: Record<string, unknown>; requestOptions?: Record<string, unknown> }) =>
      invokeIpc('agent-engine:gateway-send', payload),
    // ：出站 abort——本机 IPC 快路径 + 后端 chat.cancel 兜底一次收口，回传 AbortRunResult。
    abortRun: (sessionId: string) => invokeIpc('agent-engine:abort-run', { sessionId }),
    promoteRun: (payload: { sessionId: string; runId: string }) =>
      invokeIpc('agent-engine:promote-run', payload),
    cancelQueuedRun: (payload: { sessionId: string; runId: string }) =>
      invokeIpc('agent-engine:cancel-queued-run', payload),
    // ：撤回未答轮次——经主进程 runtime，不经 renderer→Django。
    withdrawUnansweredTurn: (payload: {
      sessionId: string
      clientMessageId: string
      localMessageId?: string
      targetContent?: string
      spaceId?: string
      organizationId?: string
    }) => invokeIpc('agent-engine:withdraw-unanswered-turn', payload),
    onApprovalMemoChanged: (callback: (data: { workspaceId: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('agent-engine:approval-memo-changed', handler)
      return () => { ipcRenderer.removeListener('agent-engine:approval-memo-changed', handler) }
    },
    onSessionCodeRootChanged: (callback: (data: SessionCodeRootChangedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: SessionCodeRootChangedEvent) => {
        callback(data)
      }
      ipcRenderer.on(SESSION_CODE_ROOT_CHANGED_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(SESSION_CODE_ROOT_CHANGED_CHANNEL, handler)
      }
    },
    submitHitlBatch: (
      batchId: string,
      decisions: Array<{
        request_id?: string
        tool_call_id: string
        outcome: 'allow' | 'deny' | 'cancelled' | 'expired'
        scope?: 'once' | 'thread' | 'always'
        rejection_message?: string
      }>,
      threadId?: string,
    ) => {
      return invokeIpc('agent-engine:submit-hitl-batch', { batchId, decisions, threadId })
    },
    submitAskUserResponse: (requestId: string, response: unknown, threadId?: string) => {
      return invokeIpc('agent-engine:submit-ask-user-response', { requestId, response, threadId })
    },
    // cancel-hitl IPC 绑定——语义 / 与 skipped 的区别见 API 表面注释与
    // ElectronAgentHost.handleCancelHitlInteraction docstring。
    cancelHitlInteraction: (payload: {
      kind: 'approval' | 'ask'
      requestKey: string
      reason?: string
    }) => {
      return invokeIpc('agent-engine:cancel-hitl-interaction', payload)
    },
    executeModeSwitch: (payload: {
      sessionId: string
      proposalId: string
      outcome: 'approved' | 'cancelled'
    }) => {
      validateModeSwitchExecutePayload(payload)
      return invokeIpc('agent-engine:mode-switch-execute', payload)
    },
    notifyModeSwitched: (payload: {
      sessionId: string
      fromMode?: string
      toMode: string
    }) => {
      validateNotifyModeSwitchedPayload(payload)
      return invokeIpc('agent-engine:notify-mode-switched', payload)
    },
    notifyApprovalModeChanged: (payload: {
      sessionId: string
      approvalMode: string
    }) => {
      validateNotifyApprovalModeChangedPayload(payload)
      return invokeIpc('agent-engine:notify-approval-mode-changed', payload)
    },
    invalidateAgentConfigCache: (payload?: {
      agentId?: string
      workspaceId?: string
    }) => {
      validateInvalidateAgentConfigCachePayload(payload)
      return invokeIpc('agent-engine:invalidate-agent-config-cache', payload ?? {})
    },
    upsertHostTurnState: (payload: {
      agent?: {
        id: string
        detail?: Record<string, unknown>
        display_name?: string | null
        name?: string | null
        custom_rules?: string | null
        personal_rules?: string | null
        agent_config?: unknown
        organization_allow_member_yolo?: boolean | null
      }
      workspace?: {
        id: string
        custom_rules?: string | null
        execution_limits?: {
          max_iterations_per_run?: number | null
          max_credits_per_run?: number | string | null
          enabled?: boolean | null
        } | null
        approval_grant?: 'always_ask' | 'auto' | 'full_access' | null
      }
    }) => {
      validateUpsertHostTurnStatePayload(payload)
      return invokeIpc('agent-engine:upsert-host-turn-state', payload)
    },
    refreshApprovalMemo: (payload?: { workspaceId?: string }) => {
      return invokeIpc('agent-engine:refresh-approval-memo', payload ?? {})
    },
    cancelSubagent: (input: string | { childId: string; sessionId?: string }) => {
      return invokeIpc('agent-engine:cancel-subagent', input)
    },
    listRunningBackgroundTasks: (input: { sessionId: string; spaceId?: string }) => {
      return invokeIpc<Array<{ sessionId: string; command: string; startedAt: number }>>(
        'agent-engine:list-running-background-tasks',
        input,
      )
    },
    retryTool: (sessionId: string, toolName: string, args: Record<string, unknown>) => {
      return invokeIpc('agent-engine:retry-tool', { sessionId, toolName, args })
    },
    updateContext: (sessionId: string, appContext: { appType?: string | null; appMeta?: Record<string, unknown> | null; openTabs?: Array<{ type: string; id?: string; title?: string; active?: boolean; group_id?: string; app_key?: string; display_name?: string; is_home?: boolean; app_home?: string; path?: string; kind?: string; url?: string; session_id?: string }> | null; spaceId?: string | null }) => {
      return invokeIpc('agent-engine:update-context', { sessionId, appContext })
    },
    /**
     * LH2-D2：登出 / 切账号时由 renderer 调用，清主进程对应账号的 sync 目录
     * 与正在运行的 SyncQueue。**严格按 owner 匹配**——只动当前账号的桶。
     *
     * 入参：当前登录账号的 userId / organizationId（renderer 在 logout flow
     * 拥有这两个值；agentId 不参与目录粒度判断，所以这里不收）。
     */
    resetAccountSync: (payload: { userId: string; organizationId: string }) => {
      return invokeIpc('agent-engine:reset-account-sync', payload)
    },
    initCapabilityIdentity: (payload?: {
      reason?: 'login' | 'logout' | 'auth-changed' | 'organization-switch' | 'manual'
      organizationId?: string | null
    }) => {
      return invokeIpc('agent-engine:init-capability-identity', payload)
    },
    checkPending: (threadId: string) => {
      return invokeIpc('agent-engine:check-pending', { threadId })
    },
    onProactiveReport: (callback: (data: { threadId: string; content: string; runIds: string[] }) => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('agent-engine:proactive-report-ready', handler)
      return () => { ipcRenderer.removeListener('agent-engine:proactive-report-ready', handler) }
    },
    /**
     * Wave 5b S2 review#1：Skill 凭据缓存主动失效。
     * 详细语义见 main `agent-engine:skill-credential-invalidate` IPC handler 注释。
     */
    invalidateSkillCredentialCache: (filter?: { spaceId?: string; skillKey?: string }) => {
      return invokeIpc('agent-engine:skill-credential-invalidate', filter)
    },

    invalidateSkillEnablementCache: (filter?: { agentId?: string }) => {
      return invokeIpc('agent-engine:skill-enablement-invalidate', filter)
    },

    /**
     * M1.4 / v0.2 per-Organization：手动失效主进程 USER 画像缓存。
     *
     * 前端在用户成功提交 hint / 主动触发 distill（且 distill_dispatched / accepted 为 true）
     * 后调用，让对话里下一轮 runtime 立刻拉到新画像，避免最长 10 分钟的旧缓存窗口。
     *
     * @param organizationId 失效该 Organization 槽位；传 undefined / 空字符串清空全部
     * @param agentId 指定 Agent 时只失效该 (org, agent) 槽位；省略则失效该 org 下全部 Agent 画像缓存
     */
    invalidateUserPortraitCache: (organizationId?: string, agentId?: string): Promise<{ success: true }> => {
      return invokeIpc('agent-engine:invalidate-user-portrait-cache', organizationId, agentId)
    },

    prewarmRuntime: (input: {
      threadId: string
      workspaceId: string
      spaceId: string
      organizationId: string
      agentId: string
      modelId: string
      agentMode?: string
      approvalMode?: string
      workingDir?: string
      workingDirType?: 'code' | 'doc' | 'mixed'
      enabledApps?: ReadonlyArray<{
        key: string
        cliKey?: string
        displayName: string
        capability: string
        aliases?: readonly string[]
      }>
      operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>
      memoryCapability?: boolean
      modelContextWindow?: number
      modelMaxOutput?: number
      modelSupportsVision?: boolean
      modelSupportsFunctionCalling?: boolean
      modelCapabilitiesConfig?: Record<string, unknown>
      modelProvider?: string
      isByokMode?: boolean
      spaceName?: string
      organizationName?: string
      isGroupSpace?: boolean
    }): Promise<{ success: boolean; error?: string }> => {
      return invokeIpc('agent-engine:prewarm-runtime', input)
    },

    getDeviceModelPreferences: (
      organizationId: string,
    ): Promise<{ preferences: OrganizationDeviceModelPreferences }> => {
      return invokeIpc('agent-engine:get-device-model-preferences', { organizationId })
    },
    setDeviceModelPreferences: (
      organizationId: string,
      preferences: OrganizationDeviceModelPreferences,
    ): Promise<{ preferences: OrganizationDeviceModelPreferences }> => {
      return invokeIpc('agent-engine:set-device-model-preferences', {
        organizationId,
        preferences,
      })
    },

    /**
     * 设置 / 重置某个 session 的长上下文档位（Context Tier）。
     *
     * 调用时机：用户在 ChatInput 切档后立即调用，main 进程更新 sessionContextTiers
     * Map，下一次 LLM 请求时 buildHeaders 会自动透传 X-TabTin-Context-Tier，
     * Django proxy 据此往上游注入 anthropic-beta 等档位 header（如 ZenMux 1M）。
     *
     * @param sessionId 目标会话 UUID
     * @param tierId 档位 ID（如 'long_1m'）；传 null / 空字符串重置为默认档
     */
    setSessionContextTier: (sessionId: string, tierId: string | null): Promise<{ success: true }> => {
      return invokeIpc('agent-engine:set-session-context-tier', { sessionId, tierId })
    },
    /**
     * 设置 / 重置某个 session 的模型运行时参数覆盖。
     *
     * 参数 key 来自模型 catalog 的 runtime_controls；Django wire adapter 负责
     * 将 canonical 参数映射到各 provider 的真实 wire 格式。
     */
    setSessionModelParamOverrides: (
      sessionId: string,
      overrides: Record<string, unknown> | null,
    ): Promise<{ success: true }> => {
      return invokeIpc('agent-engine:set-session-model-param-overrides', { sessionId, overrides })
    },
    readSnapshots: (
      sessionId: string,
      ctx?: { spaceId?: string; organizationId?: string },
    ): Promise<{ success: boolean; snapshots?: unknown[]; error?: string }> => {
      // Forward spaceId / organizationId so the main process can resolve the
      // archive path directly instead of falling back to a full scan.
      return invokeIpc('agent-engine:read-snapshots', {
        sessionId,
        spaceId: ctx?.spaceId,
        organizationId: ctx?.organizationId,
      })
    },
    readSubagentSession: (input: {
      parentSessionId: string
      subagentRunId: string
      kind: 'messages' | 'snapshots' | 'events'
      organizationId?: string
      spaceId?: string
    }) => {
      return invokeIpc('agent-engine:read-subagent-session', input)
    },
    // ：判据探盘——该会话盘上是否有非空 messages.jsonl（冷启动区分本机/观察端）。
    hasLocalTranscript: (
      sessionId: string,
      ctx?: { spaceId?: string; organizationId?: string },
    ): Promise<{ success: boolean; hasLocal?: boolean; error?: string }> => {
      return invokeIpc('agent-engine:has-local-transcript', {
        sessionId,
        spaceId: ctx?.spaceId,
        organizationId: ctx?.organizationId,
      })
    },
    // ：云端 fork 后本机归档分叉 + tool id remap。
    forkLocalSession: (input: {
      sourceSessionId: string
      newSessionId: string
      spaceId?: string
      organizationId?: string
      forkAnchorMessageId?: string
      toolIdRemap?: Record<string, string>
    }) => {
      return invokeIpc('agent-engine:fork-local-session', input)
    },
    // ：读本机 transcript（messages.jsonl 重建），本机会话正文唯一权威。
    readSessionTranscript: (
      sessionId: string,
      ctx?: { spaceId?: string; organizationId?: string },
    ): Promise<{ success: boolean; messages?: unknown[]; error?: string }> => {
      return invokeIpc('agent-engine:read-session-transcript', {
        sessionId,
        spaceId: ctx?.spaceId,
        organizationId: ctx?.organizationId,
      })
    },
    listSubagentRuns: (input: {
      parentSessionId: string
      organizationId?: string
      spaceId?: string
    }) => {
      return invokeIpc('agent-engine:list-subagent-runs', input)
    },
  },

  telemetry: {
    mttrStart: (req: { incident_id?: string; description?: string; reporter?: string; session_id?: string; severity?: string } = {}) => {
      return invokeIpc('telemetry:mttr:start', req)
    },
    mttrResolved: (req: { incident_id: string; resolution?: string; duration_ms?: number; resolver?: string; session_id?: string; error_class?: string }) => {
      return invokeIpc('telemetry:mttr:resolved', req)
    },
    emit: (req: { event_name: string; payload?: Record<string, unknown>; session_id?: string; agent_id?: string; trace_id?: string }) => {
      return invokeIpc('telemetry:event', req)
    },
  },

  cli: {
    getCoreCommandCatalog: () => invokeIpc('cli:getCoreCommandCatalog'),
  },

  capabilityDiscovery: {
    getSummary: (spaceId) => invokeIpc('capabilityDiscovery:getSummary', spaceId),
    refreshExecution: (spaceId) => invokeIpc('capabilityDiscovery:refreshExecution', spaceId),
  },

  resourceMonitor: {
    getSnapshot: (options) => invokeIpc('resource-monitor:getSnapshot', options),
  },

  localMcp: {
    discover: () => invokeIpc('localMcp:discover'),
    listConnections: () => invokeIpc('localMcp:listConnections'),
    getConnectionDetail: (connectionId, options) =>
      invokeIpc('localMcp:getConnectionDetail', connectionId, options),
    shareConnectionToOrganization: (connectionId, organizationId) =>
      invokeIpc('localMcp:shareConnectionToOrganization', connectionId, organizationId),
    importCandidate: (candidateId, options) =>
      invokeIpc('localMcp:importCandidate', candidateId, options),
    saveManualConnection: (input) =>
      invokeIpc('localMcp:saveManualConnection', input),
    upsertOrganizationMirror: (input) =>
      invokeIpc('localMcp:upsertOrganizationMirror', input),
    attachConnection: (connectionId, agentId, attached) =>
      invokeIpc('localMcp:attachConnection', connectionId, agentId, attached),
    setConnectionEnabled: (connectionId, enabled) =>
      invokeIpc('localMcp:setConnectionEnabled', connectionId, enabled),
    deleteConnection: (connectionId) =>
      invokeIpc('localMcp:deleteConnection', connectionId),
    probeConnection: (
      connectionId: string,
      options?: { timeoutMs?: number; openOAuthWindow?: boolean },
    ) => invokeIpc('localMcp:probeConnection', connectionId, options),
    cancelProbe: (connectionId: string) =>
      invokeIpc('localMcp:cancelProbe', connectionId),
    waitForPlatformOAuthTicket: (input: {
      authorizeUrl: string
      donePathIncludes?: string
      timeoutMs?: number
    }) => invokeIpc('localMcp:waitForPlatformOAuthTicket', input),
    closePlatformOAuthWindow: () =>
      invokeIpc('localMcp:closePlatformOAuthWindow'),
  },

  // 🆕 资源检测 API
  resourceDetection: {
    getResources: (payload: {
      viewId: string
      category?: string
      captureStatus?: string
      capability?: string
      limit?: number
      probeMedia?: boolean
      hideSegments?: boolean
    }) => {
      return invokeIpc('resourceDetection:getResources', payload)
    },
    listResources: (payload: {
      viewId: string
      category?: string
      captureStatus?: string
      capability?: string
      limit?: number
      probeMedia?: boolean
      hideSegments?: boolean
    }) => {
      return invokeIpc('resourceDetection:listResources', payload)
    },
    inspectResource: (payload: { resourceId: string; viewId?: string }) => {
      return invokeIpc('resourceDetection:inspectResource', payload)
    },
    captureResource: (payload: { resourceId?: string; url?: string; viewId?: string; force?: boolean }) => {
      return invokeIpc('resourceDetection:captureResource', payload)
    },
    downloadResource: (payload: { resourceId?: string; url?: string; viewId?: string; filename?: string; headers?: Record<string, string> }) => {
      return invokeIpc('resourceDetection:downloadResource', payload)
    },
    fetchBuffer: (payload: { url: string; headers?: Record<string, string>; maxBytes?: number }) => {
      return invokeIpc('resourceDetection:fetchBuffer', payload)
    },
    downloadBatch: (payload: {
      resourceIds?: string[]
      urls?: string[]
      headers?: Record<string, string>
      concurrency?: number
      viewId?: string
    }) => {
      return invokeIpc('resourceDetection:downloadBatch', payload)
    },
    parseM3U8: (payload: { resourceId?: string; url?: string; viewId?: string; headers?: Record<string, string> }) => {
      return invokeIpc('resourceDetection:parseM3U8', payload)
    },
    parseStream: (payload: { resourceId?: string; url?: string; viewId?: string; headers?: Record<string, string> }) => {
      return invokeIpc('resourceDetection:parseStream', payload)
    },
    downloadStream: (payload: {
      resourceId?: string
      url?: string
      viewId?: string
      quality?: string
      filename?: string
      outputPath?: string
      headers?: Record<string, string>
      concurrency?: number
    }) => {
      return invokeIpc('resourceDetection:downloadStream', payload)
    },
  },

  // PTY API 实现
  pty: {
    spawn: (sessionId, options) => {
      console.log('🖥️ [Preload] pty:spawn', sessionId, options)
      return invokeIpc('pty:spawn', sessionId, options)
    },
    write: (sessionId, data) => {
      return invokeIpc('pty:write', sessionId, data)
    },
    resize: (sessionId, cols, rows) => {
      return invokeIpc('pty:resize', sessionId, cols, rows)
    },
    kill: (sessionId) => {
      return invokeIpc('pty:kill', sessionId)
    },
    agentKill: (sessionId) => {
      return invokeIpc('pty:agent-kill', sessionId)
    },
    agentDetach: (sessionId) => {
      return invokeIpc('pty:agent-detach', sessionId)
    },
    has: (sessionId) => {
      return invokeIpc('pty:has', sessionId)
    },
    list: () => {
      return invokeIpc('pty:list')
    },
    readOutput: (sessionId, options) => {
      return invokeIpc('pty:readOutput', sessionId, options)
    },
    listWithStatus: (spaceId?: string) => {
      return invokeIpc('pty:listWithStatus', spaceId)
    },
    onData: ptyOnData,
    onExit: ptyOnExit,
    onAgentSessionCreated: ptyOnAgentSessionCreated,
    onAgentSessionClosed: ptyOnAgentSessionClosed,
    onAutoRespondTriggered: ptyOnAutoRespondTriggered,
    releaseThreadSession: (threadId) => {
      return invokeIpc('pty:releaseThreadSession', threadId)
    },
    onPaneStatus: (callback) => {
      const listener = (_event: any, event: {
        sessionId: string
        status: 'idle' | 'running' | 'exited'
        exitCode?: number | null
      }) => {
        callback(event)
      }
      ipcRenderer.on('pty:pane-status', listener)
      return () => {
        ipcRenderer.removeListener('pty:pane-status', listener)
      }
    },
    getPaneStatuses: (): Promise<{ success: boolean; statuses: Record<string, PaneStatus> }> => {
      return invokeIpc('pty:getPaneStatuses')
    },
    snapshotSave: (snapshots) => {
      return invokeIpc('pty:snapshot-save', snapshots)
    },
    snapshotSaveSync: (snapshots) => {
      return ipcRenderer.sendSync('pty:snapshot-save-sync', snapshots)
    },
    snapshotLoad: (sessionId, currentSize) => {
      return invokeIpc('pty:snapshot-load', sessionId, currentSize)
    },
    snapshotManifest: () => {
      return invokeIpc('pty:snapshot-manifest')
    },
    snapshotDelete: (sessionId) => {
      return invokeIpc('pty:snapshot-delete', sessionId)
    },
    snapshotClear: () => {
      return invokeIpc('pty:snapshot-clear')
    },
    pasteImage: (params) => {
      return invokeIpc('pty:paste-image', params)
    },
  },

  // 🆕 原生菜单 API 实现
  overlay: {
    push: (payload) => invokeIpc('overlay:push', payload),
    notifyReady: () => sendIpc('overlay:ready'),
    focusOverlay: () => invokeIpc('overlay:focus'),
    syncGlobalSearchClosed: () => sendIpc('overlay:global-search-closed'),
    sendConfirmResult: (payload) => sendIpc('overlay:confirm-result', payload),
    sendUpdatePromptAction: (payload) => sendIpc('overlay:update-prompt-action', payload),
    navigateSearchResult: (payload) => sendIpc('overlay:navigate-search-result', payload),
    sendNotificationAction: (payload) => sendIpc('overlay:notification-action', payload),
    notificationClosed: () => sendIpc('overlay:notification-closed'),
    syncTheme: (snapshot) => sendIpc('overlay:sync-theme', snapshot),
    syncLocale: (locale) => sendIpc('overlay:sync-locale', locale),
    // 事件订阅统一走 overlayOn(channel)（on + 返回 off），见文件顶部 helper。
    subscribePush: overlayOn<import('@shared/overlay/types').OverlayPushPayload>('overlay:push'),
    onConfirmResult: overlayOn<import('@shared/overlay/types').OverlayConfirmResultPayload>('overlay:confirm-result'),
    onUpdatePromptAction: overlayOn<import('@shared/overlay/types').OverlayUpdatePromptActionPayload>('overlay:update-prompt-action'),
    onGlobalSearchClosed: overlayOn<void>('overlay:global-search-closed'),
    onNavigateSearchResult: overlayOn('overlay:navigate-search-result'),
    onNotificationAction: overlayOn('overlay:notification-action'),
    onNotificationClosed: overlayOn<void>('overlay:notification-closed'),
    onSyncTheme: overlayOn('overlay:sync-theme'),
    onSyncLocale: overlayOn('overlay:sync-locale'),
    setModalSourceOpen: (source, open) => invokeIpc('overlay:set-modal-source-open', { source, open }),
    setHintSize: (size) => invokeIpc('overlay:set-hint-size', size),
    setToastIgnoreMouseEvents: (ignore) =>
      invokeIpc('overlay:set-toast-ignore-mouse-events', { ignore }),
    getToastCursorClientPoint: async () => {
      const result = await invokeIpc<{
        success: boolean
        data?: { clientX: number; clientY: number }
        error?: string
      }>('overlay:get-toast-cursor-client-point')
      if (!result?.success || !result.data) return null
      const { clientX, clientY } = result.data
      if (typeof clientX !== 'number' || typeof clientY !== 'number') return null
      return { clientX, clientY }
    },
    setToastStackSize: (size) => invokeIpc('overlay:set-toast-stack-size', size),
    setToastContentVisible: (visible) =>
      invokeIpc('overlay:set-toast-content-visible', { visible }),
    setHtml5DragShieldSync: (active) => {
      const result = ipcRenderer.sendSync('overlay:set-html5-drag-shield-sync', { active }) as
        | { ok?: boolean; data?: { success?: boolean }; error?: { message?: string } }
        | { success?: boolean; error?: string }
        | undefined
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok && result.data) {
          return { success: Boolean(result.data.success) }
        }
        return { success: false, error: result.error?.message ?? 'shield-failed' }
      }
      if (result && typeof result === 'object' && 'success' in result) {
        return {
          success: Boolean(result.success),
          error: typeof result.error === 'string' ? result.error : undefined,
        }
      }
      return { success: false, error: 'shield-no-response' }
    },
  },

  nativeMenu: {
    open: (template, callbacks, x, y, onClose) => {
      // 生成唯一的菜单 ID
      const menuId = `menu-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`

      // 监听菜单项点击
      const itemClickHandler = (_event: any, data: { menuId: string; itemId: string }) => {
        if (data.menuId === menuId && callbacks[data.itemId]) {
          callbacks[data.itemId]()
        }
      }

      // 监听菜单关闭
      const closeHandler = (_event: any, data: { menuId: string }) => {
        if (data.menuId === menuId) {
          onClose?.()
          // 清理监听器
          ipcRenderer.removeListener('native-menu:item-clicked', itemClickHandler)
          ipcRenderer.removeListener('native-menu:closed', closeHandler)
        }
      }

      // 注册监听器
      ipcRenderer.on('native-menu:item-clicked', itemClickHandler)
      ipcRenderer.on('native-menu:closed', closeHandler)

      // 发送打开菜单请求
      sendIpc('native-menu:open', {
        menuId,
        template,
        x,
        y
      })

      // 返回清理函数
      return () => {
        ipcRenderer.removeListener('native-menu:item-clicked', itemClickHandler)
        ipcRenderer.removeListener('native-menu:closed', closeHandler)
      }
    }
  },

  // 右键上下文菜单
  contextMenu: {
    setLocale: (locale: string) => sendIpc('context-menu:set-locale', locale),
    onAddToContextRequest: (callback: (payload: BrowserContextMenuAddToContextPayload) => void) => {
      const handler = (_event: any, payload: BrowserContextMenuAddToContextPayload) => callback(payload)
      ipcRenderer.on(BROWSER_CONTEXT_MENU_ADD_TO_CONTEXT_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BROWSER_CONTEXT_MENU_ADD_TO_CONTEXT_CHANNEL, handler)
      }
    },
  },

  // 🆕 下载管理 API 实现
  downloads: {
    getAll: () => invokeIpc(DownloadIPCChannels.getAll),
    pause: (id: string) => invokeIpc(DownloadIPCChannels.pause, id),
    resume: (id: string) => invokeIpc(DownloadIPCChannels.resume, id),
    cancel: (id: string) => invokeIpc(DownloadIPCChannels.cancel, id),
    open: (id: string) => invokeIpc(DownloadIPCChannels.open, id),
    showInFolder: (id: string) => invokeIpc(DownloadIPCChannels.showInFolder, id),
    removeItem: (id: string) => invokeIpc(DownloadIPCChannels.removeItem, id),
    clearCompleted: () => invokeIpc(DownloadIPCChannels.clearCompleted),
    retry: (id: string) => invokeIpc(DownloadIPCChannels.retry, id),
    deleteFile: (id: string) => invokeIpc(DownloadIPCChannels.deleteFile, id),
    getActiveCount: () => invokeIpc(DownloadIPCChannels.getActiveCount),
    cancelStream: (id: string) => invokeIpc(DownloadIPCChannels.streamCancel, id),
    onStarted: (callback: (info: DownloadItemData) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, info: DownloadItemData) => callback(info)
      ipcRenderer.on(DownloadIPCChannels.onStarted, listener)
      return () => ipcRenderer.removeListener(DownloadIPCChannels.onStarted, listener)
    },
    onProgress: (callback: (info: DownloadItemData) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, info: DownloadItemData) => callback(info)
      ipcRenderer.on(DownloadIPCChannels.onProgress, listener)
      return () => ipcRenderer.removeListener(DownloadIPCChannels.onProgress, listener)
    },
    onCompleted: (callback: (info: DownloadItemData) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, info: DownloadItemData) => callback(info)
      ipcRenderer.on(DownloadIPCChannels.onCompleted, listener)
      return () => ipcRenderer.removeListener(DownloadIPCChannels.onCompleted, listener)
    },
    onStreamProgress: (callback: (progress: StreamProgressEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: StreamProgressEvent) => callback(progress)
      ipcRenderer.on(DownloadIPCChannels.onStreamProgress, listener)
      return () => ipcRenderer.removeListener(DownloadIPCChannels.onStreamProgress, listener)
    },
    onStreamCompleted: (callback: (data: StreamCompletedEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: StreamCompletedEvent) => callback(data)
      ipcRenderer.on(DownloadIPCChannels.onStreamCompleted, listener)
      return () => ipcRenderer.removeListener(DownloadIPCChannels.onStreamCompleted, listener)
    },
    onStreamFailed: (callback: (data: StreamFailedEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: StreamFailedEvent) => callback(data)
      ipcRenderer.on(DownloadIPCChannels.onStreamFailed, listener)
      return () => ipcRenderer.removeListener(DownloadIPCChannels.onStreamFailed, listener)
    }
  },

  zoom: {
    setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),
    getZoomFactor: () => webFrame.getZoomFactor()
  },

  notification: {
    show: (payload: NotificationPayload) => {
      sendIpc('notification:show', payload)
    },
    getPermissionStatus: () => invokeIpc('notification:getPermissionStatus'),
    getHostState: () => invokeIpc('notification:getHostState'),
    getPrefs: () => invokeIpc('notification:getPrefs'),
    setPrefs: (prefs: Record<string, unknown>) =>
      invokeIpc('notification:setPrefs', prefs),
    setBadgeCount: (count: number) => invokeIpc('notification:setBadgeCount', count),
    clearBadge: () => invokeIpc('notification:clearBadge'),
    checkPermission: () => invokeIpc('notification:checkPermission'),
    onNavigate: (callback: (data: NavigateTarget) => void) => onNotificationNavigate(callback),
    onHostStateChanged: (callback: (data: { hasMainWindow: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { hasMainWindow: boolean }) => callback(data)
      ipcRenderer.on('notification:host-state', handler)
      return () => { ipcRenderer.removeListener('notification:host-state', handler) }
    },
    onShown: (callback: (data: Record<string, unknown>) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => callback(data)
      ipcRenderer.on('notification:shown', handler)
      return () => { ipcRenderer.removeListener('notification:shown', handler) }
    },
    onToastFallback: (callback: (data: { type: string; title: string; body: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { type: string; title: string; body: string }) => callback(data)
      ipcRenderer.on('notification:toast-fallback', handler)
      return () => { ipcRenderer.removeListener('notification:toast-fallback', handler) }
    },
    onSessionViewed: (callback: (data: { sessionId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data)
      ipcRenderer.on('notification:session-viewed', handler)
      return () => { ipcRenderer.removeListener('notification:session-viewed', handler) }
    },
    // IA Phase 2：通知偏好跨设备同步
    syncPrefsFromServer: () => invokeIpc('notification:syncPrefsFromServer'),
    notifyRemotePrefsChanged: (data: { value?: unknown; updatedAt?: number }) =>
      sendIpc('notification:applyRemotePrefs', data),
    onPrefsChanged: (callback: (prefs: Record<string, unknown>) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => callback(data)
      ipcRenderer.on('notification:prefs-changed', handler)
      return () => { ipcRenderer.removeListener('notification:prefs-changed', handler) }
    },
  },

  appSettings: {
    get: () => invokeIpc('app-settings:get'),
    set: (partial: { minimizeToTray?: boolean; autoStart?: boolean }) =>
      invokeIpc('app-settings:set', partial),
  },

  // 深链接事件
  deepLink: {
    onDeepLink: (callback: (data: { path: string; url: string }) => void) => {
      const handler = (_event: any, data: { path: string; url: string }) => callback(data)
      ipcRenderer.on('deep-link', handler)
      return () => {
        ipcRenderer.removeListener('deep-link', handler)
      }
    },
  },

  // W3 ResourceRouter main → renderer 兜底事件（详见 main-window.ts setWindowOpenHandler）
  resourceRouter: {
    // W8 升级（L33 / L88）：payload schema 加 disposition 字段
    // —— Chromium WindowOpenHandlerDetails.disposition ∈ { 'default' |
    // 'foreground-tab' | 'background-tab' | 'new-window' | 'save-to-disk' |
    // 'other' }；'foreground-tab' 表示 ⌘+click / middle-click，是 D2 第 5
    // 层「⌘ 修饰键短路」的唯一可靠跨平台信号（renderer 收不到 metaKey 因
    // 为 click 已经被吞）。renderer 端按 disposition 计算 modifierExternal。
    onOpenFallback: (
      callback: (data: {
        url: string
        source: string
        viewId?: string
        disposition?: string
        filename?: string
        mimeType?: string
        assetId?: string
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: {
          url: string
          source: string
          viewId?: string
          disposition?: string
          filename?: string
          mimeType?: string
          assetId?: string
        },
      ) => callback(data)
      ipcRenderer.on('main:resource-router:open-fallback', handler)
      return () => {
        ipcRenderer.removeListener('main:resource-router:open-fallback', handler)
      }
    },
  },

  // NOTE: W7 resource_open 埋点 IPC 实现在下方 `resourceTelemetry` 块（行 ~3270）
  // 统一暴露——早期草稿曾名 `resourceOpenTelemetry`，已合并到 `resourceTelemetry`
  // 单一通道，main 端 IPC channel 仍是 `telemetry:resource-open:emit`。

  agentMonitor: {
    onEmitInterrupted: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('agent-monitor:emit-interrupted', handler)
      return () => {
        ipcRenderer.removeListener('agent-monitor:emit-interrupted', handler)
      }
    },
  },

  // 🆕 应用更新 API 实现
  updater: {
    getAppVersion: () => invokeIpc('get-app-version'),
    getState: () => invokeIpc('get-update-state'),
    getReleaseHistory: (options?: {
      platform?: 'mac' | 'win' | 'linux'
      arch?: 'x64' | 'arm64'
      channel?: 'stable' | 'beta' | 'alpha'
      limit?: number
      locale?: string
    }) => invokeIpc('get-release-history', options),
    checkForUpdates: () => invokeIpc('check-for-updates'),
    downloadUpdate: () => invokeIpc('download-update'),
    quitAndInstall: () => { invokeIpc('quit-and-install') },
    onUpdateEvent: (callback) => {
      const listener = (_event: any, payload: { event: string; data?: any }) => {
        callback(payload)
      }
      ipcRenderer.on('update-event', listener)
      return () => {
        ipcRenderer.removeListener('update-event', listener)
      }
    }
  },

  // 🆕 客户端诊断日志导出 API 实现
  diagnostics: {
    readLogs: () => invokeIpc('diagnostics:read-logs'),
    getHostEnv: () => invokeIpc('diagnostics:get-host-env'),
    saveBundle: (payload) => invokeIpc('diagnostics:save-bundle', payload),
    queueSupportUpload: (payload) => invokeIpc('diagnostics:queue-support-upload', payload),
    openLogDir: () => invokeIpc('diagnostics:open-log-dir'),
    onTriggerExport: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('diagnostics:trigger-export', handler)
      return () => {
        ipcRenderer.removeListener('diagnostics:trigger-export', handler)
      }
    },
    onTriggerCopy: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('diagnostics:trigger-copy', handler)
      return () => {
        ipcRenderer.removeListener('diagnostics:trigger-copy', handler)
      }
    },
  },

  network: {
    recoverStack: (payload) => invokeIpc('network:recover-stack', payload),
  },

  appCleanup: {
    wipeCredentials: () => invokeIpc('desktop:wipe-credentials'),
    wipeLocalData: () => invokeIpc('desktop:wipe-local-data'),
    uninstallApp: (options) => invokeIpc('desktop:uninstall-app', options ?? {}),
    listCleanupPaths: () => invokeIpc('desktop:list-cleanup-paths'),
  },

  power: {
    preventSleep: () => invokeIpc('power:prevent-sleep'),
    allowSleep: () => invokeIpc('power:allow-sleep'),
  },

  marketplace: {
    installApp: (appId: string, manifest: Record<string, unknown>) =>
      invokeIpc('marketplace:install-app', appId, manifest),
    uninstallApp: (appId: string) => invokeIpc('marketplace:uninstall-app', appId),
    listInstalled: () => invokeIpc('marketplace:list-installed'),
  },

  appDiscovery: {
    updatePatterns: (
      patterns: Array<{ appId: string; appName: string; patterns: string[] }>,
      sourceId?: string,
    ) => {
      sendIpc('app-discovery:update-patterns', patterns, sourceId)
    },
  },

  screenshot: {
    readFileAsDataURL: (filePath: string) => invokeIpc('screenshot:readFileAsDataURL', filePath),
  },

  sandbox: {
    clearApprovalCache: (target?: 'session' | 'persisted') =>
      invokeIpc('sandbox:clear-approval-cache', target) as Promise<{ sessionCount: number; persistedCount: number }>,
    clearApprovalByActionType: (actionType: string) =>
      invokeIpc('sandbox:clear-approval-by-action-type', actionType) as Promise<{ sessionCount: number; persistedCount: number }>,
    getApprovalCacheStats: () =>
      invokeIpc('sandbox:get-approval-cache-stats') as Promise<{ sessionCount: number; persistedCount: number }>,
    syncApprovalPreferences: () =>
      invokeIpc('sandbox:sync-approval-preferences') as Promise<{ sessionCount: number; persistedCount: number }>,
    notifyRemoteApprovalPreferencesChanged: (preferences: Record<string, unknown>) => {
      sendIpc('sandbox:remote-approval-preferences-changed', preferences)
    },
  },

  import: {
    // detect/scan/run/status/cancel/rollback 均为 PlatformSurface envelope（Tier 2），
    // invokeIpc 自动解包 {ok,data}→data / {ok:false}→throw PlatformIpcError。
    detect: () => invokeIpc('import:detect'),
    scan: (input) => invokeIpc('import:scan', input),
    run: (input) => invokeIpc('import:run', input),
    status: (input) => invokeIpc('import:status', input),
    cancel: (input) => invokeIpc('import:cancel', input),
    rollback: (input) => invokeIpc('import:rollback', input),
    /** 本机特化档案列表（不上云）。 */
    listArchives: (organizationId: string) =>
      invokeIpc('import:listArchives', organizationId),
    getArchive: (input: {
      organizationId: string
      source: string
      sourceSessionId: string
    }) => invokeIpc('import:getArchive', input),
    deleteArchive: (input: {
      organizationId: string
      source: string
      sourceSessionId: string
    }) => invokeIpc('import:deleteArchive', input),
    deleteArchivesForWorkspace: (input: {
      organizationId: string
      workspaceId: string
      workingDir?: string | null
    }) => invokeIpc('import:deleteArchivesForWorkspace', input),
    bindOpenedSession: (input: {
      organizationId: string
      source: string
      sourceSessionId: string
      sessionId: string
    }) => invokeIpc('import:bindOpenedSession', input),
    seedSessionTranscript: (input: {
      organizationId: string
      source: string
      sourceSessionId: string
      sessionId: string
      spaceId?: string
    }) => invokeIpc('import:seedSessionTranscript', input),
    onProgress: (callback) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('import:progress', handler)
      return () => { ipcRenderer.removeListener('import:progress', handler) }
    },
  },

  codexSessionShare: {
    projects: () => invokeIpc('codex-session-share:projects'),
    read: (sessionId: string) => invokeIpc('codex-session-share:read', sessionId),
    import: (input: {
      filePath: string
      projectId: string
      projectPath: string
      expectedSessionId?: string
      expectedSessionName?: string
    }) =>
      invokeIpc('codex-session-share:import', input),
    open: (sessionId: string, projectId: string, projectPath: string) =>
      invokeIpc('codex-session-share:open', sessionId, projectId, projectPath),
  },

  credentialVault: {
    detectBrowsers: () => invokeIpc('credential-vault:detect-browsers'),
    extractCookies: (payload) => invokeIpc('credential-vault:extract-cookies', payload),
    injectCookies: (payload) => invokeIpc('credential-vault:inject-cookies', payload),
    getPartitionCookies: (payload) => invokeIpc('credential-vault:get-partition-cookies', payload),
    clearPartitionCookies: (payload) => invokeIpc('credential-vault:clear-partition-cookies', payload),
    checkLoginStatus: (payload) => invokeIpc('credential-vault:check-login-status', payload),
    exportCookiesJson: (payload) => invokeIpc('credential-vault:export-cookies-json', payload),
    importCookiesJson: () => invokeIpc('credential-vault:import-cookies-json'),
    extractPasswords: (payload) => invokeIpc('credential-vault:extract-passwords', payload),
    onAutofillSuggest: (callback) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('credential-vault:autofill-suggest', handler)
      return () => { ipcRenderer.removeListener('credential-vault:autofill-suggest', handler) }
    },
    onAutofillClear: (callback) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('credential-vault:autofill-clear', handler)
      return () => { ipcRenderer.removeListener('credential-vault:autofill-clear', handler) }
    },
    autofillSelect: (payload) => invokeIpc('credential-vault:autofill-select', payload),
    autofillDismiss: (payload) => invokeIpc('credential-vault:autofill-dismiss', payload),
    // Wave 3 G3：保存密码提示
    onSavePrompt: (callback) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('credential-vault:save-prompt', handler)
      return () => { ipcRenderer.removeListener('credential-vault:save-prompt', handler) }
    },
    saveConfirm: (payload) => invokeIpc('credential-vault:save-confirm', payload),
    saveDismiss: (payload) => invokeIpc('credential-vault:save-dismiss', payload),
    saveUndismiss: (payload) => invokeIpc('credential-vault:save-undismiss', payload),
    // Wave 4 视角 1+2 P0 自修：Agent 自动登录失败通知
    //
    // 当 Agent 后台 view 触发的 autofill 失败（凭据过期 / fill 失败 / reveal 配置缺失）
    // 时，主进程发 ``credential-vault:agent-autofill-failed``，renderer 端订阅这条
    // channel 展示 Toast / 状态徽章给用户——PRD Story 5 异常路径"自动登录失败，
    // 密码可能已过期，请手动更新"的兑现入口。
    //
    // 不订阅 = 用户感知 0 = Story 5 失败路径只在主进程日志里。
    onAgentAutofillFailed: (callback) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('credential-vault:agent-autofill-failed', handler)
      return () => { ipcRenderer.removeListener('credential-vault:agent-autofill-failed', handler) }
    },
    // Wave 4 三视角 Review 视角 2 P1 发现 2 自修：Agent 自动登录成功通知。
    // 主进程发 ``credential-vault:agent-autofill-succeeded`` —— payload **不含密码**
    // 且 username 已脱敏。renderer 端展示 info-level toast 给用户看到
    // "Agent 用了哪个账号登了哪个站"。
    onAgentAutofillSucceeded: (callback) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('credential-vault:agent-autofill-succeeded', handler)
      return () => { ipcRenderer.removeListener('credential-vault:agent-autofill-succeeded', handler) }
    },
  },

  loginRelay: createLoginRelayPreloadApi(invokeIpc),

  browserEnv: {
    list: () => invokeIpc('browser-env:list'),
    create: (payload) => invokeIpc('browser-env:create', payload),
    rename: (payload) => invokeIpc('browser-env:rename', payload),
    delete: (payload) => invokeIpc('browser-env:delete', payload),
    bindSpace: (payload) => invokeIpc('browser-env:bind-space', payload),
    getPartition: (payload) => invokeIpc('browser-env:get-partition', payload),
    getEnvironmentForSpace: (payload) => invokeIpc('browser-env:get-environment-for-space', payload),
    onChanged: (callback) => {
      const handler = (_event: any, payload: any) => callback(payload)
      ipcRenderer.on('browser-env:changed', handler)
      return () => { ipcRenderer.removeListener('browser-env:changed', handler) }
    },
  },

  tabsite: {
    initTemplate: (siteId: string, spaceId: string) =>
      invokeIpc('tabsite:initTemplate', siteId, spaceId),
    startDevServer: (siteId: string, projectPath: string) =>
      invokeIpc('tabsite:startDevServer', siteId, projectPath),
    stopDevServer: (siteId: string) =>
      invokeIpc('tabsite:stopDevServer', siteId),
    getDevServerStatus: (siteId: string) =>
      invokeIpc('tabsite:getDevServerStatus', siteId),
  },

  tins: {
    getActivationStates: () => invokeIpc('tins:get-activation-states'),
    togglePanel: (instanceId: string, visible?: boolean) => invokeIpc('tins:toggle-panel', instanceId, visible),
    setInstances: (instances) => invokeIpc('tins:set-instances', instances),
    prepareSandbox: (instanceId) => invokeIpc('tins:prepare-sandbox', instanceId),
    cleanupSandbox: (instanceId) => invokeIpc('tins:cleanup-sandbox', instanceId),
    getResolvedVariables: (instanceId) => invokeIpc('tins:get-resolved-variables', instanceId),
    getPageContext: () => invokeIpc('tins:get-page-context'),
    syncPageContext: (context) => invokeIpc('tins:sync-page-context', context),
    onActivationChanged: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('tins:activation-changed', handler)
      return () => { ipcRenderer.removeListener('tins:activation-changed', handler) }
    },
    onPersistVariable: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('tins:persist-variable', handler)
      return () => { ipcRenderer.removeListener('tins:persist-variable', handler) }
    },
    onToast: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('tins:toast', handler)
      return () => { ipcRenderer.removeListener('tins:toast', handler) }
    },
    onAgentRequest: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('tins:agent-request', handler)
      return () => { ipcRenderer.removeListener('tins:agent-request', handler) }
    },
    respondAgent: (requestId, result) => sendIpc('tins:agent-response', requestId, result),
    registerWebview: (instanceId, contentsId) => invokeIpc('tins:register-webview', instanceId, contentsId),
    unregisterWebview: (instanceId) => invokeIpc('tins:unregister-webview', instanceId),
    onTriggerGoal: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('tins:trigger-goal', handler)
      return () => { ipcRenderer.removeListener('tins:trigger-goal', handler) }
    },
    onWriteTable: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('tins:write-table', handler)
      return () => { ipcRenderer.removeListener('tins:write-table', handler) }
    },
  },

  system: {
    onSuspend: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('system:suspend', handler)
      return () => { ipcRenderer.removeListener('system:suspend', handler) }
    },
    onResume: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('system:resume', handler)
      return () => { ipcRenderer.removeListener('system:resume', handler) }
    },
  },

  browserPrefs: {
    syncSearchEngine: (urlTemplate: string) => sendIpc('browser-prefs:search-engine-template', urlTemplate),
    syncAccessPolicy: (policy: string) => sendIpc('browser-prefs:access-policy', policy),
  },

  agentGateway: {
    onStatusChange: (callback: (status: string) => void) => {
      const handler = (_event: any, status: string) => callback(status)
      ipcRenderer.on('ws:agent-gateway-status', handler)
      return () => { ipcRenderer.removeListener('ws:agent-gateway-status', handler) }
    },
    getStatus: () => invokeIpc('ws:agent-gateway-status-get'),
    onEvent: (callback: (envelope: Record<string, unknown>) => void) => {
      const handler = (_event: any, envelope: Record<string, unknown>) => callback(envelope)
      ipcRenderer.on('ws:agent-gateway-event', handler)
      return () => { ipcRenderer.removeListener('ws:agent-gateway-event', handler) }
    },
    onReconnected: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('ws:agent-gateway-reconnected', handler)
      return () => { ipcRenderer.removeListener('ws:agent-gateway-reconnected', handler) }
    },
    request: (payload: { messageType: string; payload?: Record<string, unknown>; requestOptions?: Record<string, unknown> }) =>
      invokeIpc('ws:agent-gateway-request', payload),
    send: (payload: { messageType: string; payload?: Record<string, unknown>; requestOptions?: Record<string, unknown> }) =>
      invokeIpc('ws:agent-gateway-send', payload),
    subscribe: (payload: { topics: string[]; options?: { topicContexts?: Record<string, Record<string, unknown>> } }) =>
      invokeIpc('ws:agent-gateway-subscribe', payload),
    unsubscribe: (payload: { topics: string[] }) =>
      invokeIpc('ws:agent-gateway-unsubscribe', payload),
    reconnect: () => invokeIpc<boolean>('ws:agent-gateway-reconnect'),
    getOrganizationIds: () => invokeIpc<string[]>('ws:agent-gateway-organization-ids'),
  },

  skill: {
    list: (params: {
      spaceId: string
      organizationId: string
    }) => invokeIpc('skill:list', params),
    install: (params: {
      skillKey: string
      spaceId?: string
      userId?: string
      organizationId?: string
      files: Array<{ path: string; sha256: string; size: number; download_url: string; content_type: string }>
      meta?: { source: string; version: string; installedAt: string; packageId: string; slug?: string; canonicalKey?: string; versionSeq?: number; bundleSha256?: string }
    }) => invokeIpc('skill:install', params),
    installNpm: (params: {
      package: string
      spaceId?: string
      organizationId?: string | null
      importToSpace?: boolean
      enableSpaceIds?: string[]
    }) => invokeIpc('skill:install-npm', params),
    materializeApp: (params: {
      spaceId?: string
      organizationId: string
      userId?: string
      appId: string
      slug: string
    }) => invokeIpc('skill:materialize-app', params),
    uninstall: (params: {
      skillKey: string
      spaceId?: string
      userId?: string
      organizationId?: string
    }) => invokeIpc('skill:uninstall', params),
    readContent: (params: {
      skillKey: string
      spaceId?: string | null
      organizationId?: string | null
      userId?: string | null
      sourceDocPath?: string | null
    }) => invokeIpc('skill:read-content', params),
    writeContent: (params: {
      spaceId: string
      organizationId: string
      skillKey: string
      content: string
    }) => invokeIpc('skill:write-content', params),
    resolvePath: (params: {
      spaceId: string
      organizationId: string
      skillKey: string
    }) => invokeIpc('skill:resolve-path', params),
    workspaceScan: (params: { workspaceRoot: string; force?: boolean }) =>
      invokeIpc('skill:workspace-scan', params),
  },

  uiTheme: {
    report: (theme: 'light' | 'dark') => invokeIpc('ui:report-theme', theme),
  },

  widgetAudit: {
    append: (entry: {
      timestamp: number
      session_id: string
      widget_id: string
      text: string
      meta?: unknown
      trigger_source?: 'widget'
    }) => invokeIpc('widget-audit:append', entry),
  },

  resourceTelemetry: {
    emit: (event: ResourceOpenEventPayload) =>
      ipcRenderer.invoke('telemetry:resource-open:emit', event),
  },

  agentSecurity: {
    // setYoloMode / revokeMemo 已移除：状态变更统一走 useSpaceStore action
    // （见 ElectronAgentHost.ts L-10 的历史背景注释）。本接口只保留只读查询。
    getWorkspaceSnapshot: (spaceId: string) =>
      invokeIpc('agent-security:get-workspace-snapshot', { spaceId }),
    buildApprovalKey: (params: {
      toolName: string
      subcmd: string
      input: unknown
      inWorkspace: boolean
      scope: 'exact' | 'scoped' | 'wildcard'
      kind?: string
    }) => invokeIpc('agent-security:build-approval-key', params),
    buildScopeDescription: (params: {
      toolName: string
      subcmd: string
      scope: string
    }) => invokeIpc('agent-security:build-scope-description', params),
  },

  workspace: {
    notifyPathsChanged: (payload: {
      spaceId: string
      workingDir: string
    }) => {
      return invokeIpc('workspace:paths-changed:invoke', payload)
    },
    appendSessionAllowedPath: (payload: {
      spaceId: string
      sessionId?: string
      path: string
    }) => {
      return invokeIpc('workspace:append-session-allowed-path:invoke', payload)
    },
  },

  // contract W2-ζ — dev-only IpcInspector bridge。prod build 此值为 null，
  // renderer 端 IpcInspectorMount 判 null 不挂载浮层（双重 guard：
  // import.meta.env.DEV + window.tabtin.devInspector !== null）。
  devInspector: buildDevInspectorBridge(ipcRenderer),
} satisfies TabTinAPIShape

// public 类型由实现推导，window.tabtin 类型自动跟随实现，不再需要手工同步接口
export type TabTinAPI = typeof api

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    try {
      const hide = (api as any)?.crawlView?.hide
      if (typeof hide === 'function') {
        void hide().catch(() => {})
      }
    } catch (error) {
      console.warn('[Preload] beforeunload cleanup failed:', error)
    }
  })
}

// 多个 CrawlspaceWorkspace 实例 + 其他模块共享 ipcRenderer 注册监听器，放宽阈值
ipcRenderer.setMaxListeners(100)

// 使用 `contextBridge` API 将 Electron API 暴露给渲染进程
// 只有在上下文隔离启用时才可用
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('tabtin', api)
  } catch (error) {
    console.error('Failed to expose APIs:', error)
    ipcRenderer.send('observability:preload-fatal', {
      code: 'PRELOAD_CONTEXT_BRIDGE_EXPOSURE_FAILED',
    })
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.tabtin = api
}
