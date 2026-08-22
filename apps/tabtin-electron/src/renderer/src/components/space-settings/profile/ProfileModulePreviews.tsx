/**
 * ProfileModulePreviews — Agent 档案各模块的预览节点
 *
 * 设计取向（呼吸感优先 · 文字至上）：
 * - inline 文本，` · ` 分隔；数字/账号名等"次要标识"用更淡的 caption 字色，避免与 · 分隔符抢注意力
 * - 不用 chip 灰底、不用图标、不用彩色装饰
 * - 未配置时一句友好的引导文案（更淡、italic 都不用）
 *
 * 每个 preview 按内容性质做了"专门适配"，不强行套同一模板：
 * - RulesPreview：保留前 N 条原文，每条一行
 * - MemoryPreview：total 前置 + 分类计数
 * - WorkingDirPreview：路径 + 类型 + 执行设备摘要（本机（在线）等）
 * - ChannelsPreview：渠道 + 后挂账号名（caption）
 * - 其余（Skills/Apps/Extensions/SubAgents/Sharing）保持名字列表 / 计数即可
 */
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useMemoRecordStyleStore } from '@stores/useMemoRecordStyleStore'
import { useSpaceApps, EMPTY_APPS, EMPTY_DISABLED_APPS } from '@stores/useSpaceApps'
import { useExtensionStore } from '@stores/useExtensionStore'
import { useChannelStore } from '@/stores/useChannelStore'
import { useSkillsListQuery } from '@/hooks/queries/skills'
import { normalizeSkillSource } from '@/skills/types'
import { SubAgentTemplateApi, type SubAgentTemplate } from '@/services/subagentTemplateApi'
import { RecordStyleApi, type AgentMemoStats } from '@/services/recordStyleApi'
import type { Agent, Device } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'
import { ModulePreviewHint, ItemList } from './ProfileModuleRow'

// 稳定的空数组常量——避免 zustand selector 每次返回新数组导致 infinite loop 警告
const EMPTY_DEVICES: Device[] = []

// ---------------------------------------------------------------------------
// 1. RulesPreview — 自定义规则
// ---------------------------------------------------------------------------

const MAX_RULE_LINES = 2

export const RulesPreview: React.FC<{
  /** ：现场规则读 Space/工作空间.custom_rules，不再读 Agent */
  space?: { custom_rules?: string | null } | null
}> = ({ space }) => {
  const { t } = useTranslation('space')
  const rules = (space?.custom_rules ?? '').trim()
  if (!rules) {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.rules', {
          defaultValue: '告诉 Agent 在这个工作空间里干活时要遵守的规则，比如代码风格、回复语言偏好。',
        })}
      </ModulePreviewHint>
    )
  }
  // 保留前 N 条规则原文 — 用左侧细 border + 略缩进做"引述块"装饰（markdown blockquote 范式）
  // 装饰是容器，内容是用户原文，不加编号、不改字
  const lines = rules.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const visible = lines.slice(0, MAX_RULE_LINES)
  const remaining = lines.length - visible.length
  return (
    <div className="border-l-2 border-border/60 pl-3 text-body text-foreground/80 leading-relaxed">
      {visible.map((line, i) => (
        <p key={i} className="truncate">
          {line}
        </p>
      ))}
      {remaining > 0 && (
        <p className="text-caption text-muted-foreground/60 mt-0.5">
          {t('profilePane.previewHints.rulesMore', {
            count: remaining,
            defaultValue: `还有 ${remaining} 条`,
          })}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. SkillsPreview — 技能（inline 名字列表）
// ---------------------------------------------------------------------------

const MAX_SKILL_ITEMS = 4

export const SkillsPreview: React.FC<{ spaceId: string }> = ({ spaceId }) => {
  const { t } = useTranslation('space')
  const { data: skills = [], isLoading } = useSkillsListQuery(spaceId)
  const profileSkills = useMemo(
    () => skills.filter((skill) => normalizeSkillSource(skill.source) === 'user'),
    [skills],
  )
  if (isLoading) {
    return <ModulePreviewHint>{t('profilePane.loading', { defaultValue: '加载中…' })}</ModulePreviewHint>
  }
  if (profileSkills.length === 0) {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.skills', {
          defaultValue: '安装 Skill 扩展 Tin 的能力，例如 Browser、TabData、TabDoc。',
        })}
      </ModulePreviewHint>
    )
  }
  const visible = profileSkills.slice(0, MAX_SKILL_ITEMS)
  const remaining = profileSkills.length - visible.length
  return (
    <ItemList
      items={visible.map((s) => s.name || s.skill_key || s.skill_id)}
      remaining={remaining}
    />
  )
}

export function useSkillsPreviewMeta(spaceId: string) {
  const { data: skills = [] } = useSkillsListQuery(spaceId)
  const count = skills.filter((skill) => normalizeSkillSource(skill.source) === 'user').length
  return { count: count || null }
}

// ---------------------------------------------------------------------------
// 3. ContextPreview — 对话上下文（长对话压缩策略）
// ---------------------------------------------------------------------------

export const ContextPreview: React.FC<{ agent: Agent | null }> = ({ agent }) => {
  const { t } = useTranslation('space')
  const strategy = agent?.agent_config?.memory?.working_memory?.strategy ?? 'auto_condense'

  if (strategy === 'prune_only') {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.contextPruneOnly', {
          defaultValue: '仅裁剪历史消息，不生成摘要。',
        })}
      </ModulePreviewHint>
    )
  }

  return (
    <ModulePreviewHint>
      {t('profilePane.previewHints.contextAutoCondense', {
        defaultValue: '长对话自动压缩摘要，保留关键上下文。',
      })}
    </ModulePreviewHint>
  )
}

// ---------------------------------------------------------------------------
// 4. MemoryPreview — Agent 记忆统计（保留供其他入口复用）
// ---------------------------------------------------------------------------

export const MemoryPreview: React.FC<{ space: { id: string; organization_id: string } }> = ({
  space,
}) => {
  const { t } = useTranslation('space')
  // 记忆「记=用」(TM-10 批 B / 方案一)：记忆闸门从 per-Agent
  // （agent_config.memory.enabled）迁到 per-(user, organization) 的 MemoRecordStyle.enabled，
  // 读 useMemoRecordStyleStore 缓存（与 local 注入 / daemon 注入同一权威）。未加载
  // 默认 true（与服务端"查无记录默认开"一致），挂载时 ensureLoaded 预拉一次。
  const enabled = useMemoRecordStyleStore((s) =>
    space.organization_id ? (s.enabledByOrganization[space.organization_id] ?? true) : true,
  )
  const ensureRecordStyleLoaded = useMemoRecordStyleStore((s) => s.ensureLoaded)
  const [stats, setStats] = useState<AgentMemoStats | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void ensureRecordStyleLoaded(space.organization_id)
  }, [ensureRecordStyleLoaded, space.organization_id])

  useEffect(() => {
    if (!enabled || !space.organization_id || !space.id) {
      setStats(null)
      return
    }
    let cancelled = false
    setLoading(true)
    RecordStyleApi.getAgentStats({
      organization_id: space.organization_id,
      space_id: space.id,
    })
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch(() => {
        if (!cancelled) setStats(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, space.id, space.organization_id])

  if (!enabled) {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.memoryOff', {
          defaultValue: '请在组织服务的「记忆偏好」设置中开启，Tin 会自动记住你的偏好、任务经验和可复用的 Skill。',
        })}
      </ModulePreviewHint>
    )
  }
  if (loading) {
    return <ModulePreviewHint>{t('profilePane.loading', { defaultValue: '加载中…' })}</ModulePreviewHint>
  }

  const aboutYou = stats?.about_you ?? 0
  const insight = stats?.insight ?? 0
  const taskSummary = stats?.task_summary ?? 0
  const fragments = aboutYou + insight
  const total = fragments + taskSummary

  // 极简空态（启用了但还没积累）：一句话引导，不堆 0
  if (total === 0) {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.memoryEmpty', {
          defaultValue: '已启用，正在等 Tin 从对话里积累偏好和经验。',
        })}
      </ModulePreviewHint>
    )
  }

  // 数字 medium + tabular 让"累积量"成为视觉锚（这是 stats 性质内容应有的形态）
  // 顺序：偏好 N · 经验 N · 技能 N · 共 N
  const num = (n: number) => (
    <span className="font-medium tabular-nums text-foreground">{n}</span>
  )
  const sep = <span className="text-muted-foreground/40 mx-1.5">·</span>
  return (
    <p className="text-body text-muted-foreground leading-relaxed">
      <span>{t('profilePane.memoryStats.fragments', { defaultValue: '偏好' })} {num(fragments)}</span>
      {sep}
      <span>{t('profilePane.memoryStats.tasks', { defaultValue: '经验' })} {num(taskSummary)}</span>
      {sep}
      <span className="text-muted-foreground/80">
        {t('profilePane.memoryStats.totalSuffix', {
          count: total,
          defaultValue: `共 ${total}`,
        })}
      </span>
    </p>
  )
}

// ---------------------------------------------------------------------------
// 4. WorkingDirPreview — 工作目录 + 执行设备摘要
// ---------------------------------------------------------------------------

/** 把 ISO 时间格式化成"5 分钟前 / 2 小时前 / 3 天前 / 日期"——离线设备用 */
function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return null
  const diffMs = Date.now() - ts
  if (diffMs < 60_000) return '刚刚'
  const min = Math.floor(diffMs / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  return new Date(ts).toLocaleDateString()
}

type BoundDeviceSpaceRef = {
  control_device_id?: string | null
  bound_device_id?: string | null
} | null | undefined

function resolveBoundDeviceId(
  agent: Agent | null,
  space?: BoundDeviceSpaceRef,
): string | null {
  return (
    space?.control_device_id
    ?? space?.bound_device_id
    ?? agent?.control_device_id
    ?? agent?.bound_device_id
    ?? null
  )
}

/** WorkingDirPreview 第二行用的设备摘要：本机（在线）/ 设备名（离线 · …） */
function useBoundDeviceSummary(
  agent: Agent | null,
  space?: BoundDeviceSpaceRef,
): { unbound: boolean; summary: string | null } {
  const { t } = useTranslation('space')
  const devices = useDeviceStore((s) => s.devices ?? EMPTY_DEVICES)
  const currentDeviceId = useDeviceStore((s) => s.currentDevice?.id ?? null)
  const boundDeviceId = resolveBoundDeviceId(agent, space)
  const boundDevice = boundDeviceId ? devices.find((d) => d.id === boundDeviceId) : null

  return useMemo(() => {
    if (!boundDeviceId) {
      return { unbound: true, summary: null }
    }
    if (!boundDevice) {
      return {
        unbound: false,
        summary: t('profilePane.previewHints.deviceBoundUnknown', {
          defaultValue: '已绑定执行设备',
        }),
      }
    }

    const isLocal = currentDeviceId === boundDevice.id
    const name = isLocal ? t('profilePane.thisDevice', { defaultValue: '本机' }) : boundDevice.name
    const isOnline = boundDevice.status === 'online'
    const isBusy = boundDevice.status === 'busy'
    const status = isOnline
      ? t('device.online', { defaultValue: '在线' })
      : isBusy
        ? t('device.busy', { defaultValue: '忙碌' })
        : t('device.offline', { defaultValue: '离线' })
    const lastSeen = !isOnline && !isBusy
      ? formatRelativeTime(boundDevice.last_heartbeat_at)
      : null
    const statusInside = lastSeen ? `${status} · ${lastSeen}` : status

    return {
      unbound: false,
      summary: `${name}（${statusInside}）`,
    }
  }, [boundDevice, boundDeviceId, currentDeviceId, t])
}

/**
 * WorkingDirPreview — 工作目录 + 执行设备合一展示（PRD §4）
 *   - 未设置：提示去补（含设备绑定语义）
 *   - 失效：红色警告（仅在本机为执行设备时做 pathExists 探测）
 *   - 远程 / 本机：path + 类型 + 设备摘要（本机（在线）等）
 *
 * 实际编辑表单在 ProfileWorkingDirForm（侧边 sheet，内含设备绑定），这里只负责 preview。
 */
export const WorkingDirPreview: React.FC<{
  agent: Agent | null
  space?: {
    id?: string
    working_dir?: string | null
    working_dir_type?: string | null
    control_device_id?: string | null
    bound_device_id?: string | null
  } | null
}> = ({ agent, space }) => {
  const { t } = useTranslation('space')
  const remoteViewer = useIsRemoteViewer(space?.id)
  const { unbound: deviceUnbound, summary: deviceSummary } = useBoundDeviceSummary(agent, space)
  // ：执行根只认 Space.working_dir；Agent 纯化后可能带空串，不得盖住 Space。
  const workingDir = space?.working_dir || agent?.working_dir || ''
  const workingDirType = (space?.working_dir_type || agent?.working_dir_type || '') as string
  const [pathExists, setPathExists] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    if (!workingDir || remoteViewer.isRemoteViewer || remoteViewer.isResolving) {
      setPathExists(null)
      return
    }
    let cancelled = false
    const fs = window.tabtin?.fileSystem
    if (!fs?.pathExists) {
      setPathExists(null)
      return
    }
    void fs.pathExists(workingDir).then((result: { exists?: boolean; isDirectory?: boolean }) => {
      if (cancelled) return
      setPathExists(!!(result?.exists && result?.isDirectory))
    }).catch(() => {
      if (cancelled) return
      setPathExists(null)
    })
    return () => {
      cancelled = true
    }
  }, [workingDir, remoteViewer.isRemoteViewer, remoteViewer.isResolving])

  if (!workingDir) {
    return (
      <ModulePreviewHint>
        {deviceUnbound
          ? t('profilePane.previewHints.workingDirAndDeviceEmpty', {
              defaultValue: '尚未设置工作目录。绑定设备并选择目录后，Tin 才能在你的电脑上跑命令、读文件。',
            })
          : t('profilePane.previewHints.workingDirEmpty', {
              defaultValue: '尚未设置运行目录，Agent 无法在你的电脑上跑命令、读文件。点击设置。',
            })}
      </ModulePreviewHint>
    )
  }

  const typeLabel =
    workingDirType === 'code'
      ? t('workingDir.types.code', { defaultValue: '代码' })
      : workingDirType === 'doc'
        ? t('workingDir.types.doc', { defaultValue: '文档' })
        : workingDirType === 'mixed'
          ? t('workingDir.types.mixed', { defaultValue: '混合' })
          : null

  const invalid = !remoteViewer.isRemoteViewer && pathExists === false
  // 设备摘要优先；列表里找不到绑定设备时，远端再退回「在某某上运行」文案。
  const deviceMeta = deviceSummary
    ?? (remoteViewer.isRemoteViewer
      ? (remoteViewer.controlDeviceName
        ? t('profilePane.previewHints.workingDirRemoteWithDevice', {
          device: remoteViewer.controlDeviceName,
          defaultValue: '在「{{device}}」上运行',
        })
        : t('profilePane.previewHints.workingDirRemote', {
          defaultValue: '在远程设备上运行',
        }))
      : (deviceUnbound
        ? t('profilePane.previewHints.deviceUnboundShort', {
            defaultValue: '未绑定设备',
          })
        : null))

  const metaParts: string[] = []
  if (typeLabel && !invalid) metaParts.push(typeLabel)
  if (deviceMeta) metaParts.push(deviceMeta)
  if (invalid) {
    metaParts.push(t('profilePane.previewHints.workingDirInvalid', {
      defaultValue: '目录无法访问',
    }))
  }

  return (
    <div className="min-w-0 space-y-1">
      <p
        className={cn(
          'font-mono text-body leading-snug truncate',
          invalid ? 'text-destructive' : 'text-foreground/80',
        )}
        title={workingDir}
      >
        {workingDir}
      </p>
      {metaParts.length > 0 ? (
        <p className="text-caption leading-snug text-muted-foreground/80">
          {metaParts.join(' · ')}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5. AppsPreview — 应用管理（inline 名字列表）
// （MCP 预览已随 MCP 面板迁出至「设置 → 设备」组移除，见 IA Phase 1·1D）
// ---------------------------------------------------------------------------

const MAX_APP_ITEMS = 6

export const AppsPreview: React.FC<{ spaceId: string }> = ({ spaceId }) => {
  const { t } = useTranslation('space')
  const allApps = useSpaceApps((s) => s.appsBySpace[spaceId] ?? EMPTY_APPS)
  const disabledApps = useSpaceApps((s) => s.disabledBySpace[spaceId] ?? EMPTY_DISABLED_APPS)
  const isLoading = useSpaceApps((s) => s.loadingSpaces.has(spaceId))

  const enabledApps = useMemo(
    () => allApps.filter((a) => !disabledApps.includes(a.id)),
    [allApps, disabledApps],
  )

  if (isLoading && allApps.length === 0) {
    return <ModulePreviewHint>{t('profilePane.loading', { defaultValue: '加载中…' })}</ModulePreviewHint>
  }
  if (enabledApps.length === 0) {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.apps', {
          defaultValue: '从应用市场启用想用的内嵌 App，例如 TabData、TabDoc、TabSlide。',
        })}
      </ModulePreviewHint>
    )
  }

  const visible = enabledApps.slice(0, MAX_APP_ITEMS)
  const remaining = enabledApps.length - visible.length

  return (
    <ItemList
      items={visible.map((a) => a.name)}
      remaining={remaining}
    />
  )
}

export function useAppsPreviewMeta(spaceId: string) {
  const allApps = useSpaceApps((s) => s.appsBySpace[spaceId] ?? EMPTY_APPS)
  const disabledApps = useSpaceApps((s) => s.disabledBySpace[spaceId] ?? EMPTY_DISABLED_APPS)
  const enabledCount = allApps.filter((a) => !disabledApps.includes(a.id)).length
  if (allApps.length === 0) return { count: null as null }
  return { count: `${enabledCount}/${allApps.length}` }
}

// ---------------------------------------------------------------------------
// 7. ExtensionsPreview — 集成能力（inline 名字列表）
// ---------------------------------------------------------------------------

const MAX_EXT_ITEMS = 4

export const ExtensionsPreview: React.FC<{ spaceId: string; organizationId: string }> = ({
  spaceId,
  organizationId,
}) => {
  const { t } = useTranslation('space')
  const extensions = useExtensionStore((s) => s.extensions)
  const connectionsByScope = useExtensionStore((s) => s.connectionsByScope)
  const fetchExtensions = useExtensionStore((s) => s.fetchExtensions)
  const fetchConnectionsBothLevels = useExtensionStore((s) => s.fetchConnectionsBothLevels)

  useEffect(() => {
    void fetchExtensions(organizationId)
    void fetchConnectionsBothLevels(organizationId, spaceId)
  }, [organizationId, spaceId, fetchExtensions, fetchConnectionsBothLevels])

  const enabledConnections = useMemo(() => {
    const conns = useExtensionStore.getState().getConnections(organizationId, spaceId)
    return conns.filter((c) => c.enabled && (c.space_id === spaceId || !c.space_id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionsByScope, organizationId, spaceId])

  if (enabledConnections.length === 0) {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.extensions', {
          defaultValue: '外部集成连接后，Tin 就能在这些渠道里和你协作。',
        })}
      </ModulePreviewHint>
    )
  }

  const labelOf = (extId: string) => extensions.find((e) => e.id === extId)?.name || extId
  const visible = enabledConnections.slice(0, MAX_EXT_ITEMS)
  const remaining = enabledConnections.length - visible.length

  return (
    <ItemList
      items={visible.map((conn) => labelOf(conn.extension_id))}
      remaining={remaining}
    />
  )
}

export function useExtensionsPreviewMeta(spaceId: string, organizationId: string) {
  // 直接订阅 raw connectionsByScope（store 内 ref），再 useMemo 算计数；
  // 避免 selector 内调用 getConnections() 每次返回新数组触发 infinite loop。
  const connectionsByScope = useExtensionStore((s) => s.connectionsByScope)
  const count = useMemo(() => {
    const conns = useExtensionStore.getState().getConnections(organizationId, spaceId)
    const enabled = conns.filter(
      (c) => c.enabled && (c.space_id === spaceId || !c.space_id),
    ).length
    return enabled || null
  }, [connectionsByScope, organizationId, spaceId])
  return { count }
}

// ---------------------------------------------------------------------------
// 8. SubAgentsPreview — 子 Agent（inline 名字列表）
// ---------------------------------------------------------------------------

const MAX_SUBAGENT_ITEMS = 4

export const SubAgentsPreview: React.FC<{ spaceId: string }> = ({ spaceId }) => {
  const { t } = useTranslation('space')
  const [templates, setTemplates] = useState<SubAgentTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErrored(false)
    SubAgentTemplateApi.list(spaceId)
      .then((data) => {
        if (!cancelled) setTemplates(data)
      })
      .catch(() => {
        if (!cancelled) setErrored(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [spaceId])

  if (loading) {
    return <ModulePreviewHint>{t('profilePane.loading', { defaultValue: '加载中…' })}</ModulePreviewHint>
  }
  if (errored) return null
  const enabled = templates.filter((tpl) => tpl.is_enabled !== false)
  if (enabled.length === 0) {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.subagents', {
          defaultValue: '配置专门的子 Agent（如代码 reviewer、文案润色），让 Tin 在执行任务时按需召唤。',
        })}
      </ModulePreviewHint>
    )
  }
  const visible = enabled.slice(0, MAX_SUBAGENT_ITEMS)
  const remaining = enabled.length - visible.length
  // 名字 + 后挂 description（caption 灰），跟 MCP / Channels 保持同一种"X + 元信息"语言
  return (
    <p className="text-body text-foreground/80 leading-relaxed line-clamp-2">
      {visible.map((tpl, i) => {
        const desc = tpl.description?.trim()
        return (
          <React.Fragment key={tpl.id ?? tpl.name}>
            {i > 0 && <span className="text-muted-foreground/40 mx-1.5">·</span>}
            <span>{tpl.name}</span>
            {desc && (
              <span className="text-caption text-muted-foreground/60 ml-1.5">
                {desc}
              </span>
            )}
          </React.Fragment>
        )
      })}
      {remaining > 0 && (
        <>
          <span className="text-muted-foreground/40 mx-1.5">·</span>
          <span className="text-muted-foreground/60">{`还有 ${remaining}`}</span>
        </>
      )}
    </p>
  )
}

// ---------------------------------------------------------------------------
// 10. ChannelsPreview — 对外渠道（inline 名字列表）
// ---------------------------------------------------------------------------

// 对齐 i18n channel.json::channelMeta 的渠道清单。新增渠道时同步两处。
const CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  feishu: '飞书',
  slack: 'Slack',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  line: 'LINE',
  dingtalk: '钉钉',
  wechat_work: '企业微信',
  weixin_personal: '微信',
  googlechat: 'Google Chat',
  msteams: 'Microsoft Teams',
  mattermost: 'Mattermost',
  email: '邮件',
  webhook: 'Webhook',
}

const MAX_CHANNEL_ITEMS = 4

export const ChannelsPreview: React.FC<{ spaceId: string; organizationId: string }> = ({
  spaceId,
  organizationId,
}) => {
  const { t } = useTranslation('space')
  const accounts = useChannelStore((s) => s.accounts)
  const fetchAccounts = useChannelStore((s) => s.fetchAccounts)

  useEffect(() => {
    if (organizationId) void fetchAccounts(organizationId)
  }, [organizationId, fetchAccounts])

  const visibleAccounts = useMemo(
    () =>
      accounts.filter((account) => {
        const config = account.config as Record<string, unknown> | undefined
        const linkedSpaceId = (config?.default_space_id ?? config?.default_project_id) as
          | string
          | undefined
        return linkedSpaceId === spaceId
      }),
    [accounts, spaceId],
  )

  if (visibleAccounts.length === 0) {
    return (
      <ModulePreviewHint>
        {t('profilePane.previewHints.channels', {
          defaultValue: '把 Agent 接到外部渠道，在熟悉的工具里继续协作。',
        })}
      </ModulePreviewHint>
    )
  }

  const visible = visibleAccounts.slice(0, MAX_CHANNEL_ITEMS)
  const remaining = visibleAccounts.length - visible.length

  // 渠道名 + 后挂账号名（caption 灰），让"接到了哪个号"一眼可见
  return (
    <p className="text-body text-foreground/80 leading-relaxed line-clamp-2">
      {visible.map((acct, i) => {
        const channelLabel = CHANNEL_LABELS[acct.channel] || acct.channel
        const accountName = acct.name?.trim()
        return (
          <React.Fragment key={acct.id}>
            {i > 0 && <span className="text-muted-foreground/40 mx-1.5">·</span>}
            <span>{channelLabel}</span>
            {accountName && (
              <span className="text-caption text-muted-foreground/60 ml-1.5">
                {accountName}
              </span>
            )}
          </React.Fragment>
        )
      })}
      {remaining > 0 && (
        <>
          <span className="text-muted-foreground/40 mx-1.5">·</span>
          <span className="text-muted-foreground/60">{`还有 ${remaining}`}</span>
        </>
      )}
    </p>
  )
}
