/**
 * InputScopePickers — Cmd+K 输入框的 @ / # / in: 触发选择器（PRD 3.11）
 *
 * 解析规则：
 * - 输入末段以 `@` 开头（无空格） → 显示 Agent Picker
 * - 输入末段以 `#` 开头（无空格） → 显示 Type Picker
 * - 输入末段以 `in:` 开头（无空格） → 显示 Space Picker
 * - 选中后：
 *   - 设置对应 scope state（scopeAgent / typeTab+resourceSubtype / scopeSpace）
 *   - 把 `@xxx` / `#xxx` / `in:xxx` 文本从 rawInput 中移除（不污染搜索关键词）
 *
 * 设计取舍：
 * - 这里要的是纯"选 Agent 用作筛选"的 Picker，不带 startDraftSession 副作用
 * - **不**改 unifiedSearch 协议，agent_id / item_type / space_id 走现有参数
 * - 三种 Picker 同时只能一个 open；query 解析失败时全关
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Folder, Tag } from 'lucide-react'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@tabtin/smartsheet-ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { contextRegistry } from '@components/context-space/registry'
import { RESULT_TYPE_EMOJI } from '../i18n'
import type { FtsResultType } from '@tabtin/app-shell'

// ── 解析 ─────────────────────────────────────────────

export type ActiveScopePicker = 'agent' | 'type' | 'space' | null

export interface ScopeQueryParse {
  /** 当前激活的 Picker 类型 */
  picker: ActiveScopePicker
  /** Picker 内的搜索关键字（去掉前缀的部分） */
  pickerQuery: string
  /** 触发 picker 的前缀在 rawInput 中的起始位置（用于选中后回填） */
  prefixStart: number
}

/**
 * 解析输入字符串：检测末段是否以 @/#/in: 开头。
 *
 * 规则：
 * - 找到最后一个空格之后的"末段"
 * - 末段以 `@` / `#` 开头 → 对应 picker；剩余字符（去前缀）作为 picker 内搜索词
 * - 末段以 `in:` 开头 → space picker
 * - 都不命中 → null
 *
 * 注意：用"末段"而非"开头"，让用户可以先输入 "性能 @CodeBot" 这种自然语序。
 */
export function parseScopeTrigger(input: string): ScopeQueryParse {
  if (!input) return { picker: null, pickerQuery: '', prefixStart: -1 }
  // 找最后一个空格的位置；末段 = 空格之后到末尾
  const lastSpace = input.lastIndexOf(' ')
  const tail = input.slice(lastSpace + 1)
  if (tail.startsWith('in:')) {
    return { picker: 'space', pickerQuery: tail.slice(3), prefixStart: lastSpace + 1 }
  }
  if (tail.startsWith('@')) {
    return { picker: 'agent', pickerQuery: tail.slice(1), prefixStart: lastSpace + 1 }
  }
  if (tail.startsWith('#')) {
    return { picker: 'type', pickerQuery: tail.slice(1), prefixStart: lastSpace + 1 }
  }
  return { picker: null, pickerQuery: '', prefixStart: -1 }
}

/** 把 rawInput 中触发 picker 的那段（@xxx / #xxx / in:xxx）从输入中移除 */
export function removeScopeTrigger(input: string, prefixStart: number): string {
  if (prefixStart < 0) return input
  return input.slice(0, prefixStart).trimEnd()
}

// ── Pickers UI ─────────────────────────────────────────

export interface ScopePickerCallbacks {
  /** 选中 Agent：传入 agent_id（来自 space.execution_agent_id 或 agent_id）+ 显示名 */
  onSelectAgent: (agentId: string, name: string) => void
  /** 选中 Type：传入 result type + 可选的资源子类型 */
  onSelectType: (type: FtsResultType, resourceSubtype?: string) => void
  /** 选中 Space：传入 space.id + name */
  onSelectSpace: (spaceId: string, name: string) => void
  /** 用户取消 picker（按 ESC / 删除前缀） */
  onCancel: () => void
}

interface InputScopePickersProps {
  /** 当前 picker 状态（null 时关闭） */
  active: ActiveScopePicker
  /** Picker 内搜索关键字（已去前缀） */
  pickerQuery: string
  /** 输入框 anchor element（PopoverAnchor 用） */
  anchorRef: React.RefObject<HTMLDivElement | null>
  /** Picker 容器（默认 Portal 到 body；测试可注入自定义容器） */
  container?: HTMLElement | null
  /** 回调 */
  callbacks: ScopePickerCallbacks
}

const RESOURCE_SUBTYPES: string[] = [
  'tabdoc', 'tabdata', 'tabslide', 'tabcode', 'tabsite',
]

const RESULT_TYPES: FtsResultType[] = ['message', 'resource', 'agent', 'space', 'memo', 'im']

export function InputScopePickers({ active, pickerQuery, anchorRef, container, callbacks }: InputScopePickersProps) {
  const { t } = useTranslation('globalSearch')
  const spaces = useSpaceStore((s) => s.spaces)
  const agentCache = useSpaceStore((s) => s.agentCache)
  // 跟主搜索一致：scope picker 也按当前 organization 强过滤。否则 @ / in: 列表里
  // 出现其他 organization 的 Agent/Space，选中后再用当前 organization 的 organization_id
  // 收窄搜索会得到 0 结果，体验割裂。
  const selectedOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)

  // Agent 列表（从当前 organization 的 workspace 兼容关联派生）
  const agentOptions = useMemo(() => {
    const out: Array<{ agentId: string; name: string; icon?: string | null; spaceId: string }> = []
    for (const space of spaces) {
      if (space.type !== 'workspace' || space.is_archived) continue
      if (selectedOrganizationId && space.organization_id !== selectedOrganizationId) continue
      const aid = space.execution_agent_id ?? space.agent_id
      if (!aid) continue
      const agent = agentCache[aid]
      out.push({
        agentId: aid,
        name: agent?.name || space.name,
        icon: space.icon ?? null,
        spaceId: space.id,
      })
    }
    if (!pickerQuery) return out.slice(0, 20)
    const q = pickerQuery.toLowerCase()
    return out.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 20)
  }, [spaces, agentCache, pickerQuery, selectedOrganizationId])

  // Space 列表（当前 organization 全部非归档）
  const spaceOptions = useMemo(() => {
    const out = spaces
      .filter((s) => !s.is_archived && (!selectedOrganizationId || s.organization_id === selectedOrganizationId))
      .map((s) => ({ id: s.id, name: s.name, icon: s.icon ?? null }))
    if (!pickerQuery) return out.slice(0, 20)
    const q = pickerQuery.toLowerCase()
    return out.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 20)
  }, [spaces, pickerQuery, selectedOrganizationId])

  // 类型列表（6 result type + 7 资源子类型）
  const typeOptions = useMemo(() => {
    const items: Array<{ key: string; label: string; icon: string; type: FtsResultType; subtype?: string }> = []
    for (const t of RESULT_TYPES) {
      items.push({
        key: t,
        label: t,
        icon: RESULT_TYPE_EMOJI[t],
        type: t,
      })
    }
    for (const sub of RESOURCE_SUBTYPES) {
      items.push({
        key: `resource:${sub}`,
        label: contextRegistry.getDisplayLabel(sub),
        icon: contextRegistry.getDisplayEmoji(sub) || RESULT_TYPE_EMOJI.resource,
        type: 'resource',
        subtype: sub,
      })
    }
    if (!pickerQuery) return items.slice(0, 20)
    const q = pickerQuery.toLowerCase()
    return items.filter((it) => it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q)).slice(0, 20)
  }, [pickerQuery])

  return (
    <Popover open={active !== null} onOpenChange={(open) => { if (!open) callbacks.onCancel() }}>
      {/* virtualRef：让 Popover 内容锚定到外部 anchorRef 元素（GlobalSearch 输入框容器） */}
      <PopoverAnchor virtualRef={anchorRef as unknown as React.RefObject<{ getBoundingClientRect(): DOMRect }>} />
      {active === 'agent' && (
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          container={container}
          className="w-[320px] p-1"
          onOpenAutoFocus={(e) => e.preventDefault()}  // 不抢输入框焦点
        >
          <div className="px-2 py-1 text-caption text-muted-foreground/60 flex items-center gap-1.5">
            <Bot className="h-3 w-3" />
            <span>{t('picker.agentTitle', '选择 Agent 筛选范围')}</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto" data-testid="scope-picker-agent-list">
            {agentOptions.length === 0 ? (
              <div className="py-3 text-center text-caption text-muted-foreground/60">
                {t('picker.noAgents', '没有匹配的 Agent')}
              </div>
            ) : (
              agentOptions.map((a) => (
                <button
                  key={a.agentId}
                  type="button"
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors hover:bg-muted/30"
                  onClick={() => callbacks.onSelectAgent(a.agentId, a.name)}
                >
                  <span className="h-5 w-5 rounded-md flex items-center justify-center text-caption shrink-0 bg-accent/10 text-accent overflow-hidden">
                    {a.icon
                      ? (a.icon.startsWith('http')
                          ? <img src={a.icon} alt="" className="h-5 w-5 object-cover" />
                          : <span>{a.icon}</span>)
                      : a.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="text-body text-foreground/80 truncate">{a.name}</span>
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      )}
      {active === 'type' && (
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          container={container}
          className="w-[320px] p-1"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="px-2 py-1 text-caption text-muted-foreground/60 flex items-center gap-1.5">
            <Tag className="h-3 w-3" />
            <span>{t('picker.typeTitle', '选择类型筛选')}</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto" data-testid="scope-picker-type-list">
            {typeOptions.length === 0 ? (
              <div className="py-3 text-center text-caption text-muted-foreground/60">
                {t('picker.noTypes', '没有匹配的类型')}
              </div>
            ) : (
              typeOptions.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors hover:bg-muted/30"
                  onClick={() => callbacks.onSelectType(it.type, it.subtype)}
                >
                  <span className="text-subtitle leading-none shrink-0 w-5 text-center" aria-hidden="true">
                    {it.icon}
                  </span>
                  <span className="text-body text-foreground/80 truncate">
                    {it.label}
                    {it.subtype && (
                      <span className="text-caption text-muted-foreground/60 ml-1">
                        ({t('picker.resourceSubtypeBadge', '资源子类型')})
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      )}
      {active === 'space' && (
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          container={container}
          className="w-[320px] p-1"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="px-2 py-1 text-caption text-muted-foreground/60 flex items-center gap-1.5">
            <Folder className="h-3 w-3" />
            <span>{t('picker.spaceTitle', '选择 Space 范围')}</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto" data-testid="scope-picker-space-list">
            {spaceOptions.length === 0 ? (
              <div className="py-3 text-center text-caption text-muted-foreground/60">
                {t('picker.noSpaces', '没有匹配的 Space')}
              </div>
            ) : (
              spaceOptions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left transition-colors hover:bg-muted/30"
                  onClick={() => callbacks.onSelectSpace(s.id, s.name)}
                >
                  <span className="h-5 w-5 rounded-md flex items-center justify-center text-caption shrink-0 bg-muted/40 overflow-hidden">
                    {s.icon
                      ? (s.icon.startsWith('http')
                          ? <img src={s.icon} alt="" className="h-5 w-5 object-cover" />
                          : <span>{s.icon}</span>)
                      : '📁'}
                  </span>
                  <span className="text-body text-foreground/80 truncate">{s.name}</span>
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      )}
    </Popover>
  )
}
