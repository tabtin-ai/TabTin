/**
 * @tabtin/desktop-contracts —— TabDesktop 接口契约 + MCP 命名空间常量。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5（v2.0 占位 → v2.1 落地）。
 *
 * 这个包**只导出类型 + 常量**，不含运行时实现，不依赖 electron / node。
 * 任何宿主（Electron 主进程、未来的 Daemon、未来的 MCP server）只要实现
 * `DesktopExecutor` 接口即可对外提供 TabDesktop 能力——这是模块零的"地基"
 * 价值，让后面 5 个模块（M1 / M2 / M3a / M3b / M3c / M4）在加方法 / 加字段
 * 时不需要重新定义"什么是 TabDesktop 执行器"。
 */

export * from './session-context.js'
export * from './executor.js'
export * from './authorization-profile.js'
export * from './sub-gates.js'
export * from './coordinate-mode.js'
export * from './mcp-namespace.js'
export * from './accessibility.js'
