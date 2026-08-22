import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../panel/ChatIconTooltip', () => ({
  ChatIconTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

vi.mock('@utils/cn', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

vi.mock('../useVoiceRecording', () => ({
  MAX_DURATION: 120,
}))

describe('VoiceRecordingCapsule', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not render errors inside the recording capsule', async () => {
    const { VoiceRecordingCapsule } = await import('../VoiceRecordingCapsule')

    render(
      <VoiceRecordingCapsule
        state="error"
        audioLevels={[]}
        duration={0}
        onStop={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/麦克风|语音/)).toBeNull()
  })
})
