export type AgentToolIntent = 'spawn' | 'resume' | 'check' | 'wait' | 'unknown';

export interface NormalizedAgentToolIntentInput {
  intent: AgentToolIntent;
  prompt?: string;
  resumeAgentId?: string;
  checkAgentId?: string;
  /** 仅当 intent === 'wait' 时存在且非空。 */
  waitAgentIds?: string[];
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.map(normalizeString).filter((id): id is string => !!id),
  )].sort();
}

/**
 * `agent` 多态工具完整输入的共享意图契约。
 *
 * 可选字段被部分模型按 schema 填成空字符串或空数组，因此必须先归一化再按
 * runtime 优先级判断：wait → check → resume → spawn。调用方不得用字段是否存在
 * 作为意图依据。
 */
export function normalizeAgentToolIntentInput(input: unknown): NormalizedAgentToolIntentInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { intent: 'unknown' };
  }

  const record = input as Record<string, unknown>;
  const waitAgentIds = normalizeIdList(record.wait_agent_ids);
  const checkAgentId = normalizeString(record.check_agent_id);
  const resumeAgentId = normalizeString(record.resume_agent_id);
  const prompt = normalizeString(record.prompt);

  if (waitAgentIds.length > 0) {
    return { intent: 'wait', waitAgentIds };
  }
  if (checkAgentId) {
    return { intent: 'check', checkAgentId };
  }
  if (resumeAgentId) {
    return { intent: 'resume', resumeAgentId };
  }
  if (prompt) {
    return { intent: 'spawn', prompt };
  }
  return { intent: 'unknown' };
}

export function normalizeAgentToolString(value: unknown): string | undefined {
  return normalizeString(value);
}

export function normalizeAgentToolIdList(value: unknown): string[] {
  return normalizeIdList(value);
}
