import React from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert } from 'lucide-react'
import { sanitizeUrl } from '@/lib/sanitizeUrl'
import type { IMMessage } from '@/services/im/contracts'
import {
  parseTabTinCustomCard,
  type TabTinCustomCardPayload,
} from '@/services/im/cards/tabtinCustomCardModel'
import { IM_MESSAGE_BUBBLE_TEXT } from '../tabchatUi'
import { ContactCard } from '../ContactCard'
import { HandoffCard } from '../HandoffCard'
import { IMResourceCard } from '../IMResourceCard'
import { PromptCard } from '../PromptCard'
import { SessionShareCard } from '../SessionShareCard'
import { SpaceCard } from '../SpaceCard'
import { SessionCollaborationCardController } from './SessionCollaborationCardController'
import { SessionContinuationCardController } from './SessionContinuationCardController'
import { CodexSessionCard } from '../CodexSessionCard'

interface Props {
  card: TabTinCustomCardPayload
  message: IMMessage
  conversationId: string
  messageId: number
  messageRef?: string
  defaultOrganizationId?: string
  isMine: boolean
  captionContent: React.ReactNode
}

function failClosedUnhandledCard(_card: never): null {
  return null
}

export const TabTinCustomCardRenderer: React.FC<Props> = ({
  card: rawCard,
  message,
  conversationId,
  messageId,
  messageRef,
  defaultOrganizationId,
  isMine,
  captionContent,
}) => {
  const { t } = useTranslation('tabchat')
  const resolution = parseTabTinCustomCard(rawCard)
  if (!resolution || resolution.kind === 'invalid') return null
  if (resolution.kind === 'unsupported') {
    return (
      <div
        role="status"
        data-testid="unsupported-card-fallback"
        className="flex w-72 max-w-full items-center gap-2.5 rounded-xl border border-warning/20 bg-warning/10 px-3 py-2.5 text-left"
      >
        <CircleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="text-body text-foreground">
          {t('unsupportedCardUpgradeHint', {
            defaultValue: '当前客户端版本不支持此卡片，请升级到最新版本查看',
          })}
        </span>
      </div>
    )
  }

  const card = resolution.card
  switch (card.type) {
    case 'space':
    case 'agent_space':
      return (
        <SpaceCard
          spaceId={card.space_id ?? ''}
          name={card.name || 'Space'}
          icon={card.icon}
        />
      )
    case 'table':
    case 'document': {
      const previewTable = card.preview_table?.columns?.length
        ? {
            columns: card.preview_table.columns
              .filter((column): column is { key: string; label: string } =>
                typeof column?.key === 'string' && typeof column?.label === 'string')
              .map((column) => ({ key: column.key, label: column.label })),
            rows: card.preview_table.rows ?? [],
            total_rows: card.preview_table.total_rows,
          }
        : undefined
      const resourceCard = (
        <IMResourceCard
          resourceType={card.type}
          resourceId={card.resource_id ?? ''}
          name={card.name || ''}
          spaceId={card.space_id}
          organizationId={card.organization_id ?? defaultOrganizationId}
          description={card.description}
          previewTable={previewTable}
          sourceConversationId={conversationId}
          sourceMessageId={messageId}
          sourceMessageRef={messageRef}
        />
      )
      if (!card.caption) return resourceCard

      return (
        <div className={`flex max-w-full flex-col gap-1.5 ${isMine ? 'items-end' : 'items-start'}`}>
          {resourceCard}
          <div className={`w-fit max-w-full rounded-2xl px-3.5 py-2 ${IM_MESSAGE_BUBBLE_TEXT} ${
            isMine
              ? 'rounded-br-md bg-foreground/[0.06] dark:bg-foreground/[0.08]'
              : 'rounded-bl-md bg-accent/10'
          }`}>
            {captionContent}
          </div>
        </div>
      )
    }
    case 'contact':
      return (
        <ContactCard
          userId={card.user_id}
          name={card.name || ''}
          username={card.username}
          avatar={sanitizeUrl(card.avatar) || card.avatar}
          conversationId={conversationId}
        />
      )
    case 'handoff':
      return (
        <HandoffCard
          handoffId={card.handoff_id}
          conversationId={conversationId}
          goalSnapshot={card.goal}
          initiatorType={card.initiator_type}
          initiatorId={card.initiator_id}
        />
      )
    case 'prompt':
      return <PromptCard promptText={card.prompt_text} title={card.title} />
    case 'session_share':
      return (
        <SessionShareCard
          shareId={card.share_id}
          sessionIdSnapshot={card.session_id}
          sessionTitleSnapshot={card.session_title}
          canForkSnapshot={card.can_fork}
          canChatSnapshot={card.can_chat}
          statusSnapshot={card.status}
        />
      )
    case 'session_share_v2':
      return <SessionCollaborationCardController card={card} conversationId={conversationId} />
    case 'session_continuation':
      return <SessionContinuationCardController card={card} />
    case 'codex_session':
      return <CodexSessionCard message={message} isMine={isMine} />
    default:
      return failClosedUnhandledCard(card)
  }
}
