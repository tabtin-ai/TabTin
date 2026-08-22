import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TabTinCustomCardPayload } from '@/services/im/cards/tabtinCustomCardModel'
import type { IMMessage } from '@/services/im/contracts'

vi.mock('../SpaceCard', () => ({
  SpaceCard: ({ spaceId, name }: { spaceId: string; name: string }) => (
    <div data-testid="space-card">{spaceId}|{name}</div>
  ),
}))

vi.mock('../IMResourceCard', () => ({
  IMResourceCard: ({
    resourceType,
    resourceId,
    name,
  }: {
    resourceType: string
    resourceId: string
    name: string
  }) => <div data-testid="resource-card">{resourceType}|{resourceId}|{name}</div>,
}))

vi.mock('../ContactCard', () => ({
  ContactCard: ({ userId, name }: { userId: string; name: string }) => (
    <div data-testid="contact-card">{userId}|{name}</div>
  ),
}))

vi.mock('../HandoffCard', () => ({
  HandoffCard: ({ handoffId }: { handoffId: string }) => (
    <div data-testid="handoff-card">{handoffId}</div>
  ),
}))

vi.mock('../PromptCard', () => ({
  PromptCard: ({ promptText }: { promptText: string }) => (
    <div data-testid="prompt-card">{promptText}</div>
  ),
}))

vi.mock('../SessionShareCard', () => ({
  SessionShareCard: ({ shareId }: { shareId: string }) => (
    <div data-testid="session-share-card">{shareId}</div>
  ),
}))

vi.mock('./SessionCollaborationCardController', () => ({
  SessionCollaborationCardController: ({ card }: { card: { object_id: string } }) => (
    <div data-testid="session-share-v2-card">{card.object_id}</div>
  ),
}))

vi.mock('./SessionContinuationCardController', () => ({
  SessionContinuationCardController: ({ card }: { card: { object_id: string } }) => (
    <div data-testid="session-continuation-card">{card.object_id}</div>
  ),
}))

vi.mock('../CodexSessionCard', () => ({
  CodexSessionCard: ({ message }: { message: IMMessage }) => (
    <div data-testid="codex-session-card">{message.metadata?.card?.codex_session_id}</div>
  ),
}))

const SHARED_TASK = {
  schema_version: 1,
  version: 1,
  object_id: 'object-1',
  title_snapshot: 'Shared task',
  sender_id: 'user-1',
  recipient_id: 'user-2',
} as const

async function renderCard(card: TabTinCustomCardPayload) {
  const { TabTinCustomCardRenderer } = await import('./TabTinCustomCardRenderer')
  return render(
    <TabTinCustomCardRenderer
      card={card}
      message={{ id: 42, metadata: { card } } as IMMessage}
      conversationId="conversation-1"
      messageId={42}
      messageRef="message-ref-1"
      defaultOrganizationId="organization-1"
      isMine={false}
      captionContent={<span>caption content</span>}
    />,
  )
}

describe('TabTinCustomCardRenderer', () => {
  it.each([
    [{ type: 'space', space_id: 'space-1', name: 'Space' }, 'space-card', 'space-1|Space'],
    [{ type: 'agent_space', space_id: 'agent-1', name: 'Agent' }, 'space-card', 'agent-1|Agent'],
    [{ type: 'table', resource_id: 'table-1', name: 'Table' }, 'resource-card', 'table|table-1|Table'],
    [{ type: 'document', resource_id: 'doc-1', name: 'Doc' }, 'resource-card', 'document|doc-1|Doc'],
    [{ type: 'contact', user_id: 'user-1', name: 'User' }, 'contact-card', 'user-1|User'],
    [{ type: 'handoff', handoff_id: 'handoff-1' }, 'handoff-card', 'handoff-1'],
    [{ type: 'prompt', prompt_text: 'Run it' }, 'prompt-card', 'Run it'],
    [{ type: 'session_share', share_id: 'share-1' }, 'session-share-card', 'share-1'],
    [{ type: 'session_share_v2', ...SHARED_TASK }, 'session-share-v2-card', 'object-1'],
    [{ type: 'session_continuation', ...SHARED_TASK }, 'session-continuation-card', 'object-1'],
    [{
      type: 'codex_session',
      schema_version: 1,
      codex_session_id: 'session-1',
      codex_session_name: 'Imported session',
    }, 'codex-session-card', 'session-1'],
  ] as const)('routes %o through the single renderer', async (card, testId, expectedText) => {
    await renderCard(card)

    expect(screen.getByTestId(testId).textContent).toBe(expectedText)
  })

  it('renders resource captions under the card', async () => {
    await renderCard({
      type: 'document',
      resource_id: 'doc-1',
      name: 'Doc',
      caption: 'caption content',
    })

    expect(screen.getByTestId('resource-card')).toBeTruthy()
    expect(screen.getByText('caption content')).toBeTruthy()
  })

  it('uses the upgrade fallback for an unknown card type', async () => {
    await renderCard({ type: 'project_digest_v2' })

    const fallback = screen.getByTestId('unsupported-card-fallback')
    expect(fallback.textContent).toContain('unsupportedCardUpgradeHint')
    expect(fallback.querySelector('svg')).toBeTruthy()
  })

  it.each([
    { type: 'contact' },
    { type: 'handoff' },
    { type: 'prompt' },
    { type: 'session_share' },
    { type: 'session_share_v2', ...SHARED_TASK, version: 0 },
    { type: 'session_continuation', ...SHARED_TASK, object_id: '' },
    { type: 'codex_session', schema_version: 1, codex_session_id: 'session-1' },
  ])('does not render a malformed $type card', async (card) => {
    const { container } = await renderCard(card)

    expect(container.innerHTML).toBe('')
  })
})
