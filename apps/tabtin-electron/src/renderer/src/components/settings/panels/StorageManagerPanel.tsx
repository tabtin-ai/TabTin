/**
 * StorageManagerPanel — Settings 体系下的"存储管理"面板包装。
 *
 * 角色：
 *   - Settings 系统按 section 注册 panel；本文件是 settings 端的薄壳，
 *     真实业务组件在 `components/profile/StorageManager/index.tsx`；
 *   - 没有自己的 SettingsPanelHeader——StorageManager 内部有自带页眉和
 *     SettingsPanelLayout，避免双标题并让页眉位于滚动区外。
 */

import React from 'react'
import { StorageManager } from '@components/profile/StorageManager'

export const StorageManagerPanel: React.FC = () => {
  return <StorageManager />
}
