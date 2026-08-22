/**
 * 延迟 IPC handler 注册工具（v2 — Stub 永驻 + 模块按需加载）。
 *
 * ═══════════════════════════════════════════════════════════
 *  设计原则
 * ═══════════════════════════════════════════════════════════
 *
 * **问题**：v1 在 deferred-services 阶段才批量注册功能级 IPC handler，
 * 但渲染进程在 did-finish-load 后立刻就有组件调用 handler，存在窗口
 * 期 race condition，会出现 "No handler registered for 'fs:readDir'"
 * 这类错误。
 *
 * **v2 解法**：
 * 1. **Stub 同步注册**：在 startup 阶段（窗口创建前）就把所有 deferred
 *    channel 注册 stub handler。stub 永远存在 → 调用方永远拿不到
 *    "No handler registered" 错误。
 * 2. **模块按需加载**：stub 第一次被调用时才动态 import 真模块，从
 *    模块导出的 handlers map 里取真函数转发。同模块的多个 channel
 *    共享同一个 load promise，避免重复 import。
 * 3. **非阻塞预热**：deferred-services 阶段非阻塞地触发所有模块的
 *    import，让用户实际操作时第一次调用零延迟。
 *
 * 调用方完全无感：仍然 `ipcRenderer.invoke('fs:readDir', ...)`，最坏
 * 情况是模块还没加载好时第一次调用慢几十毫秒（等 import 完成）。
 *
 * **失败语义**：本机制只消除一类错误—— "No handler registered for 'xxx'"。
 * 其他失败（模块 import 抛错、handler 内部业务错误、handlers map 缺
 * channel 等）仍然会通过 invoke 的 reject 透传给调用方，调用方应当
 * 像处理普通 IPC 错误一样处理它们。
 *
 * ═══════════════════════════════════════════════════════════
 *  分界规则（ipc-registry.ts vs ipc-lazy.ts）
 * ═══════════════════════════════════════════════════════════
 *
 * ● 何时用 ipc-registry.ts：
 *   核心/启动必需 — 首屏渲染就立即使用的 handler。
 *   例：ping、auth、session、update、device fingerprint、window appearance。
 *   这些 handler 在 app ready 后同步注册，零延迟可用。
 *
 * ● 何时用 ipc-lazy.ts（本文件）：
 *   功能级/可延迟模块 — 用户主动触发才使用的功能。
 *   例：terminal、filesystem、tabsite、credential-vault、MCP。
 *   这些 handler 通过 stub 同步注册，模块按需加载。
 *
 * ● 新增 handler 指南：
 *   1. 在对应模块中导出 `xxxHandlers` 对象（key=channel name, value=
 *      handler 函数）。handler 函数**不要**自己做 sender 校验，stub
 *      层会用 guardedHandle 统一处理。
 *   2. 在下方 DEFERRED_MODULES 数组中添加一项，列出该模块的全部
 *      channel 名（一个不漏，否则该 channel 不会被 stub 注册）。
 *   3. 测试用的 `registerXxxHandlers()` 函数保留，内部遍历同一份
 *      handlers map（详见 file-system/ipc.ts 实现）。
 *
 * ● 调试模式：
 *   设置环境变量 TABTIN_EAGER_IPC=1 在 stub 注册后立刻同步加载所有
 *   模块（而不是非阻塞预热），便于排查"按需加载触发的副作用"相关
 *   问题。stub 永远先注册，跟时序无关。
 *
 * ═══════════════════════════════════════════════════════════
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { errResponse } from '@tabtin/agent-wire'
import { isTrustedSender } from './auth'
import { createLogger } from './logger'
import { buildUnauthorizedReject } from './utils/guarded-handle'
import {
  getCurrentTraceId,
  runWithGeneratedTrace,
  stampTraceIntoEnvelope,
} from './utils/trace-context'

const ipcLog = createLogger('MainIPC')

// IPC 边界类型——参数是从 renderer 序列化过来的，编译期不可知具体形态，
// 由各模块的真 handler 内部进行运行时校验。这里用 any[] 是边界处的合理
// 妥协（避免每个 handler 都得做类型断言到 unknown）。
type IpcInvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: any[]
) => any

interface DeferredModule {
  /** 模块名（用于日志） */
  name: string
  /** 该模块要注册的全部 IPC channel 名。**必须一个不漏**。 */
  channels: readonly string[]
  /**
   * 加载模块并返回 channel→handler 的映射。
   * 同模块的多个 channel 共享同一个 load promise，模块只 import 一次。
   *
   * 如果模块有需要在加载完成时执行的副作用（如订阅事件源、初始化外部
   * 服务），应在该函数内调用模块的 `initXxxSideEffects()` 显式触发，
   * 而不是依赖 ESM import 的副作用。
   */
  load: () => Promise<Record<string, IpcInvokeHandler>>
  /**
   * Sender 校验策略（默认 `'guarded'`）。
   *
   * - **`'guarded'`**：stub 层用 `isTrustedSender` 校验（等价于 `guardedHandle`
   *   的行为）。适用于绝大多数渲染端发起的 IPC。
   * - **`'skip'`**：stub 完全不做 sender 校验，由 handler 内部负责。适用场景：
   *     a) 合法 sender 是外部 https 页面（如 `credential-vault:password-captured`），
   *        `isTrustedSender` 会永远拒绝；
   *     b) 校验逻辑依赖模块内部状态（如 `webContentsMap` 注册关系），
   *        无法在配置层用静态规则表达。
   *   选 `'skip'` 的模块**必须**在 handler 内部自行做严格校验，否则等同于
   *   把 channel 暴露给任意 sender。
   */
  senderPolicy?: 'guarded' | 'skip'
}

// Wave 0 + W1 D3 contract: stub-level sender-guard rejection shares the
// same envelope shape **and** the same trace_id stamping behaviour as
// utils/guarded-handle.ts. We call the factory at rejection time so each
// reject carries the per-call trace_id that lets the user grep "req:
// xxxxxx" back to this exact rejecting log line.

// ── 模块清单 ──────────────────────────────────────────────
//
// 每个模块的 channels 必须**完整列出**——stub 注册时只看这里，漏写
// 的 channel 不会被 stub 占位，渲染端调用时仍然会撞 race condition。
//
// 历史遗留模块（仍未迁移成 handlers map 的）见下方 LEGACY_DEFERRED_HANDLERS。

const DEFERRED_MODULES: readonly DeferredModule[] = [
  {
    name: 'FileSystemIPC',
    channels: [
      'fs:pathExists',
      'fs:readDir',
      'fs:readFilePreview',
      'fs:renderOfficePreview',
      'fs:renderOfficePreviewData',
      'fs:writeFile',
      'fs:ensureSpaceSandbox',
      'fs:ensureDefaultAgentDir',
      'fs:lookupSpaceSandbox',
      'fs:watch',
      'fs:unwatch',
      'fs:readBinaryFile',
      'fs:writeBinaryFile',
      'fs:replaceInFiles',
      'fs:createDir',
      'fs:rename',
      'fs:deleteDir',
      'fs:deleteFile',
      'fs:ripgrepSearch',
      'fs:ripgrepSearchCancel',
      'fs:computeSkillContentHash',
      'shell:openPath',
      'shell:openExternal',
      'shell:showItemInFolder',
      'clipboard:writeFile',
    ],
    load: async () => (await import('./file-system/ipc')).fileSystemHandlers,
  },
  {
    name: 'TabsiteIPC',
    channels: [
      'tabsite:initTemplate',
      'tabsite:startDevServer',
      'tabsite:stopDevServer',
      'tabsite:getDevServerStatus',
    ],
    load: async () => (await import('./tabsite/ipc')).tabsiteHandlers,
  },
  {
    name: 'ResourceMonitorIPC',
    channels: ['resource-monitor:getSnapshot'],
    load: async () => (await import('./resource-monitor/ipc')).resourceMonitorHandlers,
  },
  {
    name: 'BrowserEnvIPC',
    channels: [
      'browser-env:list',
      'browser-env:create',
      'browser-env:rename',
      'browser-env:delete',
      'browser-env:bind-space',
      'browser-env:get-partition',
      'browser-env:get-environment-for-space',
    ],
    load: async () => {
      const mod = await import('./browser-env/ipc')
      // 模块第一次加载时建立 onChanged → renderer 广播订阅（幂等）
      mod.initBrowserEnvSideEffects()
      return mod.browserEnvHandlers
    },
  },
  {
    name: 'LoginRelayIPC',
    channels: [
      'login-relay:start',
      'login-relay:complete',
      'login-relay:cancel',
    ],
    load: async () => {
      const mod = await import('./login-relay/ipc')
      mod.initLoginRelaySideEffects()
      return mod.loginRelayHandlers
    },
  },
  {
    name: 'LocalMcpIPC',
    channels: [
      'localMcp:discover',
      'localMcp:listConnections',
      'localMcp:getConnectionDetail',
      'localMcp:shareConnectionToOrganization',
      'localMcp:importCandidate',
      'localMcp:saveManualConnection',
      'localMcp:upsertOrganizationMirror',
      'localMcp:attachConnection',
      'localMcp:setConnectionEnabled',
      'localMcp:deleteConnection',
      'localMcp:probeConnection',
      'localMcp:cancelProbe',
      'localMcp:waitForPlatformOAuthTicket',
      'localMcp:closePlatformOAuthWindow',
    ],
    load: async () => (await import('./services/LocalMcpService')).localMcpHandlers,
  },
  {
    name: 'ApprovalSyncInvokeIPC',
    // ⚠ senderPolicy='skip'：沿用历史「裸 ipcMain.handle」语义（不做
    // sender 校验）。此 channel 由 AppGlobalEffects 在用户登录后立刻
    // invoke——属于启动早期路径，必须走 stub 而不是 LEGACY。
    // 行为兼容选择：未来可单独 PR 评估是否升级为 'guarded'。
    senderPolicy: 'skip',
    channels: ['sandbox:sync-approval-preferences'],
    load: async () => (await import('./services/ApprovalManager')).approvalSyncHandlers,
  },
] as const

/**
 * 旧路径：还没迁移成 handlers map 的模块。
 * 这些模块的 register 函数会在 registerDeferredIpcHandlers() 阶段被调
 * 用——仍存在原有的 race condition 窗口（invoke 类）/ 事件丢失窗口
 * （on 类），但维持向后兼容。
 *
 * 当前仍保留的两项及理由：
 *
 * - **CredentialVaultIPC**（待迁移 P2）：跨两文件（ipc.ts +
 *   autofill-service.ts）、混用裸 ipcMain.handle（password-captured 故
 *   意接受外部 https 页）与 guardedHandle、autofill init 有重副作用
 *   （注入 Django API、view classification 等）。channel 主要在设置页 /
 *   TabWeb 登录场景被调用，对启动早期 race 不敏感（renderer 进入这
 *   些场景时 LEGACY 必已注册）。迁移涉及十几个 channel + 复杂副作用
 *   编排，单独 PR 处理。预计走 `senderPolicy: 'skip'` 容纳那 4 个特
 *   殊 channel。
 *
 * - **ApprovalSyncEventIPC**（永久 LEGACY，不计入"待迁移"）：仅注册
 *   `sandbox:remote-approval-preferences-changed` 这个事件监听
 *   （ipcMain.on，由 guardedOn 包装）。stub 体系**不支持事件型 channel**
 *   ——事件在监听挂载前到达会被丢弃，但不会抛错给 renderer，风险面
 *   远小于 invoke 类。invoke 类的 `sandbox:sync-approval-preferences`
 *   已在 DEFERRED_MODULES 里。本项可视为"LEGACY 数组的合理终态成
 *   员"，无需迁出。
 *
 * 迁移时把模块从 LEGACY_DEFERRED_HANDLERS 移到上方 DEFERRED_MODULES，
 * 模块端实现 `xxxHandlers` 导出 + 必要的 `initXxxSideEffects()`。
 *
 * （TabtinFileProtocol 不是 IPC，已在 startup-services.registerCoreProcess-
 *  Handlers 同步注册，不再走 deferred 路径。）
 */
const LEGACY_DEFERRED_HANDLERS: Array<{ name: string; load: () => Promise<void> }> = [
  { name: 'CredentialVaultIPC', load: () => import('./credential-vault/ipc').then(m => m.registerCredentialVaultHandlers()) },
  // 仅注册 ApprovalSync 的事件监听部分；invoke 类已在 DEFERRED_MODULES
  { name: 'ApprovalSyncEventIPC', load: () => import('./services/ApprovalManager').then(m => m.registerApprovalSyncEventListeners()) },
]

// ── 运行时状态 ────────────────────────────────────────────

const moduleHandlersCache = new Map<
  string,
  Promise<Record<string, IpcInvokeHandler>>
>()
const stubsRegistered = new Set<string>()
let legacyRegistered = false
const isEagerMode = process.env.TABTIN_EAGER_IPC === '1'

// ── 公共 API ──────────────────────────────────────────────

/**
 * 同步注册所有 deferred channel 的 stub handler。**必须**在 startup 阶段
 * （窗口创建前）调用，否则窗口加载后第一次 invoke 仍然会撞 race。
 *
 * stub 内部行为：
 *   1. 校验 sender（按模块的 `senderPolicy`，默认 `'guarded'`）
 *   2. 第一次调用触发模块的动态 import；同模块多 channel 共享同一个
 *      load promise，模块只 import 一次
 *   3. 等 import 完成后从 handlers map 取真函数转发
 *
 * 调用是幂等的——重复调用不会重复注册（避免 Electron "second handler" 报错）。
 */
export function registerDeferredIpcStubs(): void {
  let registeredCount = 0
  for (const mod of DEFERRED_MODULES) {
    for (const channel of mod.channels) {
      if (stubsRegistered.has(channel)) continue
      registerOneStub(mod, channel)
      stubsRegistered.add(channel)
      registeredCount++
    }
  }
  if (registeredCount > 0) {
    ipcLog.info(`Deferred IPC stubs 已注册 (${registeredCount} 个 channel，跨 ${DEFERRED_MODULES.length} 个模块)`)
  }
}

function registerOneStub(mod: DeferredModule, channel: string): void {
  const policy = mod.senderPolicy ?? 'guarded'
  const stub = async (event: IpcMainInvokeEvent, ...args: any[]) => {
    return runWithGeneratedTrace(async () => {
      if (policy === 'guarded' && !isTrustedSender(event)) {
        ipcLog.warn(
          `IPC 调用被拒绝: ${channel} (trace_id=${getCurrentTraceId()})，来源: ${event.senderFrame?.url}`,
        )
        return buildUnauthorizedReject()
      }
      let promise = moduleHandlersCache.get(mod.name)
      if (!promise) {
        promise = mod.load()
        moduleHandlersCache.set(mod.name, promise)
      }
      let handlers: Record<string, IpcInvokeHandler>
      try {
        handlers = await promise
      } catch (err) {
        // 加载失败：清掉 cache，让下一次调用重试 import；同时回 envelope。
        // 历史版本 throw err 会让 invoke 端拿到 reject——renderer 没法用统一
        // PlatformIpcError 路径处理（W2-α 的 invokeIpc shim 期望 envelope.ok===false）。
        // W2-δ 收口：LOAD_FAILED + HANDLER_NOT_FOUND 都用 errResponse 形态，配合
        // ALS context 自动 stamp trace_id，让 user 截屏 toast 末 6 位仍可 grep 到
        // ipc-lazy 这条加载失败日志。
        moduleHandlersCache.delete(mod.name)
        const errorMessage = err instanceof Error ? err.message : String(err)
        ipcLog.error(`Deferred 模块加载失败: ${mod.name} (channel ${channel})`, err)
        return stampTraceIntoEnvelope(
          errResponse(
            'LOAD_FAILED',
            `Deferred 模块加载失败: ${mod.name} (channel ${channel})`,
            {
              detail: {
                module: mod.name,
                channel,
                error_message: errorMessage,
              },
            },
          ),
        )
      }
      const handler = handlers[channel]
      if (!handler) {
        ipcLog.error(
          `Deferred 模块 "${mod.name}" 缺少 channel "${channel}" 的 handler。` +
          `检查模块导出的 handlers map 是否完整。`,
        )
        return stampTraceIntoEnvelope(
          errResponse(
            'HANDLER_NOT_FOUND',
            `Deferred 模块 "${mod.name}" 缺少 channel "${channel}" 的 handler`,
            {
              detail: {
                module: mod.name,
                channel,
              },
            },
          ),
        )
      }
      const result = await handler(event, ...args)
      return stampTraceIntoEnvelope(result)
    })
  }
  ipcMain.handle(channel, stub)
}

/**
 * 加载并预热所有 deferred 模块（兼容旧 API 名）。
 *
 * 行为分两段：
 * 1. 调用 LEGACY_DEFERRED_HANDLERS 各模块的 register 函数（保持向后兼容）
 * 2. 触发 DEFERRED_MODULES 各模块的 lazy import（非阻塞预热，让首次
 *    实际调用零延迟）
 *
 * EAGER 模式下两段都同步等完。
 */
export async function registerDeferredIpcHandlers(): Promise<void> {
  if (legacyRegistered) return
  legacyRegistered = true

  // 兜底：如果 startup 阶段忘了调 registerDeferredIpcStubs，这里补一次
  if (stubsRegistered.size === 0) {
    ipcLog.warn('registerDeferredIpcStubs 未在 startup 阶段调用，补注册中——可能存在 race condition')
    registerDeferredIpcStubs()
  }

  if (isEagerMode) {
    ipcLog.info('TABTIN_EAGER_IPC=1: 同步加载全部 deferred 模块...')
    // 旧路径模块
    for (const h of LEGACY_DEFERRED_HANDLERS) {
      try {
        await h.load()
      } catch (err) {
        ipcLog.error(`${h.name} 注册失败:`, err)
      }
    }
    // 新路径模块（触发 import + handlers cache 填充）
    await Promise.allSettled(
      DEFERRED_MODULES.map(mod => triggerModuleLoad(mod)),
    )
    ipcLog.info('Deferred 模块同步加载完成')
    return
  }

  ipcLog.info('开始延迟注册功能级 IPC handlers...')

  // 旧路径：仍然 await 全部 register
  const legacyResults = await Promise.allSettled(
    LEGACY_DEFERRED_HANDLERS.map(h => h.load()),
  )
  for (let i = 0; i < legacyResults.length; i++) {
    const result = legacyResults[i]
    if (result.status === 'rejected') {
      ipcLog.error(`${LEGACY_DEFERRED_HANDLERS[i].name} 注册失败:`, result.reason)
    }
  }
  const legacyFailed = legacyResults.filter(r => r.status === 'rejected').length

  // 新路径：非阻塞预热（不 await）。即使预热没跑完，stub 也能兜底。
  for (const mod of DEFERRED_MODULES) {
    triggerModuleLoad(mod).catch(err => {
      ipcLog.error(`${mod.name} 预热失败（stub 仍可兜底）:`, err)
    })
  }

  if (legacyFailed > 0) {
    ipcLog.warn(`Legacy IPC 注册完成，${legacyFailed}/${legacyResults.length} 个失败；新路径模块非阻塞预热中`)
  } else {
    ipcLog.info(`Legacy IPC 注册完成 (${legacyResults.length} 个)；新路径模块非阻塞预热中 (${DEFERRED_MODULES.length} 个)`)
  }
}

function triggerModuleLoad(mod: DeferredModule): Promise<Record<string, IpcInvokeHandler>> {
  let promise = moduleHandlersCache.get(mod.name)
  if (!promise) {
    promise = mod.load()
    moduleHandlersCache.set(mod.name, promise)
  }
  return promise
}

/**
 * 仅供测试：重置 stub 注册状态。
 * 测试代码在 beforeEach 调用此函数 + ipcMain.removeHandler 清场。
 */
export function __resetDeferredIpcForTesting(): void {
  moduleHandlersCache.clear()
  stubsRegistered.clear()
  legacyRegistered = false
}

/**
 * 仅供测试：返回 stub 已注册的 channel 列表（不可变快照）。
 */
export function __getRegisteredStubChannelsForTesting(): readonly string[] {
  return [...stubsRegistered]
}

/**
 * 仅供测试：返回已被触发加载的模块名列表（cache key 集合）。
 * 用来验证"懒加载"和"同模块共享 load promise"语义。
 */
export function __getLoadedModuleNamesForTesting(): readonly string[] {
  return [...moduleHandlersCache.keys()]
}
