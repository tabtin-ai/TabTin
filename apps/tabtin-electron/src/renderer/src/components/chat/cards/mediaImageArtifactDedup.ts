import type { ContentBlockEntry } from '../blocks/types'

export function hasFormalMediaImageArtifactForTool(
  blocksRecord: Record<string, ContentBlockEntry[]>,
  sourceToolUseId: string | undefined,
): boolean {
  if (!sourceToolUseId) return false
  return Object.values(blocksRecord).some((entries) => entries.some((entry) => {
    const block = entry.block as {
      type?: string
      kind?: string
      payload?: Record<string, unknown>
    } | null
    return block?.type === 'tabtin_rich_content'
      && block.kind === 'image'
      && block.payload?.artifact_kind === 'oss_file'
      && block.payload?.source_tool_use_id === sourceToolUseId
  }))
}
