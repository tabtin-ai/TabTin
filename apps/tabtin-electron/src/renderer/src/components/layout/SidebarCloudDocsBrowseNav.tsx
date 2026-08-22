/**
 * SidebarCloudDocsBrowseNav — 云文档侧栏顶部分段：全部 / 最近 / 分享给我。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { SIDEBAR_EMBEDDED_CONTROL_INSET, SIDEBAR_TEXT_META } from './sidebarUi'
import type { CloudDocsBrowseView } from './cloudDocsOpenTabs'

const BROWSE_VIEWS: CloudDocsBrowseView[] = ['all', 'recent', 'shared']

const LABEL_KEYS: Record<CloudDocsBrowseView, { key: string; defaultValue: string }> = {
  all: { key: 'sidebar:cloudDocs.browse.all', defaultValue: '全部' },
  recent: { key: 'sidebar:cloudDocs.browse.recent', defaultValue: '最近' },
  shared: { key: 'sidebar:cloudDocs.browse.shared', defaultValue: '分享给我' },
}

const HINT_KEYS: Partial<Record<CloudDocsBrowseView, { key: string; defaultValue: string }>> = {
  recent: {
    key: 'sidebar:cloudDocs.browse.recentHint',
    defaultValue: '按访问时间排序的历史记录，不限于当前是否还开着',
  },
  shared: {
    key: 'sidebar:cloudDocs.browse.sharedHint',
    defaultValue: '他人分享给你的文档与表格',
  },
}

interface SidebarCloudDocsBrowseNavProps {
  value: CloudDocsBrowseView
  onChange: (view: CloudDocsBrowseView) => void
}

export const SidebarCloudDocsBrowseNav: React.FC<SidebarCloudDocsBrowseNavProps> = ({
  value,
  onChange,
}) => {
  const { t } = useTranslation(['sidebar'])
  const hint = HINT_KEYS[value]

  return (
    <div
      className={cn('shrink-0 pb-2', SIDEBAR_EMBEDDED_CONTROL_INSET)}
      data-testid="cloud-docs-browse-nav"
    >
      <div
        className="grid grid-cols-3 gap-0.5 rounded-lg p-0.5 sidebar-segment-track"
        role="tablist"
        aria-label={t('sidebar:cloudDocs.browse.label', { defaultValue: '云文档浏览' })}
      >
        {BROWSE_VIEWS.map(view => {
          const active = value === view
          const { key, defaultValue } = LABEL_KEYS[view]
          return (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={active}
              className={cn(
                'truncate rounded-md px-2 py-1 text-center text-caption transition-colors',
                active
                  ? 'sidebar-segment-active font-medium text-foreground'
                  : 'text-muted-foreground/70 hover:text-foreground',
              )}
              onClick={() => onChange(view)}
            >
              {t(key, { defaultValue })}
            </button>
          )
        })}
      </div>
      {hint && (
        <p className={cn('mt-1.5 px-0.5 leading-snug', SIDEBAR_TEXT_META, 'text-muted-foreground/55')}>
          {t(hint.key, { defaultValue: hint.defaultValue })}
        </p>
      )}
    </div>
  )
}

SidebarCloudDocsBrowseNav.displayName = 'SidebarCloudDocsBrowseNav'
