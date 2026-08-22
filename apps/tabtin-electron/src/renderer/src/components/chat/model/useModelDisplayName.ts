import { useChatModelStore } from '@/stores/useChatModelStore'

/**
 * 把模型 id 映射成 UI 显示名（`display_name` → `name` → 原值兜底）。
 *
 * 子 Agent 卡片用：runtime 把子 Agent 实际模型解析成 `childModel`（模型 id /
 * UUID），无论实时事件（`SUBAGENT_STARTED.speaker.model`）还是归档重建
 * （`subagents.jsonl` 的 `model`）带的都是这个 id——直接渲染会是一串裸 UUID。
 * 这里按 `useChatModelStore.availableModels` 反查显示名；查不到（模型不在当前
 * 可用清单 / 传的是 alias）时回落原值，不丢信息。
 */
export function useModelDisplayName(modelId: string | undefined | null): string | undefined {
  return useChatModelStore((s) => {
    if (!modelId) return undefined
    const model = s.availableModels.find((m) => m.id === modelId)
    return model?.display_name || model?.name || modelId
  })
}
