/**
 * Vault 通用类型。
 *
 * 「凭据」面板（浏览器 / AI 服务 / 应用）共用一套 master-detail 视觉与交互。
 * 每个面板有自己的数据形态，但都映射到 VaultRow 这个统一 contract，由通用的
 * VaultList / VaultDetail / VaultToolbar 渲染。
 */

import type React from 'react'

/** 列表行的统一形态（语义型字段，UI 不直接看原始数据） */
export interface VaultRow<T = unknown> {
  /** 唯一 id（跨 panel 不需唯一，仅 list 内） */
  id: string
  /** 用于 favicon fallback 的 host 或品牌名 */
  faviconKey: string
  /** 主标题（如 "OpenAI" / ".baidu.com" / "Lark"） */
  primary: string
  /** 副标题（如 "sk-***Abc" / "9 个 Cookie" / "com.lark.app"） */
  secondary: string
  /** 右侧角标（warning / disabled / verified 等） */
  badges?: VaultBadge[]
  /** 一级图标（密码用 KeyRound、cookie 用 Globe、应用用 Smartphone……） */
  kindIcon?: React.ReactNode
  /** 透传给详情面板的原始数据 */
  raw: T
}

export interface VaultBadge {
  kind: 'warning' | 'disabled' | 'verified'
  label?: string
}

/** 顶部 filter chip 配置 */
export interface VaultFilterOption<F extends string> {
  value: F
  label: string
  count: number
  /** 数量为 0 时是否隐藏（默认 false） */
  hideWhenZero?: boolean
}
