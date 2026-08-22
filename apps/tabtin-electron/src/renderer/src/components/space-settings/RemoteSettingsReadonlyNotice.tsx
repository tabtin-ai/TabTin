import React from 'react'
import { MonitorOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'

interface RemoteSettingsReadonlyNoticeProps {
  controlDeviceName: string | null
  className?: string
}

/** Space 设置远程查看提示：配置只能在执行设备本机修改 */
export const RemoteSettingsReadonlyNotice: React.FC<RemoteSettingsReadonlyNoticeProps> = ({
  controlDeviceName,
  className,
}) => {
  const { t } = useTranslation('space')

  return (
    <div
      className={cn(
        'rounded-xl border border-warning/20 bg-warning/5 px-3 py-2.5',
        className,
      )}
      role="status"
      data-testid="remote-settings-readonly-notice"
    >
      <div className="flex items-start gap-2">
        <MonitorOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-body leading-snug text-warning">
            {controlDeviceName
              ? t('remoteSettings.readonlyTitleWithDevice', {
                  device: controlDeviceName,
                  defaultValue: '正在远程查看。请回到执行设备「{{device}}」本机修改工作空间设置。',
                })
              : t('remoteSettings.readonlyTitle', {
                  defaultValue: '正在远程查看。请回到执行设备本机修改工作空间设置。',
                })}
          </p>
          <p className="text-caption text-muted-foreground/80">
            {t('remoteSettings.readonlyHint', {
              defaultValue: '此处仅可查看配置，保存、绑定设备、修改目录等操作已禁用。',
            })}
          </p>
        </div>
      </div>
    </div>
  )
}
