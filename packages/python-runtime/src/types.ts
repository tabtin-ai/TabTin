/**
 * L0 纯基础设施类型定义 —— 零业务概念。
 *
 * 本包只认识「运行时归档 / manifest / 缓存目录 / 解释器入口」这些基础设施事实，
 * 不认识 Space / Agent / Organization / Skill / app.json。所有外部信息（cacheDir、
 * 候选路径、随包归档、日志）一律由调用方（L1 宿主适配层）注入，
 * 便于纯离线单测且不与任何 app / electron / daemon 耦合。
 */

export type PythonRuntimeErrorCode =
  | 'MANIFEST_INVALID'
  | 'ARCHIVE_MISSING'
  | 'CHECKSUM_MISMATCH'
  | 'EXTRACT_FAILED'
  | 'ENTRYPOINT_MISSING'
  | 'RUNTIME_UNAVAILABLE'
  | 'CACHE_UNWRITABLE'

export class PythonRuntimeError extends Error {
  readonly code: PythonRuntimeErrorCode

  constructor(code: PythonRuntimeErrorCode, message: string) {
    super(message)
    this.name = 'PythonRuntimeError'
    this.code = code
  }
}

export interface Logger {
  warn(message: string, ...args: unknown[]): void
  info?(message: string, ...args: unknown[]): void
}

/** 单个平台的运行时归档条目（随包装本地文件名）。 */
export interface PythonRuntimePlatformEntry {
  archiveName: string
  sha256: string
  size?: number
  /** 解释器相对入口（相对 dependencies/python 根，如 bin/python3 或 python.exe）。 */
  entrypoint: string
}

/**
 * 运行时 manifest（schema v2，多平台 combined）—— 一份 manifest 列出所有平台，
 * 运行时按本机 `expectedPlatform()` 自选对应条目。这样"每架构独立包"与
 * "单包多架构 / universal"用同一套机制，无需按构建目标烘焙不同 manifest。
 * 纯数据结构，不含业务语义。
 */
export interface PythonRuntimeManifest {
  schemaVersion: 2
  runtimeKind: 'python'
  version: string
  platforms: Record<string, PythonRuntimePlatformEntry>
}

export interface ResolvedPythonRuntime {
  /** dependencies/python 根目录绝对路径 */
  root: string
  /** 解释器绝对路径（root + entrypoints.python） */
  pythonPath: string
  version?: string
  /** 命中来源，便于宿主观测 / 诊断 */
  origin: 'explicit' | 'packaged' | 'bundled-archive' | 'cache'
}

/**
 * ensurePythonRuntime 的全部输入 —— 由 L1 适配层注入。
 * L0 内部绝不读取 process.env 业务变量、绝不硬编码远程分发地址或 codex 路径。
 */
export interface PythonRuntimeConfig {
  /** 自管运行时缓存根（L1 用 os cache dir 计算注入），必填 */
  cacheDir: string
  /** 显式指定的现成运行时目录（如 L1 从 TABTIN_PYTHON_RUNTIME_DIR 读到），最高优先 */
  explicitRoots?: string[]
  /**
   * 候选根：内含 bundled manifest.json 与同目录归档。
   * Electron 传 resourcesPath/native/tabtin-python-runtime 与 dev 仓库 packages/python-runtime/runtime。
   */
  packagedRoots?: string[]
  /** 覆盖 tar 命令（默认按平台推断）；测试可注入 */
  tarCommand?: string
  logger?: Logger
}
