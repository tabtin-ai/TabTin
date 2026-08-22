/**
 * SpaceActivityContext — Space 生命周期的业务语义层
 *
 * ## 设计动机
 *
 * `SpaceChatRailHost` / `SpaceWorkbenchHost` 同时挂载多个 hot Space 的子树，
 * 切换 Space 时不卸载（避免 unmount/remount 抖动）。但「挂载着」不等于「应该
 * 跑所有 effect」——后台 Space 的 UI 渲染相关 effect 应该暂停，节省 CPU；
 * 业务订阅则按需保活。
 *
 * 这个 Context 把 Space 的生命周期暴露成业务语义三态：
 *
 *   - `foreground`     —— 用户当前操作的 Space（前台）
 *   - `background-hot` —— 仍挂载在 DOM 中但用户看不到（hot 缓存）
 *   - `background-cold` —— 已驱逐 / 即将卸载（实际上 cold 时组件已不挂载，
 *     这个值仅作为 Provider 之外的兜底）
 *
 * ## 与 React 19.2 `<Activity>` 的关系
 *
 * - `<Activity>`（调度层）：负责「默认暂停」——hidden 时整棵子树的 effect
 *   走 cleanup，visible 时重建。粗、可靠、不可绕过。
 * - `useSpaceActivity()`（业务语义层）：表达「精细意图」——某些副作用即使
 *   Space 在后台（hot）也应该保活（IPC 订阅、Run 状态、跨 Space 联动）。
 *
 * 两层互补：调度层兜住 90% 的 UI 渲染相关 effect；业务层用 `isForeground` /
 * `isHot` 显式 opt-in 那少数需要 hot 状态保活的副作用。
 *
 * ## 字段语义
 *
 * - `activity`      —— 原始三态枚举
 * - `isForeground`  —— 当前用户操作的 Space（替代旧的 isActive /
 *                       allowForegroundEffects / allowInteraction，三者
 *                       原本同值，是混乱的「假独立轴」）
 * - `isHot`         —— 仍挂载（foreground 或 background-hot 都为 true）。
 *                       用于「即使在后台也应该保活」的副作用门控。
 *
 * ## Provider 之外的默认值
 *
 * 独立使用消费组件（不在 SpaceActivityProvider 子树内）时，默认返回
 * `foreground` 全开——保证组件单独渲染时不受 Space 生命周期影响。
 */

import React, { createContext, useContext, useMemo } from 'react'
import type { SpaceSceneActivity } from '@/stores/useWorkbenchSceneStore'

export interface SpaceActivityValue {
  /** 原始活动状态枚举 */
  activity: SpaceSceneActivity
  /** 当前用户操作的 Space（前台） */
  isForeground: boolean
  /** 仍挂载在 DOM 中（foreground 或 background-hot） */
  isHot: boolean
}

const SpaceActivityContext = createContext<SpaceActivityValue | null>(null)

export const SpaceActivityProvider: React.FC<{
  activity: SpaceSceneActivity
  children: React.ReactNode
}> = ({ activity, children }) => {
  const value = useMemo<SpaceActivityValue>(() => ({
    activity,
    isForeground: activity === 'foreground',
    isHot: activity !== 'background-cold',
  }), [activity])

  return (
    <SpaceActivityContext.Provider value={value}>
      {children}
    </SpaceActivityContext.Provider>
  )
}

const DEFAULT_FOREGROUND_VALUE: SpaceActivityValue = {
  activity: 'foreground',
  isForeground: true,
  isHot: true,
}

export function useSpaceActivity(): SpaceActivityValue {
  const value = useContext(SpaceActivityContext)
  return value ?? DEFAULT_FOREGROUND_VALUE
}
