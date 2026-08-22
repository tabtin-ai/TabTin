import type { AgentEngineAttachment } from './types/agent-engine'

function hasTextContent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function hasValidImageSource(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return hasTextContent(record.url)
}

export function hasValidAgentEngineAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as AgentEngineAttachment
  if (record.type === 'image') return hasValidImageSource(record)
  return hasTextContent(record.url) || hasTextContent(record.file_id) || hasTextContent(record.filename)
}

function hasNonEmptyContextBlocks(contextBlocks: unknown): boolean {
  return Array.isArray(contextBlocks)
    && contextBlocks.some((block) => block != null && typeof block === 'object' && !Array.isArray(block))
}

export function hasAgentEngineUserInputContent(
  prompt: unknown,
  attachments: unknown,
  contextBlocks?: unknown,
): boolean {
  return hasTextContent(prompt)
    || (Array.isArray(attachments) && attachments.some(hasValidAgentEngineAttachment))
    || hasNonEmptyContextBlocks(contextBlocks)
}
