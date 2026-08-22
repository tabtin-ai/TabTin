import { Gift, Info, KeyRound, ShieldOff, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'

export function ByokScenarioHint() {
  const { t } = useTranslation('organization')

  const items = [
    { icon: KeyRound, tone: 'text-emerald-600 dark:text-emerald-400', labelKey: 'appliesLabel', textKey: 'appliesText' },
    { icon: Gift, tone: 'text-violet-600 dark:text-violet-400', labelKey: 'complimentaryLabel', textKey: 'complimentaryText' },
    { icon: Wallet, tone: 'text-sky-600 dark:text-sky-400', labelKey: 'platformPaidLabel', textKey: 'platformPaidText' },
    { icon: ShieldOff, tone: 'text-amber-600 dark:text-amber-400', labelKey: 'noFallbackLabel', textKey: 'noFallbackText' },
  ] as const

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('modelSettings.byokDisclaimer.scenarioLabel')}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          className="max-w-sm space-y-2 p-3 text-caption leading-relaxed"
        >
          <p className="font-medium text-foreground">{t('modelSettings.byokDisclaimer.title')}</p>
          <ul className="space-y-2">
            {items.map(({ icon: Icon, tone, labelKey, textKey }) => (
              <li key={labelKey} className="flex items-start gap-2">
                <Icon className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', tone)} aria-hidden />
                <p>
                  <span className="font-medium">{t(`modelSettings.byokDisclaimer.${labelKey}`)}</span>
                  {' '}
                  {t(`modelSettings.byokDisclaimer.${textKey}`)}
                </p>
              </li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
