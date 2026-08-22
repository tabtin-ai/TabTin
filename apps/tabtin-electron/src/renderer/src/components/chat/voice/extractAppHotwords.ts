/**
 * 从当前 workspace/space 状态中提取 app 级热词。
 *
 * 与 iOS VoiceConfig.extractHotwords 对齐：
 * 将 workspace 名称、space 名称等切分为独立词汇作为热词。
 */

import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useSpaceStore } from '@/stores/useSpaceStore'

export function extractAppHotwords(): string[] {
  const words: string[] = []

  const organization = useOrganizationStore.getState().selectedOrganization
  if (organization?.name) {
    words.push(...splitIntoWords(organization.name))
  }

  const space = useSpaceStore.getState().selectedSpace
  if (space?.name) {
    words.push(...splitIntoWords(space.name))
  }

  return [...new Set(words.filter(w => w.length >= 2))]
}

function splitIntoWords(text: string): string[] {
  const words = text
    .split(/[\s,;|·—\-_/\\]+/)
    .map(w => w.trim())
    .filter(Boolean)

  const result = [...words]
  if (words.length > 1) {
    result.push(text.trim())
  }

  return result
}
