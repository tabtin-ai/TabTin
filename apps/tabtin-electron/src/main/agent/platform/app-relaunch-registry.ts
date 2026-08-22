/**
 * App relaunch registry —— 让 relaunch_app 工具的 beforeRelaunch 钩子
 * 复用主进程已有的 exit-guard（合并 dirty 对话框）。
 *
 * 时序问题：
 *   - main-app.ts 在主进程启动早期创建 exitGuard，并把它的 ask 包装进
 *     beforeRelaunch hook。
 *   - ElectronAgentHost / ElectronToolProvider 是惰性创建（首次
 *     createRuntimeForSession 时才装配 ToolProvider），那时 hook 已就位。
 *
 * 因此本 registry 的写入方（main-app.ts）和读取方（ElectronAgentHost）
 * 时序天然安全：写入 → 读取，二者跨多个 deferred-init 阶段。
 *
 * 不在 ElectronAgentHost 上加构造期入参：
 *   - electronAgentHost 是 module-level singleton，构造时拿不到 exitGuard
 *     （exitGuard 还没创建）；
 *   - 用 setter 又会让 ElectronAgentHost 类型签名变重。
 *   - 用 module-level registry 把"hook 何时设置 / 何时被读"解耦，是最轻的接缝。
 */

let _appBeforeRelaunch: (() => Promise<void>) | undefined

/**
 * 注册"重启前的 unsaved 状态保护"钩子。典型实装：
 *
 * ```ts
 * setAppBeforeRelaunch(async () => {
 *   const choice = await exitGuard.ask('app-quit')
 *   if (choice === 'cancel') {
 *     throw new Error('relaunch_aborted_by_user')
 *   }
 * })
 * ```
 *
 * - 钩子返回 Promise<void> → 视为"可以重启"，system-tools 继续 fire-and-forget
 *   `app.relaunch()`。
 * - 钩子抛错 → relaunch_app 工具返回 `status: 'aborted'`，LLM 看到后
 *   不会硬重启，会把"用户取消"信息说回给用户。
 *
 * 多次调用以最后一次为准（典型只调一次；测试需要清理时传 undefined）。
 */
export function setAppBeforeRelaunch(fn: (() => Promise<void>) | undefined): void {
  _appBeforeRelaunch = fn
}

/**
 * 取当前钩子值——供 ElectronAgentHost 在创建 ElectronToolProvider 时透传给
 * createSystemTools。
 *
 * **读取时机语义**：本函数在 createRuntimeForSession 一次性被调，结果会被
 * snapshot 到 `ElectronToolProvider.beforeRelaunch` 字段（构造期赋值，后续
 * getTools() 闭包捕获使用）。换言之：
 *
 *   - 测试场景：先 setAppBeforeRelaunch(mockA) → 触发 createRuntime → 用 mockA。
 *     之后再 setAppBeforeRelaunch(mockB) **不影响**这个 runtime 的 toolProvider，
 *     mockB 仅对**新创建**的 runtime 生效。
 *   - 生产场景：main-app.ts 启动时一次性 set，runtime 实例一次性 read，无热替换。
 *
 * 如果未来需要热替换（如 UI 切换 unsaved 行为开关），应改为传 provider 闭包
 * `() => getAppBeforeRelaunch()` 给 ToolProvider，让 getTools() 每次重新读取。
 */
export function getAppBeforeRelaunch(): (() => Promise<void>) | undefined {
  return _appBeforeRelaunch
}

/** 测试 / 进程退出清理用 —— 重置为未注册状态。 */
export function _resetAppBeforeRelaunch(): void {
  _appBeforeRelaunch = undefined
}
