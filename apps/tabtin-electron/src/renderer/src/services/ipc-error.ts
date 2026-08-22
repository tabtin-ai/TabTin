/**
 * Renderer 端 IPC 错误形态的 duck-typing 适配层。
 *
 * ## 背景：为什么不直接 `instanceof PlatformIpcError`
 *
 * Wave 2-α 在 `apps/tabtin-electron/src/preload/ipc-shim.ts` 定义了
 * `PlatformIpcError` 类——所有 IPC 调用失败（envelope `ok:false` / 非 envelope
 * 形态等）由 preload 内部统一抛出该类实例。
 *
 * 但 Electron `contextBridge.exposeInMainWorld` **不能透出 class instance**——
 * preload 跟 renderer 是两个独立 V8 isolated context，class identity 不互通。
 * renderer 端 catch 到的 err 实际是一个普通 Error，加上 preload 序列化下来的
 * `code` / `trace_id` / `ipc_channel` / `detail` properties。
 *
 * 所以 renderer 端只能 **duck-typing 检测**——本模块提供 `isPlatformIpcError`
 * + 几个常用 helper（`extractTraceTail` / `formatIpcErrorForUser`）让 caller
 * 的 catch 块保持干净统一，避免每个 caller 都自己写一遍 `(err as { code?: string })`
 * 类型断言。
 *
 * ## 设计原则
 *
 * 1. **薄到不能再薄**：本模块不引入新依赖、不抽业务逻辑——只做 shape detection
 *    + 文案格式化两件事。caller 拿到 helper 输出的字符串后自己决定怎么 toast / log。
 *
 * 2. **优雅降级**：对非 PlatformIpcError 的错误（譬如真的 JS bug、network error），
 *    helper 仍能返回有意义的文案（fallback message 或 err.message），不会因为
 *    "shape 不对"返回空字符串让用户看到神秘的"操作失败"。
 *
 * 3. **trace_id 末 6 位**：用户报障时截图给开发者，6 位足以在 audit log 里反查
 *    （同一秒内 trace_id 末 6 位碰撞概率 < 1/10^7，业务上不会撞）。
 */

/**
 * IPC 错误的 duck-typing 形状描述。
 *
 * 字段语义跟 `apps/tabtin-electron/src/preload/ipc-shim.ts` 的 `PlatformIpcError`
 * 一一对应——任何加字段都得双向同步。
 */
export interface PlatformIpcErrorShape {
  /** 来自 envelope `error.code`，譬如 `'UNAUTHORIZED'` / `'SOFT_FAIL'`。 */
  code: string
  /** envelope 顶层 `trace_id`——可能为空（main 端 ALS 没拿到 trace 时）。 */
  trace_id?: string
  /** 调用的 IPC channel 名，便于开发者定位。 */
  ipc_channel?: string
  /** envelope `error.detail`——含 fallback / retry hint 等业务字段。 */
  detail?: unknown
  /** Error 标准字段。 */
  message: string
}

/**
 * Duck-type 检测：err 是否符合 `PlatformIpcError` 形状。
 *
 * 判定标准：是 object 且至少有 `code` (string) + `message` (string) 两个字段。
 * `trace_id` / `ipc_channel` / `detail` 都是可选的——main 端在 trace context
 * 缺失或 channel 漏标时仍能返回部分诊断信息。
 */
export function isPlatformIpcError(err: unknown): err is PlatformIpcErrorShape {
  if (err === null || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  return typeof e.code === 'string' && typeof e.message === 'string'
}

/**
 * 提取 trace_id 末 6 位。
 *
 * 用户在出错 toast 上能看到 `(req: a3b2c1)`——截图发给开发者后，开发者直接
 * `rg "a3b2c1" ~/.tabtin/audit-log` 即可定位完整调用链。
 *
 * 对非 PlatformIpcError 或没有 trace_id 的情况返回空字符串。
 */
export function extractTraceTail(err: unknown): string {
  if (isPlatformIpcError(err) && err.trace_id) {
    return err.trace_id.slice(-6)
  }
  return ''
}

/**
 * 构造给用户看的错误文案：`<message> (req: ......)`。
 *
 * - PlatformIpcError + trace_id：`<message> (req: ......)`
 * - PlatformIpcError 无 trace_id：仅 `<message>`
 * - 普通 Error：`<message>`（无 trace 后缀）
 * - 字符串错误：原样返回
 * - 其他（null / undefined / object）：返回 `fallbackMessage`
 *
 * @param err - catch 到的任何东西
 * @param fallbackMessage - err 完全无信息时的兜底文案。**必须是 i18n 后的成品文案**，
 *                         本 helper 不做翻译。
 */
export function formatIpcErrorForUser(err: unknown, fallbackMessage = '操作失败'): string {
  const tail = extractTraceTail(err)
  let baseMessage: string

  if (err instanceof Error) {
    baseMessage = err.message || fallbackMessage
  } else if (typeof err === 'string') {
    baseMessage = err
  } else if (isPlatformIpcError(err)) {
    baseMessage = err.message
  } else {
    return fallbackMessage
  }

  return tail ? `${baseMessage} (req: ${tail})` : baseMessage
}

const DIR_READ_PERMISSION_PATTERN =
  /\b(EACCES|EPERM|FS_PERMISSION_DENIED)\b|permission denied|operation not permitted|\baccess denied\b/i

const DIR_READ_WORKSPACE_ACCESS_PATTERN =
  /\boutside (your )?workspace\b|super permissions|tabfolder\/tabcode|blocked by security policy/i

function readLegacyErrorText(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (err !== null && typeof err === 'object') {
    const record = err as Record<string, unknown>
    const code = typeof record.code === 'string' ? record.code : ''
    const error = typeof record.error === 'string' ? record.error : ''
    const message = typeof record.message === 'string' ? record.message : ''
    return [code, error, message].filter(Boolean).join(' ')
  }
  return ''
}

export function isExpectedDirReadAccessError(err: unknown): boolean {
  const message = readLegacyErrorText(err)
  return DIR_READ_WORKSPACE_ACCESS_PATTERN.test(message) || DIR_READ_PERMISSION_PATTERN.test(message)
}

/** 读目录失败时的单行 toast 文案（权限类走 i18n，其它走通用 IPC 格式化）。 */
export function formatDirReadErrorForUser(
  err: unknown,
  translate: (key: string, options?: { defaultValue?: string }) => string,
): string {
  const message = readLegacyErrorText(err)
  if (DIR_READ_WORKSPACE_ACCESS_PATTERN.test(message)) {
    return translate('errorToast.dirReadOutsideWorkspace', {
      defaultValue: '该目录尚未授权访问。请先在 TabFolder/TabCode 中打开此目录授权，或在 Agent Security 设置中开启超级权限。',
    })
  }
  if (DIR_READ_PERMISSION_PATTERN.test(message)) {
    return translate('errorToast.dirReadPermissionDenied', {
      defaultValue: '无法读取该目录，可能没有访问权限。',
    })
  }
  return formatIpcErrorForUser(
    message || err,
    translate('errorToast.dirReadFailed', { defaultValue: '目录读取失败' }),
  )
}
