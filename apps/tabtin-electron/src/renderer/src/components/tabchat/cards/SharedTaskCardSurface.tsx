import React from 'react';
import { AlertCircle, Check, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@utils/cn';

export type SharedTaskCardTone =
  | 'default'
  | 'success'
  | 'warning'
  | 'danger'
  | 'neutral';

export interface SharedTaskCardBadge {
  label: string;
  tone: SharedTaskCardTone;
}

export interface SharedTaskCardResource {
  label: string;
  unavailable?: boolean;
  unavailableLabel?: string;
}

export interface SharedTaskCardStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
}

export interface SharedTaskCardAction<Action extends string> {
  /** 禁用/loading CTA 只表达状态，不携带可执行命令。 */
  id?: Action;
  label: string;
  tone?: 'family' | 'danger' | 'neutral';
  disabled?: boolean;
  loading?: boolean;
}

export interface SharedTaskCardView<Action extends string> {
  family: 'collaboration' | 'continuation';
  phase: string;
  icon: React.ReactNode;
  kindLabel: string;
  title: string;
  badges: SharedTaskCardBadge[];
  relation: string;
  permissionLabel: string;
  permissionCopy: string;
  info: {
    tone: SharedTaskCardTone;
    title: string;
    meta?: string;
    description: string;
    steps?: SharedTaskCardStep[];
    resources?: SharedTaskCardResource[];
  };
  footer: string;
  action: SharedTaskCardAction<Action> | null;
  actionPlacement?: 'card' | 'footer';
  muted?: boolean;
}

const BADGE_TONE: Record<SharedTaskCardTone, string> = {
  default: 'bg-foreground/[0.06] text-muted-foreground',
  success: 'bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/[0.12] text-amber-700 dark:text-amber-300',
  danger: 'bg-destructive/10 text-destructive',
  neutral: 'bg-muted/60 text-muted-foreground',
};

const INFO_TONE: Record<SharedTaskCardTone, string> = {
  default: 'bg-foreground/[0.035] text-foreground',
  success: 'bg-emerald-500/[0.08] text-foreground',
  warning: 'bg-amber-500/[0.08] text-foreground',
  danger: 'bg-destructive/[0.07] text-foreground',
  neutral: 'bg-muted/35 text-muted-foreground',
};

interface Props<Action extends string> {
  view: SharedTaskCardView<Action>;
  onAction?: (action: Action) => void;
}

/** 两类共享任务卡共用的纯视觉骨架；不读取、不推导业务状态。 */
export function SharedTaskCardSurface<Action extends string>({
  view,
  onAction,
}: Props<Action>) {
  const familyColor =
    view.family === 'collaboration'
      ? 'text-blue-600 dark:text-blue-400'
      : 'text-violet-600 dark:text-violet-400';
  const familyButton =
    view.family === 'collaboration'
      ? 'bg-blue-600 text-white hover:bg-blue-600/90'
      : 'bg-violet-600 text-white hover:bg-violet-600/90';
  const cardAction = view.actionPlacement === 'card' ? view.action : null;
  const footerAction = view.actionPlacement === 'card' ? null : view.action;
  const cardIsInteractive = Boolean(
    cardAction?.id && !cardAction.disabled && !cardAction.loading && onAction,
  );
  const triggerCardAction = () => {
    if (cardIsInteractive && cardAction?.id) onAction?.(cardAction.id);
  };

  return (
    <article
      data-family={view.family}
      data-phase={view.phase}
      aria-live="polite"
      className={cn(
        'relative w-[340px] max-w-full overflow-hidden rounded-xl border border-border/60 bg-card @container/shared-task-card',
        view.muted && 'bg-muted/15',
      )}
    >
      {cardIsInteractive && cardAction?.id ? (
        <button
          type="button"
          aria-label={cardAction.label}
          onClick={triggerCardAction}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            triggerCardAction();
          }}
          className="absolute inset-0 z-floating cursor-pointer rounded-xl bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      ) : null}

      <div className="space-y-3 px-4 pb-3 pt-3.5">
        <header className="flex flex-col items-start gap-2 @[300px]:flex-row">
          <span
            className={cn(
              'mt-0.5 inline-flex items-center gap-1.5 text-caption font-medium',
              familyColor,
            )}
          >
            {view.icon}
            {view.kindLabel}
          </span>
          <span className="hidden flex-1 @[300px]:block" />
          <span className="flex flex-wrap gap-1 @[300px]:justify-end">
            {view.badges.map((badge, index) => (
              <span
                key={`${badge.label}-${index}`}
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-caption',
                  BADGE_TONE[badge.tone],
                )}
              >
                {badge.label}
              </span>
            ))}
          </span>
        </header>

        <div className={cn('space-y-2', view.muted && 'opacity-70')}>
          <h3 className="text-subtitle font-semibold leading-snug text-foreground">
            {view.title}
          </h3>
          <p className="text-caption text-muted-foreground">{view.relation}</p>

          <div className="flex items-start gap-2 text-caption">
            <span className="shrink-0 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 font-medium text-foreground">
              {view.permissionLabel}
            </span>
            <span className="pt-0.5 text-muted-foreground">
              {view.permissionCopy}
            </span>
          </div>

          <section
            className={cn('rounded-lg px-3 py-2.5', INFO_TONE[view.info.tone])}
          >
            <div className="flex items-baseline gap-2">
              <strong className="min-w-0 flex-1 text-body font-medium">
                {view.info.title}
              </strong>
              {view.info.meta ? (
                <span className="shrink-0 text-caption text-muted-foreground">
                  {view.info.meta}
                </span>
              ) : null}
            </div>
            {view.info.description ? (
              <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
                {view.info.description}
              </p>
            ) : null}
            {view.info.steps?.length ? (
              <ul className="mt-2 space-y-1.5" aria-label="任务最近进展">
                {view.info.steps.map((step) => (
                  <li key={step.id} className="flex items-start gap-2 text-caption">
                    {step.status === 'running' ? (
                      <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden />
                    ) : step.status === 'error' ? (
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
                    ) : (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    )}
                    <span className={cn(
                      'min-w-0 break-words',
                      step.status === 'running' ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}>
                      {step.label}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {view.info.resources?.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {view.info.resources.map((resource, index) => (
                  <li
                    key={`${resource.label}-${index}`}
                    className={cn(
                      'rounded-md bg-background/60 px-2 py-1 text-caption text-muted-foreground',
                      resource.unavailable && 'line-through opacity-50',
                    )}
                  >
                    {resource.label}
                    {resource.unavailable && resource.unavailableLabel ? (
                      <span className="sr-only">
                        {' '}
                        · {resource.unavailableLabel}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </div>

      <footer
        className={cn(
          'flex flex-col items-stretch gap-2 border-t border-border/40 px-4 py-3 @[300px]:flex-row @[300px]:items-center @[300px]:gap-3',
          !view.footer && !footerAction && 'hidden',
        )}
      >
        {view.footer ? (
          <span className="min-w-0 flex-1 text-caption text-muted-foreground">
            {view.footer}
          </span>
        ) : null}
        {footerAction ? (
          <button
            type="button"
            disabled={
              footerAction.disabled ||
              footerAction.loading ||
              !footerAction.id ||
              !onAction
            }
            aria-busy={footerAction.loading || undefined}
            onClick={() => {
              if (footerAction.id) onAction?.(footerAction.id);
            }}
            className={cn(
              'inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-interactive px-3 py-2 @[300px]:ml-auto @[300px]:w-auto',
              'text-body font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              footerAction.tone === 'danger'
                ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
                : footerAction.tone === 'neutral'
                  ? 'bg-muted text-muted-foreground hover:bg-muted/80'
                  : familyButton,
            )}
          >
            {footerAction.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            {footerAction.label}
          </button>
        ) : null}
      </footer>
    </article>
  );
}
