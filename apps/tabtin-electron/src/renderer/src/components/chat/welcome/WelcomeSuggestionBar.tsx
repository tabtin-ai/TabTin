import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { useScopedEventListener } from '@hooks/spaceActivity'
import {
  STARTER_SUGGESTION_MODULES,
  resolveStarterSuggestions,
  type StarterSuggestionModuleKey,
  type StarterSuggestionDef,
} from './starterSuggestions'

export interface WelcomeSuggestionBarProps {
  activeContextType: string | null | undefined
  onSelect: (prompt: string, selectedTitle?: string) => void
  className?: string
  /** 已有工作台标签但当前没有可识别的 App 类型时，仍展示直接任务列表。 */
  forceContextMode?: boolean
  /** 为 true 时隐藏（用户已开始输入 / 已预填） */
  hidden?: boolean
}

const groupVariants = {
  initial: { opacity: 0, y: 8, filter: 'blur(3px)' },
  animate: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      type: 'spring' as const,
      bounce: 0,
      duration: 0.32,
      staggerChildren: 0.05,
      delayChildren: 0.02,
    },
  },
  exit: {
    opacity: 0,
    y: -6,
    filter: 'blur(3px)',
    transition: { duration: 0.18, ease: 'easeIn' as const },
  },
}

const itemVariants = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring' as const, bounce: 0, duration: 0.28 },
  },
}

const reducedGroupVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.12 } },
  exit: { opacity: 0, transition: { duration: 0.1 } },
}

export const WelcomeSuggestionBar: React.FC<WelcomeSuggestionBarProps> = ({
  activeContextType,
  onSelect,
  className,
  forceContextMode = false,
  hidden = false,
}) => {
  const { t } = useTranslation('chat')
  const reducedMotion = useReducedMotion()
  const { appKey, suggestions } = useMemo(
    () => resolveStarterSuggestions(activeContextType),
    [activeContextType],
  )
  const isContextMode = forceContextMode || Boolean(activeContextType)
  const [selectedModule, setSelectedModule] = useState<StarterSuggestionModuleKey | null>(null)
  const suggestionBarRef = useRef<HTMLDivElement>(null)
  const documentTarget = typeof document === 'undefined' ? null : document

  useEffect(() => {
    if (isContextMode) setSelectedModule(null)
  }, [appKey, isContextMode])

  useScopedEventListener<PointerEvent>(documentTarget, 'pointerdown', (event) => {
    if (suggestionBarRef.current?.contains(event.target as Node)) return
    setSelectedModule(null)
  }, {
    enabled: !isContextMode && Boolean(selectedModule),
  })

  if (hidden) return null

  const variants = reducedMotion ? reducedGroupVariants : groupVariants
  const selectedModuleDef = STARTER_SUGGESTION_MODULES.find(
    module => module.key === selectedModule,
  )
  const visibleSuggestions = isContextMode
    ? suggestions
    : selectedModuleDef?.suggestions ?? []
  const panelKey = isContextMode
    ? `context:${appKey}`
    : `module:${selectedModule ?? 'none'}`

  const renderSuggestion = (item: StarterSuggestionDef) => (
    <motion.div
      key={item.id}
      role="listitem"
      variants={reducedMotion ? undefined : itemVariants}
    >
      <button
        type="button"
        className={cn(
          'group flex min-h-12 w-full min-w-0 items-center gap-3 px-3 py-2 text-left',
          'transition-colors duration-150 hover:bg-muted/25',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40',
        )}
        onClick={() => {
          const prompt = t(item.promptKey)
          if (!prompt.trim()) return
          if (item.selectedTitleKey) {
            onSelect(prompt, t(item.selectedTitleKey))
          } else {
            onSelect(prompt)
          }
        }}
        data-testid={`welcome-suggestion-${item.id}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caption text-foreground/80">{t(item.titleKey)}</span>
        </span>
        <ChevronRight
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground/60"
        />
      </button>
    </motion.div>
  )

  return (
    <div
      ref={suggestionBarRef}
      className={cn('pointer-events-auto mt-5 w-full max-w-md mx-auto', className)}
      data-testid="welcome-suggestion-bar"
      data-app-key={appKey}
    >
      <div className="space-y-2">
        {!isContextMode ? (
          <div
            role="group"
            aria-label={t('input.starterSuggestions.moduleLabel', { defaultValue: '选择工作模块' })}
            className="flex items-center justify-center gap-2"
          >
            {STARTER_SUGGESTION_MODULES.map(module => {
              const isSelected = selectedModule === module.key
              return (
                <button
                  key={module.key}
                  type="button"
                  aria-pressed={isSelected}
                  aria-expanded={isSelected}
                  aria-controls={isSelected ? `welcome-module-panel-${module.key}` : undefined}
                  className={cn(
                    'flex min-w-24 items-center justify-center gap-2 rounded-lg border px-3 py-2',
                    'text-caption transition-colors duration-150',
                    isSelected
                      ? 'border-foreground/20 bg-muted/35 text-foreground'
                      : 'border-border/30 text-muted-foreground/60 hover:border-border/60 hover:bg-muted/20 hover:text-foreground/80',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40',
                  )}
                  onClick={() => setSelectedModule(isSelected ? null : module.key)}
                  data-testid={`welcome-module-${module.key}`}
                >
                  <TabTypeEmoji appIdOrType={module.key} className="h-4 w-4" />
                  <span>{t(module.labelKey)}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        <AnimatePresence mode="wait" initial={false}>
          {visibleSuggestions.length > 0 ? (
            <motion.div
              key={panelKey}
              role="region"
              aria-label={t('input.starterSuggestions.ariaLabel', { defaultValue: '快速开始建议' })}
              className="overflow-hidden rounded-lg border border-border/30 bg-background/35"
              variants={variants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div
                role="list"
                id={!isContextMode ? `welcome-module-panel-${selectedModule}` : undefined}
                className="divide-y divide-border/20"
              >
                {visibleSuggestions.map(renderSuggestion)}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}
