/**
 * 跨轮记忆 · Feature flag（宿主无关版）。
 *
 * 从 Electron renderer 下沉而来。原位置：
 * apps/tabtin-electron/src/renderer/src/stores/chat/utils/crossTurnMemory.ts
 *
 * 核心变化：去掉对 import.meta.env（Vite 专用）的依赖，改为可注入的
 * envReader 函数。各宿主负责提供自己的环境变量读取方式：
 *   - Electron renderer: () => import.meta.env.VITE_DISABLE_CROSS_TURN_MEMORY
 *   - Daemon / Node:     () => process.env.DISABLE_CROSS_TURN_MEMORY
 *   - 测试:              () => testValue
 */

import type { CrossTurnMemoryConfig } from './types.js';

/**
 * 环境变量读取函数。返回 kill switch 的字符串值，
 * 返回 undefined 表示未设置。
 */
export type EnvKillSwitchReader = () => string | undefined;

/**
 * 判断是否为当前 Agent 启用跨轮记忆。
 *
 * 决策优先级（高到低）：
 * 1. envReader 返回 '1' 或 'true' → false（紧急 kill switch）
 * 2. agentConfig.cross_turn_memory === false → false（单 Agent 豁免）
 * 3. 默认 → true
 */
export function isCrossTurnMemoryEnabled(
  agentConfig?: CrossTurnMemoryConfig | null,
  envReader?: EnvKillSwitchReader,
): boolean {
  if (envReader) {
    try {
      const envValue = envReader();
      if (typeof envValue === 'string') {
        const normalized = envValue.trim().toLowerCase();
        if (normalized === '1' || normalized === 'true') return false;
      }
    } catch {
      // 环境读取失败不应阻塞整条发送路径
    }
  }

  if (agentConfig?.cross_turn_memory === false) return false;

  return true;
}
