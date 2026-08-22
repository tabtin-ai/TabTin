/**
 * Agent.preferred_model_id 写入序号。
 *
 * setPreferredModel 是 fire-and-forget PATCH；快速连续切换时较早的请求可能后到，
 * 把服务端盖回旧模型。用 per-agent epoch 识别陈旧完成，并在必要时用最新乐观值纠偏。
 */

const epochByAgent = new Map<string, number>()

/** 平台模型 UUID；本机 Codex id（如 gpt-5.6-sol）不得写入 preferred_model_id。 */
const PLATFORM_MODEL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isPersistablePreferredModelId(modelId: string): boolean {
  return PLATFORM_MODEL_UUID_RE.test(modelId.trim())
}

export function nextPreferredModelEpoch(agentId: string): number {
  const next = (epochByAgent.get(agentId) ?? 0) + 1
  epochByAgent.set(agentId, next)
  return next
}

export function isCurrentPreferredModelEpoch(agentId: string, epoch: number): boolean {
  return epochByAgent.get(agentId) === epoch
}

/** 单测用：清空序号表。 */
export function resetPreferredModelWriteEpochsForTests(): void {
  epochByAgent.clear()
}
