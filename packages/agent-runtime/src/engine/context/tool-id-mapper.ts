/**
 * TabTin 权威 tool_use id 映射。
 *
 * 上游模型（如 Kimi）常返回 `{tool_name}_{n}`，会话内会回绕撞号；
 * fork 若原样拷贝这些 id，子会话会与父系命名空间叠在一起。
 *
 * 契约：
 * - 持久层 / state.messages / HITL / transcript **只存** TabTin id（`tu_<uuid>`）
 * - 模型原始 id 仅作本轮流式别名，不写入配对逻辑
 * - 同一轮 SSE 内同一 modelId 必须稳定映射到同一 tabtinId（delta 复用）
 * - 不同调用即使 modelId 字符串相同，也必须是新的 tabtinId
 *   （实现：每个 LLM 请求 / 每个 fork 作业使用独立 Mapper 实例）
 */

import { v4 as uuidv4 } from 'uuid';

const TABTIN_TOOL_ID_PREFIX = 'tu_';

export function isTabtinToolUseId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(TABTIN_TOOL_ID_PREFIX);
}

export function allocateTabtinToolUseId(): string {
  return `${TABTIN_TOOL_ID_PREFIX}${uuidv4()}`;
}

/**
 * 单次 LLM 流（或单次 fork 作业）内的 modelId → tabtinId 映射表。
 */
export class ToolIdMapper {
  private readonly modelToTabtin = new Map<string, string>();

  constructor(seed?: Readonly<Record<string, string>>) {
    if (!seed) return;
    for (const [oldId, newId] of Object.entries(seed)) {
      if (typeof oldId === 'string' && oldId && typeof newId === 'string' && newId) {
        this.modelToTabtin.set(oldId, newId);
      }
    }
  }

  /**
   * 将上游 tool_call / tool_use id 映射为 TabTin 权威 id。
   * 空 modelId 时直接分配新 id（不写入别名表）。
   */
  allocate(modelId: string | undefined | null): string {
    const key = typeof modelId === 'string' ? modelId.trim() : '';
    if (!key) return allocateTabtinToolUseId();
    // 已是 TabTin id（例如历史回放又过一遍）——保持不变，避免二次改写
    if (isTabtinToolUseId(key)) {
      this.modelToTabtin.set(key, key);
      return key;
    }
    const existing = this.modelToTabtin.get(key);
    if (existing) return existing;
    const tabtinId = allocateTabtinToolUseId();
    this.modelToTabtin.set(key, tabtinId);
    return tabtinId;
  }

  /** 测试 / 诊断：当前别名表大小 */
  get size(): number {
    return this.modelToTabtin.size;
  }
}
