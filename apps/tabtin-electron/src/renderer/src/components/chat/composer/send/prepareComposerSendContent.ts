import type { ContextRef } from '../../types'
import type { ChatInputSendOptions } from '../chatInputTypes'
import {
  detectUnrecognizedLeadingSlashToken,
  parseLeadingBuiltinSlashCommand,
  parseLeadingSkillSlashCommand,
  type SlashCommandOption,
} from '../../skill/skillSlashCommand'

export interface PreparedComposerSendContent {
  rawMessage: string
  message: string
  hasContent: boolean
  skillSendOptions: ChatInputSendOptions | undefined
  compactArgs: string | null
  /** 以 `/token` 开头但当前 Agent 无对应可用命令时的 token（含 `/`） */
  unrecognizedSlashToken: string | null
}

export function prepareComposerSendContent(input: {
  input: string
  attachmentsCount: number
  contextRefsCount: number
  hasActivePresets: boolean
  conversationReferenceRefs: ContextRef[]
  slashOptions: SlashCommandOption[]
}): PreparedComposerSendContent {
  const rawMessage = input.input.trim()
  const builtinCommand = parseLeadingBuiltinSlashCommand(rawMessage, input.slashOptions)
  if (builtinCommand?.option.command === 'compact') {
    return {
      rawMessage,
      message: rawMessage,
      hasContent: false,
      skillSendOptions: undefined,
      compactArgs: builtinCommand.args,
      unrecognizedSlashToken: null,
    }
  }

  const skillCommand = parseLeadingSkillSlashCommand(rawMessage, input.slashOptions)
  const skillSendOptions: ChatInputSendOptions | undefined = skillCommand
    ? {
        skillSlashInvoke: {
          skillKey: skillCommand.option.canonicalKey,
          args: skillCommand.args || undefined,
        },
      }
    : undefined

  const unrecognizedSlashToken = skillCommand
    ? null
    : detectUnrecognizedLeadingSlashToken(rawMessage, input.slashOptions)

  const referenceBlocks = input.conversationReferenceRefs
    .map(ref => (typeof ref.meta?.rawBlock === 'string' ? ref.meta.rawBlock.trim() : ''))
    .filter(Boolean)
  const message = referenceBlocks.length > 0
    ? (rawMessage
      ? `${referenceBlocks.join('\n\n')}\n\n${rawMessage}`
      : referenceBlocks.join('\n\n'))
    : rawMessage

  const hasContent = rawMessage.length > 0
    || input.attachmentsCount > 0
    || input.contextRefsCount > 0
    || input.hasActivePresets

  return {
    rawMessage,
    message,
    hasContent,
    skillSendOptions,
    compactArgs: null,
    unrecognizedSlashToken,
  }
}
