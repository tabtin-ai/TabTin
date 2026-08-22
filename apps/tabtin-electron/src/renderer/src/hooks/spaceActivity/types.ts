/**
 * Space activity scope —— 副作用的"作用域"语义
 *
 * - `foreground` —— 仅在当前用户操作的 Space（前台）跑。**默认值**。
 *                   适用于：UI 渲染相关 effect（DOM measure、动画、虚拟列表、
 *                   滚动跟随）、模型选择、composer 输入注入等。
 *
 * - `hot`        —— 在前台或后台 hot 状态都跑。
 *                   适用于：业务订阅类（IPC 推送、消息流、Run 心跳）等
 *                   "切走也希望保活"的副作用。
 */
export type ActivityScope = 'foreground' | 'hot'

export interface ScopedHookOptions {
  /** 作用域。默认 'foreground'。 */
  scope?: ActivityScope
  /** 额外的本地开关——和 scope 是 AND 关系。默认 true。 */
  enabled?: boolean
}
