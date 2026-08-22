import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../turn/TurnArtifactsCard', () => ({
  TurnArtifactsCard: () => <div data-testid="turn-artifacts-card" />,
}))

import { MessageBubbleTurnExtras } from '../messages/common/MessageBubbleTurnExtras'

describe('MessageBubbleTurnExtras', () => {
  it('权限不允许时不渲染响应产物入口', () => {
    render(
      <MessageBubbleTurnExtras
        sessionId="session-1"
        isLastInTurn
        isUser={false}
        isMiniMessage={false}
        isErrorEnvelope={false}
        turnArtifacts={[{
          id: 'artifact-1',
          kind: 'file',
          title: 'test.txt',
          href: 'tabtin://file/test.txt',
          subtitleKey: 'previewFile',
        }]}
        canOpenArtifacts={false}
      />,
    )

    expect(screen.queryByTestId('turn-artifacts-card')).toBeNull()
  })

  it('继续展示与 checkpoint 无关的 turn 产物，Diff 审阅入口统一放在会话底部', () => {
    render(
      <MessageBubbleTurnExtras
        sessionId="session-1"
        isLastInTurn
        isUser={false}
        isMiniMessage={false}
        isErrorEnvelope={false}
        turnArtifacts={[{
          id: 'artifact-1',
          kind: 'file',
          title: 'test.txt',
          href: 'tabtin://file/test.txt',
          subtitleKey: 'previewFile',
        }]}
      />,
    )

    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()
    expect(screen.getByTestId('turn-artifacts-card')).toBeTruthy()
  })
})
