import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Boxes,
  CheckSquare2,
  Inbox,
  Loader2,
  MessageSquare,
  Users,
} from 'lucide-react';
import {
  CANVAS_TEXT_EYEBROW,
  CANVAS_TEXT_MICRO,
  CANVAS_TEXT_SECONDARY,
} from '@components/layout/canvasUi';
import { cn } from '@utils/cn';
import { useProjectTaskRealtime } from '@/hooks/useProjectTaskRealtime';
import { useProjectTaskStore } from '@/stores/useProjectTaskStore';

export type ProjectTab =
  | 'overview'
  | 'tasks'
  | 'discussion'
  | 'assets'
  | 'activity'
  | 'members';

const PROJECT_NAV_ITEMS: Array<{
  id: ProjectTab;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'overview', Icon: Inbox },
  { id: 'tasks', Icon: CheckSquare2 },
  { id: 'discussion', Icon: MessageSquare },
  { id: 'assets', Icon: Boxes },
  { id: 'activity', Icon: Activity },
  { id: 'members', Icon: Users },
];

export const ProjectWorkspaceNavigation: React.FC<{
  activeTab: ProjectTab;
  onChange: (tab: ProjectTab) => void;
}> = ({ activeTab, onChange }) => {
  const { t } = useTranslation('project');
  const selectFromKeyboard = (currentId: ProjectTab, direction: -1 | 1) => {
    const currentIndex = PROJECT_NAV_ITEMS.findIndex(
      (item) => item.id === currentId,
    );
    const nextIndex =
      (currentIndex + direction + PROJECT_NAV_ITEMS.length) %
      PROJECT_NAV_ITEMS.length;
    const nextId = PROJECT_NAV_ITEMS[nextIndex]!.id;
    onChange(nextId);
    requestAnimationFrame(() =>
      document.getElementById(`project-tab-${nextId}`)?.focus(),
    );
  };

  return (
    <nav
      aria-label={t('navigation.label')}
      className="w-full overflow-x-auto border-b border-foreground/[0.06] scrollbar-hover dark:border-foreground/[0.08]"
    >
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="flex min-w-max items-center gap-1"
      >
        {PROJECT_NAV_ITEMS.map(({ id, Icon }) => {
          const active = id === activeTab;
          const label = t(`navigation.${id}`);
          return (
            <button
              key={id}
              id={`project-tab-${id}`}
              type="button"
              role="tab"
              aria-label={label}
              aria-selected={active}
              aria-controls="project-workspace-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(id)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
                  return;
                event.preventDefault();
                selectFromKeyboard(id, event.key === 'ArrowRight' ? 1 : -1);
              }}
              className={cn(
                'group flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset',
                active
                  ? 'border-accent-text font-medium text-foreground'
                  : 'border-transparent text-muted-foreground/60 hover:border-foreground/20 hover:text-foreground',
              )}
            >
              <Icon
                className={cn(
                  'h-[1em] w-[1em] shrink-0 text-body',
                  active
                    ? 'text-accent-text'
                    : 'text-muted-foreground/60 group-hover:text-foreground',
                )}
                aria-hidden
              />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};

const WorkspaceSectionHeader: React.FC<{
  titleId?: string;
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}> = ({ titleId, eyebrow, title, description, action }) => (
  <header className="flex flex-wrap items-start justify-between gap-4">
    <div className="min-w-0">
      <p className={CANVAS_TEXT_EYEBROW}>{eyebrow}</p>
      <h2
        id={titleId}
        className="mt-1 text-title font-semibold text-foreground"
      >
        {title}
      </h2>
      <p className="mt-1 max-w-2xl text-body leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
    {action}
  </header>
);

const QuickStartAction: React.FC<{
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick: () => void;
}> = ({ Icon, title, description, onClick }) => (
  <button
    type="button"
    aria-label={title}
    onClick={onClick}
    className="group flex w-full items-start gap-3 rounded-interactive px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04]"
  >
    <span className="mt-0.5 inline-grid h-8 w-8 shrink-0 place-items-center rounded-interactive bg-foreground/[0.04] text-muted-foreground/80 group-hover:text-accent-text dark:bg-foreground/[0.06]">
      <Icon className="h-[1em] w-[1em] text-body" aria-hidden />
    </span>
    <span className="min-w-0">
      <span className="block text-body font-medium text-foreground">
        {title}
      </span>
      <span className={cn('mt-0.5 block', CANVAS_TEXT_SECONDARY)}>
        {description}
      </span>
    </span>
  </button>
);

export const ProjectOverviewPane: React.FC<{
  projectId: string;
  onSelectTab: (tab: ProjectTab) => void;
}> = ({ projectId, onSelectTab }) => {
  const { t } = useTranslation('project');
  useProjectTaskRealtime(projectId);
  const inbox = useProjectTaskStore(
    (state) => state.byProjectId[projectId]?.inbox ?? [],
  );
  const isLoading = useProjectTaskStore((state) => {
    const bucket = state.byProjectId[projectId];
    return !bucket || (bucket.inboxLoading && bucket.inbox.length === 0);
  });

  return (
    <section
      className="flex flex-col gap-6"
      aria-labelledby="project-overview-title"
    >
      <WorkspaceSectionHeader
        titleId="project-overview-title"
        eyebrow={t('navigation.overview')}
        title={t('overview.title')}
        description={t('overview.description')}
      />

      <div className="grid gap-4 xl:grid-cols-5">
        <section className="rounded-[12px] bg-foreground/[0.03] p-5 dark:bg-foreground/[0.04] xl:col-span-3">
          <div className="flex items-center gap-2">
            <Inbox
              className="h-[1em] w-[1em] text-body text-accent-text"
              aria-hidden
            />
            <h3 className="text-subtitle font-medium text-foreground">
              {t('overview.myWork')}
            </h3>
          </div>
          {isLoading ? (
            <div className="flex min-h-40 items-center justify-center text-muted-foreground/60">
              <Loader2
                className="h-5 w-5 animate-spin"
                aria-label={t('overview.loading')}
              />
            </div>
          ) : inbox.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center px-4 py-8 text-center">
              <span className="inline-grid h-10 w-10 place-items-center rounded-full bg-foreground/[0.04] text-muted-foreground/60 dark:bg-foreground/[0.06]">
                <CheckSquare2 className="h-4 w-4" aria-hidden />
              </span>
              <p className="mt-3 text-body font-medium text-foreground">
                {t('overview.empty')}
              </p>
              <p className={cn('mt-1 max-w-sm', CANVAS_TEXT_SECONDARY)}>
                {t('overview.emptyDescription')}
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-1">
              {inbox.slice(0, 5).map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onSelectTab('tasks')}
                  className="flex w-full items-center justify-between gap-3 rounded-interactive px-3 py-2.5 text-left hover:bg-foreground/[0.04]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-body font-medium text-foreground">
                      {task.title}
                    </span>
                    <span
                      className={cn(
                        CANVAS_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      {task.assignment_status === 'pending'
                        ? t('status.pendingConfirmation')
                        : task.assignment_status === 'rejected'
                          ? t('status.rejected')
                          : task.work_status === 'in_progress' ||
                              task.work_status === 'in_review'
                            ? t('status.inProgress')
                            : t('status.accepted')}
                    </span>
                  </span>
                  <span
                    className={cn(
                      CANVAS_TEXT_MICRO,
                      'shrink-0 text-accent-text',
                    )}
                  >
                    {t('overview.open')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-[12px] bg-foreground/[0.03] p-3 dark:bg-foreground/[0.04] xl:col-span-2">
          <h3 className="px-2 pb-1 pt-1 text-subtitle font-medium text-foreground">
            {t('overview.quickStart')}
          </h3>
          <QuickStartAction
            Icon={CheckSquare2}
            title={t('overview.tasksTitle')}
            description={t('overview.tasksDescription')}
            onClick={() => onSelectTab('tasks')}
          />
          <QuickStartAction
            Icon={Boxes}
            title={t('overview.assetsTitle')}
            description={t('overview.assetsDescription')}
            onClick={() => onSelectTab('assets')}
          />
        </section>
      </div>
    </section>
  );
};
