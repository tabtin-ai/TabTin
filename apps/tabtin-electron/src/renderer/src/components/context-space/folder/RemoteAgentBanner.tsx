/**
 * RemoteAgentBanner — 当前客户端不是 Agent.control_device 时显示的"遥控器模式"卡片
 *
 * PRD §11：Agent 绑定 control_device 上跑，working_dir 是该 device 的路径。其他客户端
 * 只能"远程查看"，本地不持有真实文件——展示一张提示卡片告诉用户去 control_device 操作。
 *
 * 用于：
 *   - OrchestrationSection 起始页（遥控器模式下顶替 TabCode/TabFolder 内嵌渲染）
 *   - 其他可能的 working_dir 消费点
 *
 * 快捷逃逸：主按钮一键切到默认本机工作空间；若有多个，右侧下拉可选其他本机。
 * 一个都没有时主按钮改为创建并切换。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { ChevronDown, Monitor, MonitorOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tabtin/smartsheet-ui'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { createLogger } from '@utils/logger'
import {
  ensureLocalWorkspaceForOrganization,
  listLocalWorkspaces,
  type LocalWorkspaceCandidate,
} from '@components/sidebar/ensureLocalWorkspace'

const log = createLogger('RemoteAgentBanner')

interface RemoteAgentBannerProps {
  controlDeviceName: string | null
  /** 是否还在解析 currentDevice / controlDevice（device store 加载中），true 时显示骨架 */
  isResolving?: boolean
  /** Agent 目录路径（可选，仅显示用，不要在这台机器上当真实路径用） */
  workingDir?: string
  /**
   * 应用名（已本地化，如"终端"/"浏览器"/"手机"）。传入时标题/描述聚焦该 App
   * （"切到该设备才能操作终端"）；不传则用通用的"远程查看这个 Agent"文案（orchestration 起始页用）。
   */
  appLabel?: string
}

export const RemoteAgentBanner: React.FC<RemoteAgentBannerProps> = ({
  controlDeviceName,
  isResolving = false,
  workingDir,
  appLabel,
}) => {
  const { t } = useTranslation('space')
  const [switching, setSwitching] = useState(false)

  const spaces = useSpaceStore((s) => s.spaces)
  const selectedSpaceId = useSpaceStore((s) => s.selectedSpace?.id ?? null)
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const currentDevice = useDeviceStore((s) => s.currentDevice ?? null)
  const devices = useDeviceStore((s) => s.devices ?? [])

  const localWorkspaces = useMemo(
    () =>
      listLocalWorkspaces(spaces as LocalWorkspaceCandidate[], organizationId, currentDevice, {
        excludeSpaceId: selectedSpaceId,
        devices,
      }),
    [spaces, organizationId, currentDevice, selectedSpaceId, devices],
  )

  const switchToSpace = useCallback((spaceId: string) => {
    const ok = useSpaceListStore.getState().selectSpaceBySpaceId(spaceId)
    if (!ok) {
      log.warn(`selectSpaceBySpaceId failed: spaceId=${spaceId}`)
    }
    return ok
  }, [])

  const handleSwitchToLocal = useCallback(
    async (spaceId?: string) => {
      if (switching) return
      setSwitching(true)
      try {
        if (spaceId) {
          switchToSpace(spaceId)
          return
        }
        if (localWorkspaces[0]) {
          switchToSpace(localWorkspaces[0].id)
          return
        }
        if (!organizationId) {
          log.warn('switch to local skipped: no organizationId')
          return
        }
        // 当前组织没有任何本机工作空间（或全钉在他机）：用户显式切回本机，允许 force 创建。
        await ensureLocalWorkspaceForOrganization(organizationId, { force: true })
        const refreshed = listLocalWorkspaces(
          useSpaceStore.getState().spaces as LocalWorkspaceCandidate[],
          organizationId,
          useDeviceStore.getState().currentDevice ?? null,
          { devices: useDeviceStore.getState().devices ?? [] },
        )
        if (refreshed[0] && useSpaceStore.getState().selectedSpace?.id !== refreshed[0].id) {
          switchToSpace(refreshed[0].id)
        }
      } catch (err) {
        log.warn(
          'switch to local workspace failed:',
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        setSwitching(false)
      }
    },
    [switching, localWorkspaces, organizationId, switchToSpace],
  )

  if (isResolving) {
    return (
      <div className="h-full w-full flex items-center justify-center text-body text-muted-foreground/60">
        {t('label.loading', { ns: 'context', defaultValue: '加载中…' })}
      </div>
    )
  }

  const title = appLabel
    ? t('workingDir.remoteAppTitle', { app: appLabel, defaultValue: '「{{app}}」在远程设备上' })
    : t('workingDir.remoteTitle', { defaultValue: '你正在远程查看这个 Agent' })

  let description: string
  if (appLabel) {
    description = controlDeviceName
      ? t('workingDir.remoteAppDescriptionWithDevice', {
          app: appLabel,
          device: controlDeviceName,
          defaultValue: 'Agent 在「{{device}}」上工作，{{app}} 也只能在那台设备上操作。切换到该设备后再来。',
        })
      : t('workingDir.remoteAppDescriptionNoDevice', {
          app: appLabel,
          defaultValue: 'Agent 还没绑定执行设备。先去工作空间设置 → 工作目录里绑定设备，才能使用{{app}}。',
        })
  } else {
    description = controlDeviceName
      ? t('workingDir.remoteDescriptionWithDevice', {
          device: controlDeviceName,
          defaultValue: '此工作空间在「{{device}}」上运行。切换到该设备才能浏览文件、开终端。',
        })
      : t('workingDir.remoteDescriptionNoDevice', {
          defaultValue: '此工作空间还没绑定执行设备。先去工作空间设置 → 工作目录里绑定设备并设置目录。',
        })
  }

  const defaultLocal = localWorkspaces[0] ?? null
  const hasMultipleLocals = localWorkspaces.length > 1
  const primaryLabel = !defaultLocal
    ? t('workingDir.switchToLocalCreate', {
        defaultValue: '创建本机工作空间并切换',
      })
    : t('workingDir.switchToLocalDefault', {
        name: defaultLocal.name,
        defaultValue: '切换到「{{name}}」',
      })

  return (
    <div className="h-full w-full flex flex-col items-center justify-center px-8 text-center">
      <MonitorOff className="h-12 w-12 mb-4 text-muted-foreground/40" />
      <h3 className="text-h4 text-foreground mb-2">{title}</h3>
      <p className="text-body text-muted-foreground/80 max-w-md mb-2 leading-relaxed">{description}</p>
      {workingDir && (
        <p className="font-mono text-caption text-muted-foreground/60 max-w-md mb-1 truncate flex items-center gap-1.5">
          <Monitor className="h-3 w-3 shrink-0" />
          <span className="truncate">{workingDir}</span>
        </p>
      )}

      <div className="mt-5 flex items-center justify-center">
        <div className="inline-flex items-stretch shadow-sm rounded-interactive">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={switching || !currentDevice?.id}
            data-testid="remote-agent-switch-local"
            className={hasMultipleLocals ? 'rounded-r-none' : undefined}
            onClick={() => {
              void handleSwitchToLocal(defaultLocal?.id)
            }}
          >
            {switching
              ? t('workingDir.switchingLocal', { defaultValue: '正在切换…' })
              : primaryLabel}
          </Button>
          {hasMultipleLocals ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={switching || !currentDevice?.id}
                  data-testid="remote-agent-switch-local-pick"
                  className="rounded-l-none px-2 border-l border-primary-foreground/25 hover:bg-primary/85"
                  aria-label={t('workingDir.switchToLocalPick', {
                    defaultValue: '选择其他本机工作空间',
                  })}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]">
                {localWorkspaces.map((space) => (
                  <DropdownMenuItem
                    key={space.id}
                    className="text-body"
                    data-testid={`remote-agent-switch-local-item-${space.id}`}
                    onClick={() => {
                      void handleSwitchToLocal(space.id)
                    }}
                  >
                    <span className="truncate">{space.name}</span>
                    {space.id === defaultLocal?.id ? (
                      <span className="ml-2 shrink-0 text-caption text-muted-foreground/60">
                        {t('workingDir.localDefaultBadge', { defaultValue: '默认' })}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </div>
  )
}
