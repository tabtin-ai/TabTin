/**
 * DynamicToolManager — skill 触发时的关联工具动态注入 (T-P1-7)
 *
 * 对应 Django `DynamicToolManager` (`apps/services/tools/dynamic_tools.py`)：
 * - activate(toolNames) → 从 ToolProvider 查找匹配工具 → 加入动态 schema 列表
 * - evictStale(iteration) → 超 TTL 未使用则移除 schema（保留实例可复活）
 * - recoverFromMessages(messages) → resume 时从历史 tool_use 恢复
 *
 * 与 query.ts 的集成方式：
 * - toolParams = staticTools + dynamicToolManager.getActivatedTools()
 */

import type {
  Message,
  ContentBlock,
} from '../contracts/conversation.js';
import type {
  Tool,
  ToolProvider,
} from '../contracts/tools.js';

/**
 * TTL（iterations），超过这个轮次未使用的动态工具会被 `evictStale` 驱逐。
 * 导出为常量让测试/宿主能引用，不要硬编码 8。
 */
export const DEFAULT_STALE_TTL = 8;

interface ActivatedEntry {
  tool: Tool;
  activatedAtIteration: number;
  lastUsedIteration: number;
}

export class DynamicToolManager {
  private activated = new Map<string, ActivatedEntry>();

  /**
   * 从 provider 中查找 toolNames 匹配的工具，加入动态列表。
   * 已激活的工具只更新 activation 时间戳，不重复加入。
   */
  activate(toolNames: string[], provider: ToolProvider, currentIteration: number): string[] {
    const newlyActivated: string[] = [];
    const available = provider.getTools();
    const toolMap = new Map(available.map(t => [t.name, t]));

    for (const name of toolNames) {
      if (this.activated.has(name)) {
        const entry = this.activated.get(name)!;
        entry.lastUsedIteration = currentIteration;
        continue;
      }

      const tool = toolMap.get(name);
      if (tool) {
        this.activated.set(name, {
          tool,
          activatedAtIteration: currentIteration,
          lastUsedIteration: currentIteration,
        });
        newlyActivated.push(name);
      }
    }

    return newlyActivated;
  }

  /**
   * 返回当前所有动态激活的工具 schema（合并到 toolParams 发给 LLM）。
   */
  getActivatedTools(): Tool[] {
    return Array.from(this.activated.values()).map(e => e.tool);
  }

  /** O(1) 按名字查找已激活的单个工具。 */
  getTool(name: string): Tool | undefined {
    return this.activated.get(name)?.tool;
  }

  /**
   * 返回当前激活的工具名列表。
   */
  getActivatedToolNames(): string[] {
    return Array.from(this.activated.keys());
  }

  /**
   * 标记工具被使用（延长 TTL）。
   * query.ts 在工具执行完毕后调用。
   */
  recordUsage(toolName: string, iteration: number): void {
    const entry = this.activated.get(toolName);
    if (entry) {
      entry.lastUsedIteration = iteration;
    }
  }

  /**
   * 驱逐超过 TTL 未使用的动态工具（从 schema 列表移除）。
   * 每轮 iteration 末尾调用。
   */
  evictStale(currentIteration: number, ttl: number = DEFAULT_STALE_TTL): string[] {
    const evicted: string[] = [];
    for (const [name, entry] of this.activated) {
      if (currentIteration - entry.lastUsedIteration >= ttl) {
        this.activated.delete(name);
        evicted.push(name);
      }
    }
    return evicted;
  }

  /**
   * 从历史消息中恢复动态工具状态（resume 场景）。
   * 扫描所有 tool_use block，找到不在 static tools 里但在 provider 中的工具。
   *
   * 当前架构限制：staticToolNames 来自 config.tools.getTools()，这也是
   * activate 查找的来源。所以目前只有当 provider 包含 shouldDefer 工具时
   * （Phase 3 T-P1-1 延迟加载）recovery 才会真正有效——deferred 工具在
   * staticToolNames 里但不在初始 toolParams 里，recovery 可以重新激活它们。
   *
   * Wave 2g review 防御性修正：`currentIteration` 可选参数。当前 query.ts
   * 的 `state.iteration` 总是从 0 起步，所以把 `lastUsedIteration` 设为 0
   * 是合适的——但如果未来把 iteration 跨 session 持久化（比如 checkpoint
   * 保留了 state 快照），默认 0 会让刚恢复的工具立刻被 evictStale 吞掉。
   * 新签名让调用方显式传当前 iteration，避免未来踩坑。
   */
  recoverFromMessages(
    messages: Message[],
    provider: ToolProvider,
    staticToolNames: Set<string>,
    currentIteration: number = 0,
  ): string[] {
    const usedToolNames = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use') {
          usedToolNames.add(block.name);
        }
      }
    }

    // 只恢复不在 static tools 里的工具
    const toRecover = Array.from(usedToolNames).filter(n => !staticToolNames.has(n));
    if (toRecover.length === 0) return [];

    return this.activate(toRecover, provider, currentIteration);
  }

  /**
   * 检查某个工具是否已动态激活。
   */
  has(toolName: string): boolean {
    return this.activated.has(toolName);
  }

  get size(): number {
    return this.activated.size;
  }

  /** 清空所有动态工具（测试 / 重置用）。 */
  clear(): void {
    this.activated.clear();
  }
}
