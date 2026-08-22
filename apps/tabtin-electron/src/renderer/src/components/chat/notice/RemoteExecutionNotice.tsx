/**
 * RemoteExecutionNotice — 遥控器状态 / 执行设备不可达提示条
 *
 * 遥控器在线时可以发消息，后端会转发给绑定执行设备；这时提示条只是解释
 * 「文件/终端等本机能力仍在执行设备上」。只有绑定执行设备不可达时，composer
 * 才由 `canSend` 置灰禁发，提示条升级为恢复指引。
 *
 * 与 `RemoteAgentBanner`（执行设备型 App tile 的整屏占位）区分：那张是满屏居中、聚焦
 * 「文件 / 终端」；这张是对话区紧凑横幅、聚焦「继续对话」，复用同一 `space` 命名空间文案。
 */
import React from 'react'
import { Monitor, MonitorOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'

interface RemoteExecutionNoticeProps {
  /** 执行设备名（来自 Agent.control_device）。可能为空（设备不在本地列表）。 */
  controlDeviceName: string | null
  /** 执行设备当前不可达 → 文案走「该设备当前离线」。 */
  isOffline: boolean
  /** 新任务首屏只保留可行动的状态信息，避免提示横幅压过输入主任务。 */
  compact?: boolean
}

export const RemoteExecutionNotice: React.FC<RemoteExecutionNoticeProps> = ({
  controlDeviceName,
  isOffline,
  compact = false,
}) => {
  const { t } = useTranslation('space')

  const title = controlDeviceName
    ? t('remoteExecution.chatTitle', {
        device: controlDeviceName,
        defaultValue: '这个工作空间在「{{device}}」上运行',
      })
    : t('remoteExecution.chatTitleNoDevice', {
        defaultValue: '这个工作空间的执行设备不在当前设备',
      })

  let description: string
  if (!controlDeviceName) {
    description = t('remoteExecution.chatNoDeviceDesc', {
      defaultValue: '请先确认该 Agent 的执行设备在线后再继续对话。',
    })
  } else if (isOffline) {
    description = t('remoteExecution.chatOfflineDesc', {
      defaultValue: '该设备当前离线。请唤起它后再继续对话。',
    })
  } else {
    description = t('remoteExecution.chatRemoteDesc', {
      defaultValue: '当前设备可以遥控对话；文件、终端等本机能力仍在执行设备上运行。',
    })
  }

  return (
    <div
      className={cn(
        'rounded-interactive border px-3',
        compact ? 'py-1.5' : 'py-2',
        isOffline
          ? 'border-warning/20 bg-warning/5'
          : 'border-border/60 bg-muted/45',
      )}
      role="status"
      aria-live="polite"
      data-testid="remote-execution-notice"
      data-offline={isOffline ? 'true' : 'false'}
    >
      <div className="flex items-start gap-2">
        {isOffline ? (
          <MonitorOff className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
        ) : (
          <Monitor className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className={cn(
            'text-body leading-snug break-words',
            isOffline ? 'text-warning' : 'text-foreground',
          )}
          >
            {title}
          </p>
          {(!compact || isOffline) ? (
            <p className="mt-0.5 text-caption text-muted-foreground/80 break-words">
              {description}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
