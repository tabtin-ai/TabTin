import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import companionUrl from '@/assets/brand/tabtin-input-companion.png?url'

const MASCOT_REACTION_COOLDOWN_MS = 450

interface ComposerWelcomeMascotProps {
  className?: string
}

/** 欢迎首屏伴侣 — 趴在输入框左侧上沿，仅 composerWelcomeLayout 时展示。 */
export function ComposerWelcomeMascot({ className }: ComposerWelcomeMascotProps) {
  const { t } = useTranslation('chat')
  const [reactionKey, setReactionKey] = useState(0)
  const lastReactionAtRef = useRef(Number.NEGATIVE_INFINITY)

  return (
    <div
      className={cn(
        // h-28(7rem) 上移 5.5rem，底部约 1.5rem 压进输入框上沿形成「趴着」
        'pointer-events-none absolute -top-[5.5rem] left-2 z-10 select-none',
        className,
      )}
    >
      <button
        type="button"
        aria-label={t('input.mascotGreetingAction')}
        className="composer-mascot-button pointer-events-auto relative block cursor-pointer rounded-[18px] border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onClick={(event) => {
          const now = Date.now()
          if (now - lastReactionAtRef.current >= MASCOT_REACTION_COOLDOWN_MS) {
            lastReactionAtRef.current = now
            setReactionKey((key) => key + 1)
          }
          event.currentTarget
            .closest('.chat-composer-backplate')
            ?.querySelector<HTMLTextAreaElement>('textarea')
            ?.focus()
        }}
      >
        <img
          key={`base-${reactionKey}`}
          src={companionUrl}
          alt=""
          draggable={false}
          className={cn(
            'composer-mascot composer-mascot--base h-28 w-auto object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.12)]',
            reactionKey > 0 && 'composer-mascot--tap-reaction',
          )}
        />
        {reactionKey > 0 ? (
          <span
            key={`sparkles-${reactionKey}`}
            aria-hidden="true"
            className="composer-mascot-sparkles pointer-events-none absolute inset-0"
          >
            <span className="composer-mascot-sparkle composer-mascot-sparkle--large" />
            <span className="composer-mascot-sparkle composer-mascot-sparkle--small" />
          </span>
        ) : null}
      </button>
    </div>
  )
}
