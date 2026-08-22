/**
 * 系统权限分组列表
 *
 * 按用途分组（数据 / 屏幕与控制 / 输入设备 / 输出）。
 *
 * 跨平台策略：
 *  - macOS：完整展示所有 7 项
 *  - Windows：完全磁盘 / 录屏 / 辅助功能 / 自动化 是 not-applicable，
 *    默认折叠在底部"已隐藏 N 项不适用权限"提示，不噪声化主列表。
 *  - Linux：所有项都是 not-applicable，整体折叠。
 */

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  PERMISSION_GROUPS,
  type PermissionDescriptor,
  type PermissionKind,
  type PermissionGroupKey,
} from './permissionConfig'
import { SystemPermissionRow } from './SystemPermissionRow'
import { SETTINGS_FIELD_TITLE, SETTINGS_TEXT_META } from '../../settingsUi'
import { cn } from '@utils/cn'

interface Props {
  items: PermissionDescriptor[]
  onRequest: (kind: PermissionKind) => Promise<void>
  onOpenSettings: (kind: PermissionKind) => Promise<void>
}

export const SystemPermissionsList: React.FC<Props> = ({
  items,
  onRequest,
  onOpenSettings,
}) => {
  const { t } = useTranslation('settings')
  const [showNotApplicable, setShowNotApplicable] = useState(false)

  const byKind = useMemo(() => {
    const m = new Map<PermissionKind, PermissionDescriptor>()
    for (const it of items) m.set(it.kind, it)
    return m
  }, [items])

  // 把每个 group 切成"可用"和"不适用"两部分
  const renderedGroups = useMemo(() => {
    return PERMISSION_GROUPS.map((group) => {
      const visible: PermissionDescriptor[] = []
      const notApplicable: PermissionDescriptor[] = []
      for (const kind of group.items) {
        const desc = byKind.get(kind)
        if (!desc) continue
        if (desc.status === 'not-applicable') {
          notApplicable.push(desc)
        } else {
          visible.push(desc)
        }
      }
      return { key: group.key, visible, notApplicable }
    })
  }, [byKind])

  const totalNotApplicable = renderedGroups.reduce(
    (sum, g) => sum + g.notApplicable.length,
    0,
  )

  return (
    <div className="space-y-5">
      {renderedGroups.map((group) => {
        if (group.visible.length === 0) return null
        return (
          <PermissionGroupSection
            key={group.key}
            groupKey={group.key}
            items={group.visible}
            onRequest={onRequest}
            onOpenSettings={onOpenSettings}
          />
        )
      })}

      {totalNotApplicable > 0 && (
        <div className="rounded-md border border-dashed border-border/40 bg-muted/10 px-3 py-2">
          <button
            type="button"
            className={cn(SETTINGS_TEXT_META, 'flex w-full items-center justify-between hover:text-muted-foreground')}
            onClick={() => setShowNotApplicable((v) => !v)}
            data-testid="permission-not-applicable-toggle"
          >
            <span>
              {t('authorizationSystem.notApplicableHint', { count: totalNotApplicable })}
            </span>
            {showNotApplicable ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          {showNotApplicable && (
            <div className="mt-2 space-y-3 pt-2 border-t border-border/30">
              {renderedGroups.map((group) =>
                group.notApplicable.length > 0 ? (
                  <PermissionGroupSection
                    key={`na-${group.key}`}
                    groupKey={group.key}
                    items={group.notApplicable}
                    onRequest={onRequest}
                    onOpenSettings={onOpenSettings}
                  />
                ) : null,
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface GroupSectionProps {
  groupKey: PermissionGroupKey
  items: PermissionDescriptor[]
  onRequest: (kind: PermissionKind) => Promise<void>
  onOpenSettings: (kind: PermissionKind) => Promise<void>
}

const PermissionGroupSection: React.FC<GroupSectionProps> = ({
  groupKey,
  items,
  onRequest,
  onOpenSettings,
}) => {
  const { t } = useTranslation('settings')
  return (
    <section className="space-y-1">
      <h4 className={cn(SETTINGS_FIELD_TITLE, 'px-2')}>
        {t(`authorizationSystem.groups.${groupKey}`)}
      </h4>
      <div className="rounded-lg border border-border/40 bg-background/40 divide-y divide-border/30">
        {items.map((descriptor) => (
          <SystemPermissionRow
            key={descriptor.kind}
            descriptor={descriptor}
            onRequest={() => onRequest(descriptor.kind)}
            onOpenSettings={() => onOpenSettings(descriptor.kind)}
          />
        ))}
      </div>
    </section>
  )
}
