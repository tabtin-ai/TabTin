/**
 * ResourceOpenPreferencesPanel —— W4「Agent 产物在 Space 内的打开」
 *
 * 类似 macOS "默认应用" 面板：用户配置「哪种内容默认用哪个 App 打开」。
 * 优先级表（PRD §4 D2 五层）由 ResourceRouter.resolve 严格执行，本面板
 * 只管 D2 第 1 层 user_pref 数据源——写入 useResourceOpenPreferences
 * zustand store，router 实时读取。
 *
 * D1 红线：表格行 / 下拉选项 **完全从 manifest opens 动态生成**，不硬编码 App 名单：
 *   - 行（资源类型 / URL 协议）来自 `resourceRouterRegistry.knownTypes() / knownSchemes()`
 *   - 下拉选项来自 `resourceRouterRegistry.lookupByType / lookupByScheme`
 *
 * L19 行为说明（顶部 / 列表下方文案明示）：用户偏好的 X 不可用（如卸载该 App
 * / 该 App 没声明 opens）时，**自动降级到 manifest 默认载体**（不跳系统应用），
 * 保留偏好以便重装后自动恢复。
 *
 * 不做的事（PRD/RFC 明确拒绝清单）：
 *   - 不写后端 user_preferences API（mobile 单独专题）
 *   - 不按 pointer.id 维度（如"始终用 X 打开 https://github.com/*"——R12 拒绝）
 *   - 不允许"完全关闭某 scheme"（D4 红线：偏好 store 不是 deny 层）
 */

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, RotateCcw, Trash2 } from 'lucide-react'
import { ConfirmDialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@components/ui'
import { resourceRouterRegistry } from '@/services/resourceRouter'
import { useResourceOpenPreferences } from '@/stores/useResourceOpenPreferences'
import { contextRegistry } from '@/components/context-space/registry/instance'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SETTINGS_HINT, SETTINGS_SELECT_TRIGGER, SETTINGS_TEXT_META } from '../settingsUi'
import { cn } from '@utils/cn'

// ─── 行（资源类型 / URL 协议）─────────────────────────────────────────

interface PrefRow {
  /** 偏好 key——store 用这个 key 写入；与 router.preferenceKeyOf 共识 */
  prefKey: string
  /** 显示给用户的标签——type 名 / scheme 字面量 */
  rowLabel: string
  /** 候选载体（从 manifest opens 动态生成；按 priority desc 排序） */
  carriers: CarrierOption[]
}

interface CarrierOption {
  appId: string
  /** ContextRegistry handler 反查的 displayLabel（如 'TabData'）；缺则用 appId */
  label: string
  emoji?: string
  /** 该 App handler 是否真注册（false 表示 manifest 声明了但 handler 文件不存在） */
  available: boolean
}

function buildCarrierOptions(
  registered: ReadonlyArray<{ appId: string; priority: number }>,
): CarrierOption[] {
  return registered.map((r) => {
    const handler = contextRegistry.getHandlerByAppId(r.appId)
    return {
      appId: r.appId,
      label: handler?.displayLabel ?? r.appId,
      emoji: handler?.displayEmoji,
      available: handler !== undefined,
    }
  })
}

// ─── Panel ───────────────────────────────────────────────────────────

interface ResourceOpenPreferencesPanelProps {
  /** 嵌入模式：只渲染内容主体，由外层「AI 设置」页提供页眉与滚动容器。 */
  embedded?: boolean
}

export const ResourceOpenPreferencesPanel: React.FC<ResourceOpenPreferencesPanelProps> = ({ embedded = false }) => {
  const { t } = useTranslation('settings')

  const preferences = useResourceOpenPreferences((s) => s.preferences)
  const setPreference = useResourceOpenPreferences((s) => s.setPreference)
  const clearPreference = useResourceOpenPreferences((s) => s.clearPreference)
  const clearAllPreferences = useResourceOpenPreferences((s) => s.clearAllPreferences)

  // 「清空全部偏好」是 destructive 操作——加 confirm 防止误触（review B P1-2）
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false)

  // typeRows / schemeRows 仅在 manifest 启动期变化（实际只一次）；不依赖
  // preferences——避免每次写入偏好都重新构造行结构。preferences 单独通过
  // selector 读，写入只触发对应 row 的 select 受控值变化。
  const { typeRows, schemeRows } = useMemo<{
    typeRows: PrefRow[]
    schemeRows: PrefRow[]
  }>(() => {
    const types = resourceRouterRegistry
      .knownTypes()
      .slice()
      .sort((a, b) => a.localeCompare(b))
    const schemes = resourceRouterRegistry
      .knownSchemes()
      .slice()
      .sort((a, b) => a.localeCompare(b))

    return {
      typeRows: types.map((type) => ({
        prefKey: `type:${type}`,
        rowLabel: type,
        carriers: buildCarrierOptions(resourceRouterRegistry.lookupByType(type)),
      })),
      schemeRows: schemes.map((scheme) => ({
        prefKey: `scheme:${scheme}`, // scheme 已含尾冒号
        rowLabel: scheme,
        carriers: buildCarrierOptions(resourceRouterRegistry.lookupByScheme(scheme)),
      })),
    }
  }, [])

  const totalPrefs = Object.keys(preferences).length

  const body = (
    <>
      <div className="space-y-8">
        {totalPrefs > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setConfirmClearAllOpen(true)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5',
                'hover:text-foreground', SETTINGS_TEXT_META,
                'hover:bg-muted/30 transition-colors',
              )}
              data-testid="resource-open-preferences-clear-all-trigger"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              {t('resourceOpenPreferences.clearAll', {
                defaultValue: '清空全部偏好',
                count: totalPrefs,
              })}
            </button>
          </div>
        )}

        {/* ── 资源类型 ── */}
        <div data-testid="resource-open-preferences-types">
          <SettingsSectionCard
            title={t('resourceOpenPreferences.typesSection', { defaultValue: '资源类型（自有格式）' })}
          >
            {typeRows.length === 0 ? (
              <EmptyHint
                text={t('resourceOpenPreferences.typesEmpty', {
                  defaultValue: '当前没有 App 声明能打开任何资源类型。',
                })}
              />
            ) : (
              <PrefTable
                rows={typeRows}
                preferences={preferences}
                onChange={setPreference}
                onReset={clearPreference}
                t={t}
              />
            )}
          </SettingsSectionCard>
        </div>

        {/* ── URL 协议 ── */}
        <div data-testid="resource-open-preferences-schemes">
          <SettingsSectionCard
            title={t('resourceOpenPreferences.schemesSection', { defaultValue: 'URL 协议（行业格式）' })}
          >
            {schemeRows.length === 0 ? (
              <EmptyHint
                text={t('resourceOpenPreferences.schemesEmpty', {
                  defaultValue: '当前没有 App 声明能处理任何 URL 协议。',
                })}
              />
            ) : (
              <PrefTable
                rows={schemeRows}
                preferences={preferences}
                onChange={setPreference}
                onReset={clearPreference}
                t={t}
              />
            )}
          </SettingsSectionCard>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClearAllOpen}
        onOpenChange={setConfirmClearAllOpen}
        title={t('resourceOpenPreferences.clearAllConfirmTitle', {
          defaultValue: '清空全部偏好？',
        })}
        description={t('resourceOpenPreferences.clearAllConfirmDescription', {
          defaultValue:
            '这将删除你为所有资源类型 / URL 协议设置的默认 App。后续点击链接将回到系统推荐的载体。此操作不可撤销。',
        })}
        confirmText={t('resourceOpenPreferences.clearAllConfirmAction', {
          defaultValue: '清空',
        })}
        cancelText={t('resourceOpenPreferences.clearAllConfirmCancel', {
          defaultValue: '取消',
        })}
        variant="destructive"
        onConfirm={() => {
          clearAllPreferences()
          setConfirmClearAllOpen(false)
        }}
      />
    </>
  )

  if (embedded) {
    return body
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<ExternalLink className="h-4 w-4" />}
        title={t('resourceOpenPreferences.title', { defaultValue: '默认打开方式' })}
        subtitle={t('resourceOpenPreferences.description', {
          defaultValue:
            '当 Agent 给你一个链接、或你点击 chat 里的链接时，这里设置默认用哪个 App 打开。',
        })}
      />
      {body}
    </SettingsPanelLayout>
  )
}

// ─── 表格 ────────────────────────────────────────────────────────────

interface PrefTableProps {
  rows: PrefRow[]
  preferences: Record<string, string>
  onChange: (prefKey: string, carrierAppId: string) => void
  onReset: (prefKey: string) => void
  t: ReturnType<typeof useTranslation>['t']
}

const PrefTable: React.FC<PrefTableProps> = ({
  rows,
  preferences,
  onChange,
  onReset,
  t,
}) => {
  return (
    <div className="divide-y divide-border/20">
      {rows.map((row) => {
        const currentPref = preferences[row.prefKey]
        const isUsingDefault = !currentPref
        return (
          <div
            key={row.prefKey}
            data-testid={`pref-row-${row.prefKey}`}
            className="flex items-center gap-3 py-3"
          >
            <code className="text-body font-mono text-foreground min-w-0 flex-shrink-0 truncate w-[140px]">
              {row.rowLabel}
            </code>

            <Select
              value={currentPref ?? '__default__'}
              onValueChange={(v) => {
                if (v === '__default__') {
                  onReset(row.prefKey)
                } else {
                  onChange(row.prefKey, v)
                }
              }}
            >
              <SelectTrigger
                data-testid={`pref-select-${row.prefKey}`}
                aria-label={t('resourceOpenPreferences.selectCarrier', {
                  defaultValue: '选择默认载体：{{row}}',
                  row: row.rowLabel,
                })}
                className={cn('flex-1 min-w-0', SETTINGS_SELECT_TRIGGER)}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">
                  {t('resourceOpenPreferences.optionDefault', {
                    defaultValue: '默认推荐（按优先级）',
                  })}
                </SelectItem>
                {row.carriers.length === 0 && (
                  <SelectItem value="__none__" disabled>
                    {t('resourceOpenPreferences.noCarrier', {
                      defaultValue: '（无可用载体）',
                    })}
                  </SelectItem>
                )}
                {row.carriers.map((c) => (
                  <SelectItem key={c.appId} value={c.appId}>
                    {c.emoji ? `${c.emoji} ` : ''}
                    {c.label}
                    {!c.available
                      ? ` ${t('resourceOpenPreferences.optionUnavailableSuffix', {
                          defaultValue: '（暂不可用）',
                        })}`
                      : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <button
              type="button"
              onClick={() => onReset(row.prefKey)}
              disabled={isUsingDefault}
              aria-label={t('resourceOpenPreferences.reset', {
                defaultValue: '重置 {{row}} 为默认',
                row: row.rowLabel,
              })}
              className={cn(
                'inline-flex items-center justify-center rounded-md',
                'h-7 w-7 text-muted-foreground/60',
                'hover:text-foreground hover:bg-muted/30',
                'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60',
                'transition-colors',
              )}
              data-testid={`pref-reset-${row.prefKey}`}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}

const EmptyHint: React.FC<{ text: string }> = ({ text }) => (
  <p className={cn(SETTINGS_HINT, 'py-3 px-3 rounded-md border border-dashed border-border/30')}>
    {text}
  </p>
)

export default ResourceOpenPreferencesPanel
