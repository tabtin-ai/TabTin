/**
 * Composer 预设块 → prompt 文本 / skill 调用的解析（原 sendMessageHelpers 拆出）。
 *
 * 纯函数：把 composer_preset 内容块渲染成给 Agent 的 markdown 请求，或提取其
 * skill 调用意图。不触碰 store / 网络。
 */
function formatComposerPresetValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function resolveComposerPresetPrompt(
  blocks: Array<Record<string, unknown>>,
): string {
  const presetBlocks = blocks.filter(b => b.type === 'composer_preset')
  if (presetBlocks.length === 0) return ''

  return presetBlocks.map((block) => {
    const presetId = typeof block.preset_id === 'string' && block.preset_id.trim()
      ? block.preset_id.trim()
      : 'unknown'
    const params = block.params && typeof block.params === 'object'
      ? block.params as Record<string, unknown>
      : {}
    const triggerContext = block.trigger_context && typeof block.trigger_context === 'object'
      ? block.trigger_context as Record<string, unknown>
      : {}

    const renderedPrompt = formatComposerPresetValue(params.rendered_prompt)
    if (renderedPrompt) {
      return [
        `## 用户预设请求: \`${presetId}\``,
        renderedPrompt,
      ].join('\n')
    }

    const parts = [`## 用户预设请求: \`${presetId}\``]
    const triggerLines = Object.entries(triggerContext)
      .map(([key, value]) => `- ${key}: ${formatComposerPresetValue(value)}`)
      .filter(line => !line.endsWith(': '))
    if (triggerLines.length > 0) {
      parts.push('**触发场景**:')
      parts.push(...triggerLines)
    }

    const paramLines = Object.entries(params)
      .filter(([key]) => !key.endsWith('_file_id') && !key.endsWith('_file_ids'))
      .map(([key, value]) => `- ${key}: ${formatComposerPresetValue(value)}`)
      .filter(line => !line.endsWith(': '))
    if (paramLines.length > 0) {
      parts.push('**用户填写的参数**:')
      parts.push(...paramLines)
    }

    parts.push('请按上述参数和场景完成用户的意图。')
    return parts.join('\n')
  }).filter(Boolean).join('\n\n')
}

export function resolveComposerPresetSkillInvoke(
  blocks: Array<Record<string, unknown>>,
): { skillKey: string; args?: string } | null {
  for (const block of blocks) {
    if (block.type !== 'composer_preset') continue
    const params = block.params && typeof block.params === 'object'
      ? block.params as Record<string, unknown>
      : {}
    const skillKey = typeof params.skill_key === 'string' ? params.skill_key.trim() : ''
    if (skillKey) return { skillKey }
  }
  return null
}
