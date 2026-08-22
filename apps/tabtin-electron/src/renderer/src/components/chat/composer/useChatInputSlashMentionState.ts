import { useState, useCallback, useEffect, useMemo } from 'react'
import { useSkillsListQuery } from '@/hooks/queries/skills'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { isSkillEnabledInCurrentSpace } from '@components/context-space/skills/skillPanelFilters'
import { resolveCurrentAgentId } from '../model/resolveAgentDisplayName'
import {
  buildSlashCommandOptions,
  detectSkillSlashQuery,
  replaceSkillSlashToken,
  type SlashCommandOption,
} from '../skill/skillSlashCommand'
import type { MentionItem } from '../types'

interface SlashMentionParams {
  input: string
  setInput: (value: string | ((prev: string) => string)) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  spaceId: string | null | undefined
  /** ：当前会话绑定 Agent；优先于 selectedAgent */
  sessionId?: string | null
  onAddContextRef?: (
    type: import('../types').ContextRefType,
    resourceId: string,
    label: string,
    extra?: Partial<import('../types').ContextRef>,
  ) => void
}

export function useChatInputSlashMentionState({
  input,
  setInput,
  textareaRef,
  spaceId,
  sessionId,
  onAddContextRef,
}: SlashMentionParams) {
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionAnchorPos, setMentionAnchorPos] = useState(0)
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashAnchorPos, setSlashAnchorPos] = useState(0)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)

  const sessionAgentId = useChatStore((s) => {
    if (!sessionId) return null
    return s.getSessionById(sessionId)?.agent_id ?? null
  })
  // 草稿 / pending：与展示名、+ 菜单 MCP 同口径，回落 selectedAgent，否则  携带集不拉、斜杠塌空。
  const selectedAgentId = useSpaceStore((s) => s.selectedAgent?.id ?? null)
  const selectedAgent = useSpaceStore((s) => s.selectedAgent)
  const agentCache = useSpaceStore((s) => s.agentCache)
  const currentAgentId = resolveCurrentAgentId({ sessionAgentId, selectedAgentId })
  const isDefaultAgent = Boolean(
    (selectedAgent?.id === currentAgentId ? selectedAgent : null)?.is_default
    ?? (currentAgentId ? agentCache[currentAgentId]?.is_default : undefined),
  )
  // ：工作区目录 Skill 已并入 useSkillsListQuery；可用性仍走 isSkillEnabledInCurrentSpace。
  const { data: slashSkills = [] } = useSkillsListQuery(spaceId ?? null, currentAgentId)
  const enabledSlashSkills = useMemo(
    () => slashSkills.filter(skill => isSkillEnabledInCurrentSpace(skill)),
    [slashSkills],
  )
  /** 完整目录（不过滤 query）——发送解析 / composer pill 高亮用，避免弹层过滤把已确认 token 判丢 */
  const slashCatalog = useMemo(
    () => buildSlashCommandOptions(enabledSlashSkills, '', { isDefaultAgent }),
    [enabledSlashSkills, isDefaultAgent],
  )
  const slashOptions = useMemo(
    () => (slashQuery
      ? buildSlashCommandOptions(enabledSlashSkills, slashQuery, { isDefaultAgent })
      : slashCatalog),
    [enabledSlashSkills, isDefaultAgent, slashCatalog, slashQuery],
  )

  useEffect(() => {
    if (slashActiveIndex >= slashOptions.length) {
      setSlashActiveIndex(0)
    }
  }, [slashActiveIndex, slashOptions.length])

  const closeSkillSlash = useCallback(() => {
    setSlashOpen(false)
    setSlashQuery('')
    setSlashActiveIndex(0)
  }, [])

  const handleMentionSelect = useCallback((item: MentionItem) => {
    const before = input.slice(0, mentionAnchorPos)
    const after = input.slice(mentionAnchorPos + mentionQuery.length + 1)
    setInput(before + after)

    const meta: Record<string, unknown> = { ...(item.meta ?? {}) }
    if (item.type === 'field' && item.tableId) meta.tableId = item.tableId

    onAddContextRef?.(item.type, item.resourceId, item.label, {
      spaceId: item.spaceId,
      spaceName: item.spaceName,
      tabType: item.tabType,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    })

    setMentionOpen(false)
    setMentionQuery('')
    textareaRef.current?.focus()
  }, [input, mentionAnchorPos, mentionQuery, onAddContextRef, setInput, textareaRef])

  const handleSkillSlashSelect = useCallback((option: SlashCommandOption) => {
    const next = replaceSkillSlashToken(input, slashAnchorPos, slashQuery, option)
    setInput(next.value)
    closeSkillSlash()
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.selectionStart = next.cursorPos
      textarea.selectionEnd = next.cursorPos
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 260) + 'px'
    })
  }, [closeSkillSlash, input, setInput, slashAnchorPos, slashQuery, textareaRef])

  return {
    mentionOpen,
    setMentionOpen,
    mentionQuery,
    setMentionQuery,
    mentionAnchorPos,
    setMentionAnchorPos,
    slashOpen,
    setSlashOpen,
    slashQuery,
    setSlashQuery,
    slashAnchorPos,
    setSlashAnchorPos,
    slashActiveIndex,
    setSlashActiveIndex,
    slashOptions,
    slashCatalog,
    closeSkillSlash,
    handleMentionSelect,
    handleSkillSlashSelect,
  }
}

export function detectMentionAtCursor(
  value: string,
  cursorPos: number,
): { query: string; anchorPos: number } | null {
  const textBeforeCursor = value.slice(0, cursorPos)
  const atMatch = textBeforeCursor.match(/@([^\s@]*)$/)
  if (!atMatch) return null
  return {
    query: atMatch[1],
    anchorPos: cursorPos - atMatch[0].length,
  }
}

export function syncSlashMentionFromInput(params: {
  value: string
  cursorPos: number
  mentionOpen: boolean
  slashOpen: boolean
  setMentionOpen: (open: boolean) => void
  setMentionQuery: (query: string) => void
  setMentionAnchorPos: (pos: number) => void
  setSlashOpen: (open: boolean) => void
  setSlashQuery: (query: string) => void
  setSlashAnchorPos: (pos: number) => void
  setSlashActiveIndex: (index: number) => void
  closeSkillSlash: () => void
}) {
  const {
    value,
    cursorPos,
    mentionOpen,
    slashOpen,
    setMentionOpen,
    setMentionQuery,
    setMentionAnchorPos,
    setSlashOpen,
    setSlashQuery,
    setSlashAnchorPos,
    setSlashActiveIndex,
    closeSkillSlash,
  } = params

  const atMatch = detectMentionAtCursor(value, cursorPos)
  if (atMatch) {
    setMentionOpen(true)
    setMentionQuery(atMatch.query)
    setMentionAnchorPos(atMatch.anchorPos)
    closeSkillSlash()
  } else if (mentionOpen) {
    setMentionOpen(false)
    setMentionQuery('')
  }

  const slashMatch = detectSkillSlashQuery(value, cursorPos)
  if (!atMatch && slashMatch) {
    setSlashOpen(true)
    setSlashQuery(slashMatch.query)
    setSlashAnchorPos(slashMatch.anchorPos)
    setSlashActiveIndex(0)
  } else if (slashOpen && (!slashMatch || atMatch)) {
    closeSkillSlash()
  }
}
