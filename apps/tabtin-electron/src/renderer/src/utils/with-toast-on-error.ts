/**
 * `withToast` — Wave 2 W2-γ：store action HOC，自动把异常转成用户可见的 toast。
 *
 * 设计目标：让开发者写新 store action 时不再手写 `try/catch + toast.error` 模板。
 * 一行包装即可获得：
 *   - PlatformIpcError → 含 trace_id 末 6 位 + "复制 req" action 的 destructive toast
 *   - 普通 Error → message 文案的 destructive toast
 *   - silentCodes 命中 → 跳过 toast 但仍 rethrow + 调 onError（用户场景"业务上 fail-soft 不该打扰用户"）
 *   - 同 trace_id 5s 内只弹一次（防止 retry 风暴轰炸）
 *   - dev 模式额外 console.error 完整诊断（开发者反查）
 *
 * 与 W2-α 的 PlatformIpcError 契约对齐 —— 通过 duck typing 识别（不直接 import preload，
 * 因为 preload 跑在隔离上下文，跨 context 的 `instanceof` 不可靠）。
 *
 * 典型接入方式：
 *
 * ```ts
 * register: withToast(
 *   async (data) => apiService.register(data),
 *   { titleKey: 'errors.registerFailed' },
 * )
 *
 * installApp: withToast(
 *   async (organizationId, appId) => { ... },
 *   {
 *     titleKey: 'errors.appInstallFailed',
 *     onError: () => set({ installingAppId: null, apps: prevApps }),  // 回滚
 *   },
 * )
 * ```
 *
 */

import * as React from 'react'
import { toast, ToastAction } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('withToast')

// ---------------------------------------------------------------------------
// PlatformIpcError 识别 — duck typing
// ---------------------------------------------------------------------------

/**
 * `PlatformIpcError` 的最小字段形态（W2-α 在 preload/ipc-shim.ts 定义）。
 *
 * **为什么不直接 import**：preload 与 renderer 跑在隔离上下文，跨 context 的
 * 类引用不一致（preload 的 `PlatformIpcError` 与 renderer 见到的对象虽然字段
 * 相同但类型对象不同），`instanceof` 检查会 false negative。duck typing 是
 * 跨进程边界的标准做法。
 */
export interface PlatformIpcErrorLike {
  name: string
  message: string
  /** 来自 envelope.error.code，譬如 'UNAUTHORIZED' / 'SOFT_FAIL' */
  code: string
  /** 来自 envelope.trace_id（顶层，可选——W1 D3 之前的旧 envelope 可能为空） */
  trace_id?: string
  /** 调用的 channel，便于 grep 反查 */
  ipc_channel: string
  /** envelope.error.detail（含 fallback / hint 等） */
  detail?: unknown
}

/** Duck typing：判断 unknown 是否符合 PlatformIpcError 形态。 */
export function isPlatformIpcError(err: unknown): err is PlatformIpcErrorLike {
  if (!err || typeof err !== 'object') return false
  const e = err as Partial<PlatformIpcErrorLike>
  return (
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    typeof e.ipc_channel === 'string'
  )
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WithToastOptions {
  /**
   * 这些 code 不弹 toast（仍 rethrow + 调 onError）。
   *
   * 默认含 `'SOFT_FAIL'` —— W1 A2 fail-soft 哲学规定后端"业务上故意失败"
   * 必须用 `errResponse('SOFT_FAIL', ...)` 形态显式告诉前端。前端默认应当
   * 静默处理（譬如标题生成超时降级到"新对话"），不应该用大红色 toast 打扰
   * 用户。caller 可以扩展更多业务静默码。
   */
  silentCodes?: string[]

  /**
   * Toast 标题的 i18n key。缺省 `'errors.actionFailed'`（common ns）。
   * 推荐 caller 传入领域专用 key，譬如 `'errors.downloadFailed'`，让用户
   * 一眼看出是哪个动作失败。
   */
  titleKey?: string

  /**
   * 自定义错误 hook。先于 toast 跳过场景外仍会执行（譬如 silentCodes 命中
   * 时也会调）。常用于在 catch 里做局部 state 清理 / 乐观更新回滚 / setError
   * 状态等副作用。hook 自身抛异常会被吞掉（dev 模式下 console.error）。
   */
  onError?: (err: unknown) => void

  /**
   * 是否重新抛出原异常给 caller。默认 `true`（让 caller 可以 await 后判断
   * 失败）。设为 `false` 适用于 fire-and-forget 场景（譬如后台同步、定时
   * 任务），caller 不关心成败。
   */
  rethrow?: boolean
}

// ---------------------------------------------------------------------------
// 默认行为常量
// ---------------------------------------------------------------------------

const DEFAULT_SILENT_CODES = ['SOFT_FAIL'] as const

/**
 * 同一错误指纹在该窗口内只弹一次 toast。
 *
 * 5 秒窗口的取舍：足以覆盖一次"用户连点 → 多次失败"的常见场景；又短到
 * 让两次独立失败事件能各自弹 toast。窗口太长会丢失再次提示，太短没有
 * 去重效果。
 */
const TOAST_DEDUPE_WINDOW_MS = 5000

/**
 * 最近弹过 toast 的指纹 → 时间戳。
 *
 * 优先用 `trace_id` 作为指纹（W1 D3 后每个 IPC 失败都有唯一 trace_id）；
 * 没有 trace 时退化为 `code:message` 哈希。模块级单例 — 不需要测试隔离
 * 时显式重置（5s 窗口足够短，跨测试天然过期）。
 */
const recentToastedKeys = new Map<string, number>()

function shouldSkipToastDueToDedupe(key: string): boolean {
  const now = Date.now()
  for (const [k, ts] of recentToastedKeys.entries()) {
    if (now - ts > TOAST_DEDUPE_WINDOW_MS) recentToastedKeys.delete(k)
  }
  const last = recentToastedKeys.get(key)
  if (last !== undefined && now - last < TOAST_DEDUPE_WINDOW_MS) return true
  recentToastedKeys.set(key, now)
  return false
}

function dedupeKeyForError(err: unknown): string {
  if (isPlatformIpcError(err) && err.trace_id) return `trace:${err.trace_id}`
  if (isPlatformIpcError(err)) return `code:${err.code}:${err.message}`
  if (err instanceof Error) return `err:${err.name}:${err.message}`
  return `unknown:${String(err)}`
}

/** 测试专用：清空 dedupe 缓存。生产代码不应调用。 */
export function __resetToastDedupeForTesting(): void {
  recentToastedKeys.clear()
}

// ---------------------------------------------------------------------------
// Toast 渲染
// ---------------------------------------------------------------------------

function showPlatformIpcErrorToast(err: PlatformIpcErrorLike, titleKey: string): void {
  const traceId = err.trace_id ?? ''
  const traceTail = traceId ? traceId.slice(-6) : ''
  const description = traceTail
    ? `${err.message} (req: ${traceTail})`
    : err.message

  const action = traceId
    ? React.createElement(
        ToastAction,
        {
          altText: i18n.t('errors.copyTrace', { defaultValue: '复制 req' }),
          onClick: () => {
            void copyTraceToClipboard(traceId)
          },
        },
        i18n.t('errors.copyTrace', { defaultValue: '复制 req' }),
      )
    : undefined

  toast({
    title: i18n.t(titleKey, { defaultValue: '操作失败' }),
    description,
    variant: 'destructive',
    duration: 8000,
    ...(action ? { action } : {}),
  })
}

function showGenericErrorToast(err: unknown, titleKey: string): void {
  const message = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : i18n.t('errors.unknownError', { defaultValue: '未知错误' })

  toast({
    title: i18n.t(titleKey, { defaultValue: '操作失败' }),
    description: message,
    variant: 'destructive',
    duration: 5000,
  })
}

async function copyTraceToClipboard(traceId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(traceId)
    toast.success(
      i18n.t('errors.traceCopied', { defaultValue: '诊断 ID 已复制' }),
      { duration: 1500 },
    )
  } catch (clipErr) {
    log.debug('clipboard write failed:', clipErr)
    // 视角 1 P1：prod 也要给用户反馈，否则 destructive UX —— 用户以为复制
    // 成功了，结果反馈群里粘出来是空的。description 把 trace 露出来，让用户
    // 至少能手抄/截屏。
    toast({
      title: i18n.t('errors.copyFailedTitle', { defaultValue: '复制失败' }),
      description: i18n.t('errors.copyFailedDesc', {
        defaultValue: '请手动选中并复制诊断 ID：{{trace}}',
        trace: traceId,
      }),
      variant: 'destructive',
      duration: 10000,
    })
  }
}

// ---------------------------------------------------------------------------
// HOC 主入口
// ---------------------------------------------------------------------------

/**
 * 把 store action 包一层，自动将异常转 toast。
 *
 * 类型保留：返回函数与原 action 类型签名相同（参数 / 返回值），调用方零
 * 感知。`rethrow:false` 场景下返回值类型与原 action 一致，但实际可能拿
 * 到 undefined（错误被吞）—— 这是 fire-and-forget 的语义，调用方应该明
 * 确知道。
 *
 * 实现注：`(...args: any[]) => Promise<any>` 是 HOC 泛型约束的标准写法 ——
 * 用 `unknown` 会让 caller 失去原 action 真实签名（参数 / 返回值都退化成
 * unknown）。任何函数都能被包，类型在 `F extends ...` 处被捕获并完整保留。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withToast<F extends (...args: any[]) => Promise<any>>(
  action: F,
  opts: WithToastOptions = {},
): F {
  const {
    silentCodes,
    titleKey = 'errors.actionFailed',
    onError,
    rethrow = true,
  } = opts

  const effectiveSilentCodes = new Set<string>([
    ...DEFAULT_SILENT_CODES,
    ...(silentCodes ?? []),
  ])

  const wrapped = async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>> | undefined> => {
    try {
      return await action(...args)
    } catch (err) {
      // 完整诊断进诊断包环形缓冲（log.debug 生产环境走 recordLog、不打 console，
      // 既不污染生产 console 又能让「导出诊断包」还原 store action 失败现场）。
      // 只记结构化可诊断字段（code / channel / trace_id / message），不打敏感值。
      if (isPlatformIpcError(err)) {
        log.debug('PlatformIpcError thrown:', {
          code: err.code,
          channel: err.ipc_channel,
          trace_id: err.trace_id,
          message: err.message,
          detail: err.detail,
        })
      } else {
        log.debug('action threw:', err)
      }

      const isSilent = isPlatformIpcError(err) && effectiveSilentCodes.has(err.code)

      if (!isSilent) {
        const key = dedupeKeyForError(err)
        const skipToast = shouldSkipToastDueToDedupe(key)
        if (!skipToast) {
          if (isPlatformIpcError(err)) {
            showPlatformIpcErrorToast(err, titleKey)
          } else {
            showGenericErrorToast(err, titleKey)
          }
        }
      }

      if (onError) {
        try {
          onError(err)
        } catch (hookErr) {
          log.debug('onError hook threw:', hookErr)
        }
      }

      if (rethrow) throw err
      return undefined
    }
  }

  return wrapped as unknown as F
}
