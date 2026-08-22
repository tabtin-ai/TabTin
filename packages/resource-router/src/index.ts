/**
 * @tabtin/resource-router — barrel.
 *
 * 三种 Agent 输出形式（增强 markdown / open_in_space 工具 / 富 ResourceCard）
 * 共享同一个 `ResourcePointer` 数据结构 + 同一个 `ResourceRouter.open` 落点。
 *
 * 入口列表：
 *   - 类型契约      → `./types`
 *   - 字符串解析    → `./parser`
 *   - manifest 注册 → `./registry`
 *   - 派发主逻辑    → `./router`
 *   - 埋点事件      → `./events`
 */

export * from './types.js'
export * from './parser.js'
export * from './environment.js'
export * from './registry.js'
export * from './router.js'
export * from './events.js'
