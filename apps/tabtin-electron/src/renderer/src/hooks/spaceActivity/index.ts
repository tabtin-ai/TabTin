/**
 * Space activity scoped effect hooks
 *
 * 这一组 hook 把"按 Space 活动作用域自动启停 effect"的样板代码包了起来——
 * 默认按 `isForeground` 控制（前台才跑），可通过 `scope: 'hot'` 选项让 hot
 * 状态也保活。
 *
 * 使用场景：
 * - **`foreground`（默认）**：UI 渲染相关 effect、用户输入响应、动画、
 *   虚拟列表、滚动跟随、composer 注入等"用户看不到就没必要跑"的事
 * - **`hot`**：IPC 推送订阅、消息流监听、Run 心跳等"切走也希望保活"的事
 *
 * ## 设计取向
 *
 * 这些 hook 是 React 19.2 `<Activity>` 的**业务语义层补充**——`<Activity>`
 * 在调度层兜住默认安全（hidden 时所有 effect 自动 cleanup），这一层让你
 * 能精细表达「即使后台也要继续跑」的少数场景。
 *
 * ## 何时**不**用这一组 hook
 *
 * - 全局 module-level 副作用（应用启动时初始化的 IPC 单例）→ 不该挂在
 *   组件 effect 里
 * - 真"卸载时才清理"的资源生命周期（Run / 跨 Space 联动）→ 不该
 *   归 Activity 子树管，应提到 store 层
 * - `element.addEventListener`（element 是 ref 拿到的 DOM）→ 元素离开 DOM
 *   时自然回收，原生 useEffect 即可
 * - 一次性瞬时 `setTimeout`（< 1s）→ 直接用原生 setTimeout
 *
 * 见 [`README.md`](./README.md) 完整指南、6 hook 速查、`scope` 选择决策表。
 * 设计动机见 [`SpaceActivityContext`](./../../components/layout/SpaceActivityContext.tsx)。
 *
 * ## 关联 lint 规则
 *
 * `tabtin/prefer-scoped-activity-effects`（warn，仅 renderer）在 `useEffect` 内
 * 识别裸用 `window.addEventListener` / `setInterval` / `new ResizeObserver` 等
 * 模式时会引导你走这里的包装。详见 `eslint-rules/prefer-scoped-activity-effects.js`。
 */

export type { ActivityScope, ScopedHookOptions } from './types'
export { useScopedEffect } from './useScopedEffect'
export { useScopedEventListener } from './useScopedEventListener'
export { useScopedInterval } from './useScopedInterval'
export { useScopedTimeout } from './useScopedTimeout'
export { useScopedResizeObserver } from './useScopedResizeObserver'
export { useScopedSubscribe } from './useScopedSubscribe'
