/**
 * PlatformSurface 核心类型定义。
 *
 * 这是 contract 项目 Wave 3 的心脏——一份 service 声明式定义后自动
 * 获得 IPC + HTTP 双 binding，handler 只写一次。后续 W4-W7 全部以
 * 此文件的类型为骨架。
 *
 * 设计要点：
 *   - D-4 命名 PlatformSurface（不用 Capability，避免跟 agent-runtime
 *     已有的 hooks/tools 单元撞名）
 *   - D-5 module/verb 是权威 ID，IPC channel / HTTP path / CLI 命令
 *     全部从这对 ID 派生
 *   - D-6 ProxiedSurface 类型层禁 IPC binding（通过条件类型强制编译
 *     错误）
 *   - D-7 stream/WS out of scope，本方案只覆盖 request-response
 */

import type { DjangoRequestFn } from '../errors.js'

// ─── Surface 运行时上下文 ────────────────────────────────────────────

/**
 * Surface handler 执行时注入的运行时上下文。
 *
 * 由 binding adapter（IPC / HTTP）从宿主获取并传入 handler，handler
 * 不需要自己关心"我是从 IPC 还是 HTTP 调进来的"——这是 PlatformSurface
 * 框架的核心价值。
 *
 * 复用 cli-server-core 的 `DjangoRequestFn` 类型（errors.ts），
 * 与 cli-routes `configureCLIRoutes` 注入模式对齐（cli-routes 同样从此处再导出）。
 */
export interface SurfaceContext {
  /** Django HTTP 代理函数，用于与后端通信 */
  djangoRequest: DjangoRequestFn
  /** 当前 Space ID（可能为 null，譬如全局设置页面没有 Space 上下文） */
  spaceId: string | null
}

// ─── Surface 元信息 ─────────────────────────────────────────────────

/**
 * Surface 种类：local 是本地能力（文件操作、终端等），proxied 是
 * 纯代理到 Django 的能力（agent 设置、organization 配置等）。
 *
 * 设计决策 D-6：proxied 的 IPC binding 必须为 false——状态变更类
 * 操作一律走 renderer → store action → api-proxy → Django，不允许
 * IPC 旁路。类型层通过 SurfaceBindings 条件类型强制。
 */
export type SurfaceKind = 'local' | 'proxied'

/**
 * Surface 的 binding 声明。
 *
 * D-6 类型层强制：当 K 为 'proxied' 时，ipc 只能是 false。
 * 这让 `definePlatformSurface({ kind: 'proxied', bindings: { ipc: true } })`
 * 直接编译报错，把"不允许 IPC 旁路"从团队纪律升级成工具强制。
 *
 * http 支持 boolean 快捷方式和详细配置对象两种形态：
 *   - `true`：默认 POST + 自动路径 `/${module}/${verb}`
 *   - `{ method: 'GET', path: '/custom/path' }`：自定义方法和路径
 */
export type SurfaceBindings<K extends SurfaceKind> = {
  ipc: K extends 'local' ? boolean : false
  http: boolean | { method?: 'GET' | 'POST'; path?: string }
}

// ─── Surface 定义 ───────────────────────────────────────────────────

/**
 * PlatformSurface 的完整定义——开发者声明一个 surface 时填的东西。
 *
 * 类型参数说明：
 *   - K: SurfaceKind — 'local' | 'proxied'
 *   - I: handler 输入类型
 *   - O: handler 输出类型（成功时 data 的形状）
 *   - ECodes: 该 surface 的业务错误码闭集（字符串字面联合）
 *
 * 业务错误码闭集（D-5 / §五 [P2] errorCodes）：每个 surface 声明自己
 * 可能抛出的错误码，类型层保证 SurfaceError.code 只能是这些值之一。
 * W6 把 CliErrorCode 的 `(string & {})` 松散分支替换成 per-surface 联合
 * 后，"写错码名编译不过"的承诺就完全落地。
 */
export interface PlatformSurfaceDef<
  K extends SurfaceKind,
  I,
  O,
  ECodes extends string,
> {
  /** D-5 权威模块名，如 'chat'、'workspace'。格式：[a-z][a-z0-9-]* */
  module: string
  /** D-5 权威动作名，如 'export-md'、'list'。格式：[a-z][a-z0-9-]* */
  verb: string
  /** surface 种类：local（本地能力）或 proxied（代理到 Django） */
  kind: K
  /** 该 surface 可能抛出的业务错误码闭集 */
  errorCodes: readonly ECodes[]
  /** 业务 handler——唯一实现，IPC / HTTP 双 binding 共用 */
  handler: (input: I, ctx: SurfaceContext) => Promise<O>
  /** binding 声明——哪些通道注册 */
  bindings: SurfaceBindings<K>
  /** 别名列表（module:verb 格式），用于迁移期间保持旧 channel 可用 */
  aliases?: string[]
  /**
   * Risk 标注（L20e / W7.1）。与 Go CLI 端 `cmdutil.CommandDef.Risk` 对齐：
   *   - `''` / `'none'`：只读 / 无副作用（默认；如 chat-export-md 只导出快照）
   *   - `'write'`：会修改用户数据（如 skill-install）
   *   - `'high-risk-write'`：不可逆 / 高破坏（删除、清空）
   *
   * 用途：受限模式 shell allowlist 把 surface 也纳入决策——`tabtin invoke <module>
   * <verb>` 也走同样的 risk gate，避免 LLM 用 surface 路径绕过 CLI 的 risk 检查。
   * 不声明默认按 RiskNone 处理——但鼓励显式声明，让审计可读。
   */
  risk?: '' | 'none' | 'write' | 'high-risk-write'
  /**
   * 弃用声明——标记后注册时 logger.warn，W4 codegen 在生成的 cobra
   * 命令里加 deprecated 提示，W5 audit log 标记弃用调用。
   */
  deprecated?: {
    /** 弃用起始版本号 */
    since: string
    /** 替代的 module:verb */
    replacedBy: string
    /** 移除目标版本号 */
    removeAfter: string
  }
}

// ─── SurfaceError ───────────────────────────────────────────────────

/**
 * handler 抛业务错误的载体。
 *
 * 与通用 Error 的区别：
 *   - code 是 surface 声明的 errorCodes 闭集中的值
 *   - detail 是结构化诊断 payload（譬如 SOFT_FAIL 的 `{fallback, reason}`）
 *   - binding adapter（IPC / HTTP）捕获后用 errResponse 包装成 envelope
 *
 * handler 抛出 SurfaceError → adapter 翻译成 `{ok:false, error:{code, message, detail}}`
 * handler 抛出其它错误   → adapter 翻译成 `{ok:false, error:{code:'INTERNAL_ERROR', message}}`
 */
export class SurfaceError<E extends string = string> extends Error {
  readonly code: E
  readonly detail?: Record<string, unknown>

  constructor(code: E, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'SurfaceError'
    this.code = code
    this.detail = detail
    /**
     * TypeScript 编译到 ES5 时 extends Error 的子类 instanceof 检查
     * 会失败（原型链断裂）。显式设置原型链保证 IPC / HTTP adapter 内
     * `err instanceof SurfaceError` 在所有构建目标下都正确。
     */
    Object.setPrototypeOf(this, SurfaceError.prototype)
  }
}

// ─── 注册后的 Surface ───────────────────────────────────────────────

/**
 * 注册后的 surface——从 definePlatformSurface 返回、存入全局 registry。
 *
 * 所有字段 readonly（Object.freeze），一旦注册不可修改。消费方
 * （IPC adapter / HTTP adapter / W4 codegen / W5 audit log）通过
 * registry 查询拿到这个对象。
 */
export interface RegisteredSurface<
  K extends SurfaceKind = SurfaceKind,
  I = unknown,
  O = unknown,
  ECodes extends string = string,
> {
  /** IPC channel 名：`${module}:${verb}`（D-5 权威 ID 派生） */
  readonly channel: string
  /** HTTP 路径：`/${module}/${verb}`（D-5 权威 ID 派生） */
  readonly httpPath: string
  /** 原始定义（冻结后不可修改） */
  readonly def: Readonly<PlatformSurfaceDef<K, I, O, ECodes>>
}
