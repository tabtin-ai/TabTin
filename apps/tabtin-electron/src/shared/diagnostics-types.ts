/**
 * 客户端诊断日志导出——主进程 / preload / 渲染进程共享的数据契约。
 *
 * 放在 `src/shared` 让三端只依赖同一份类型定义（`import type` 会被编译期擦除，
 * 不引入运行时耦合）。
 *
 * 三个 IPC channel 经 `invokeIpc` 后返回下方业务 payload（envelope 已 unwrap）；
 * 失败路径为 throw `PlatformIpcError`，不再使用 `{ success: false }`。
 */

/** 主进程日志读取结果（`diagnostics:read-logs`）。 */
export interface DiagnosticsLogSnapshot {
  /** 是否读到任何主进程日志内容。 */
  available: boolean
  /** 日志所在目录绝对路径（用于「打开日志文件夹」提示）。 */
  logDir: string | null
  /** 当前 main.log 内容（可能因过大被截断为尾部）。 */
  mainLog: string | null
  /** 兼容旧字段：第一份轮转归档内容（若存在）。 */
  oldLog: string | null
  /** 轮转归档日志内容，按新到旧排序，如 main.1.log → main.5.log。 */
  archivedLogs?: Array<{ fileName: string; content: string }>
  /** 不可用时的人类可读说明（如开发模式文件通道关闭）。 */
  note?: string
}

/** 渲染进程组装好的 zip 落盘请求（`diagnostics:save-bundle`）。 */
export interface DiagnosticsBundlePayload {
  /** 纯文件名，必须以 .zip 结尾、不含路径分隔符。 */
  filename: string
  /** zip 二进制的 base64 编码。 */
  base64: string
}

/** 落盘成功后的业务 payload（失败走 throw）。 */
export interface DiagnosticsSaveResult {
  absolutePath: string
  bytes: number
  /** 主进程是否成功注入 main.log */
  mainLogAttached?: boolean
  /** 主进程是否成功注入 main.old.log */
  oldLogAttached?: boolean
  /** main.log 未注入时的说明 */
  mainLogNote?: string
}

/** 用户主动上传完整诊断包后的本地队列结果。 */
export interface DiagnosticsSupportUploadResult {
  bundleId: string
  queued: boolean
}

/** 打开日志目录成功后的业务 payload（失败走 throw）。 */
export interface DiagnosticsOpenDirResult {
  path: string
}

/** 主进程采集的主机硬件 / 运行时架构（`diagnostics:get-host-env`）。 */
export interface DiagnosticsHostEnv {
  processArch: string
  platform: string
  cpuBrand: string | null
  macTranslated: number | null
  macSupportsArm64: number | null
  osBuild: string | null
  execBasename: string
  runtimeLabel: string
}
