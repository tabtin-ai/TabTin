/**
 * DevicePanel — Space 执行设备（MVP）
 *
 * 产品口径见 principle/space.md §4 执行绑定：
 * - Workspace 拥有实际执行设备与目录
 * - 首次绑定后固定，其他客户端仅远程查看
 * - 当前阶段只暴露 Electron 桌面客户端绑定，不展示尚未落地的扩展设备 / 远程安装等能力
 */
import React, { useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import { Button, ConfirmDialog, StatusNotice } from '@components/ui'
import { useShallow } from 'zustand/react/shallow'
import { useDeviceStore, USER_LEVEL_DEVICE_TYPES } from '@stores/useDeviceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { DeviceStatusBadge } from './DeviceStatusBadge'
import type { Device } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { SETTINGS_SECTION_TITLE } from '@components/settings/settingsUi'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'
import { DeviceApiService } from '@/services/deviceApi'
import { isCurrentDeviceControl } from '@/services/deviceControlMatch'
import { useTranslation } from 'react-i18next'

interface DevicePanelProps {
  spaceId: string
  /** 实际可否编辑（含远程只读守卫），用于禁用按钮 */
  canManage?: boolean
  /** 角色是否允许 editor+；仅用于「权限不足」提示，不含远程守卫 */
  roleCanEdit?: boolean
  /**
   * 嵌入「工作目录」sheet 时使用：缩短页头，避免与外层「工作目录」标题重复。
   */
  embedded?: boolean
}

export const DevicePanel: React.FC<DevicePanelProps> = ({
  spaceId,
  canManage = true,
  roleCanEdit,
  embedded = false,
}) => {
  const { t } = useTranslation('space')
  const space = useSpaceStore((state) =>
    state.spaces.find((p) => p.id === spaceId) ?? null
  )
  const agent = useSpaceStore((state) => state.selectedAgent)
  const loadAgent = useSpaceStore((state) => state.loadAgent)

  const effectiveAgentId = space?.execution_agent_id ?? space?.agent_id ?? null

  useEffect(() => {
    if (!agent && effectiveAgentId) {
      loadAgent(effectiveAgentId, { force: true }).then((loaded) => {
        if (loaded) {
          useSpaceStore.setState({ selectedAgent: loaded })
        }
      })
    }
  }, [agent, effectiveAgentId, loadAgent])

  const { devices: _devices, loadDevices, currentDevice } = useDeviceStore(
    useShallow((s) => ({
      devices: s.devices,
      loadDevices: s.loadDevices,
      currentDevice: s.currentDevice,
    }))
  )
  const devices = _devices ?? []
  const selectedOrganization = useOrganizationStore((state) => state.selectedOrganization)
  const organizationScopedDevices = space
    ? devices.filter((device) =>
        device.organization_id === space.organization_id
        || USER_LEVEL_DEVICE_TYPES.has(device.device_type)
      )
    : devices

  const [isSaving, setIsSaving] = useState(false)
  const [recoverDialogOpen, setRecoverDialogOpen] = useState(false)
  const [error, setError] = useState('')

  const mountRef = useRef(0)
  useEffect(() => {
    mountRef.current++
  }, [])
  useEffect(() => {
    if (selectedOrganization?.id) {
      loadDevices(selectedOrganization.id)
    }
  }, [selectedOrganization?.id, mountRef.current])

  const refreshAfterBind = useSpaceStore((state) => state.refreshSpace)

  if (!space) return null

  const boundDeviceId =
    space.control_device_id
    ?? space.bound_device_id
    ?? agent?.control_device_id
    ?? agent?.bound_device_id
    ?? null
  const bindingLocked = Boolean(boundDeviceId)
  const executionAgentId = agent?.execution_agent_id ?? agent?.id ?? effectiveAgentId
  const isResolving = !currentDevice?.id
  const isControl = isCurrentDeviceControl(boundDeviceId, currentDevice, devices)
  const bindableDevices = organizationScopedDevices.filter((device) => {
    if (device.role !== 'control') return false
    if (device.device_type !== 'electron') return false
    const agentRuntimeType = agent?.runtime_type
    if (agentRuntimeType && device.device_type !== agentRuntimeType) return false
    return true
  })
  const boundDevice = organizationScopedDevices.find((d) => d.id === boundDeviceId) ?? null
  const controlDeviceName = boundDevice?.name ?? null
  const roleAllowed = roleCanEdit ?? canManage
  const showPermissionHint = !roleAllowed
  const showRemoteHint = bindingLocked && !isControl && !isResolving
  const currentDeviceReachable = currentDevice?.status === 'online' || currentDevice?.status === 'busy'
  const canRecoverOfflineBinding = Boolean(
    showRemoteHint
    && roleAllowed
    && executionAgentId
    && currentDevice?.id
    && currentDeviceReachable
    && boundDevice?.status === 'offline',
  )
  const showDevicePicker = !bindingLocked && !isResolving && Boolean(executionAgentId)

  const getDeviceTypeLabel = (device: Device) => {
    if (device.device_type === 'electron') return t('device.deviceTypeElectron')
    if (device.device_type === 'daemon') return t('device.deviceTypeDaemon')
    return device.device_type
  }

  const handleBindDevice = async (device: Device) => {
    if (!canManage) return
    if (bindingLocked) {
      setError(t('device.bindingLockedError', { defaultValue: '这个工作空间已固定绑定执行设备，不能接管、解绑或迁移。' }))
      return
    }
    if (!executionAgentId) {
      setError(t('device.executionAgentMissing', { defaultValue: '当前 Agent 身份缺失，暂时无法更新部署设备绑定' }))
      return
    }
    setError('')
    setIsSaving(true)
    try {
      await DeviceApiService.bindSpaceDevice(
        spaceId,
        device.id,
      )
      await refreshAfterBind(spaceId)
      const freshAgent = await loadAgent(executionAgentId, { force: true })
      if (freshAgent) {
        useSpaceStore.setState((state) => ({
          selectedAgent: state.selectedAgent?.id === executionAgentId ? freshAgent : state.selectedAgent,
        }))
      }
    } catch (err: unknown) {
      const status = (err as Record<string, unknown>)?.status
      const message = err instanceof Error ? err.message : String(err)
      if (status === 409 || message.includes('409')) {
        await refreshAfterBind(spaceId)
        setError(t('device.bindConflict'))
      } else {
        setError(err instanceof Error ? err.message : t('device.bindFailed'))
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleRecoverOfflineBinding = async () => {
    if (!currentDevice?.id) return
    setError('')
    setIsSaving(true)
    try {
      await DeviceApiService.bindSpaceDevice(
        spaceId,
        currentDevice.id,
        space.config_version,
        true,
      )
      await refreshAfterBind(spaceId)
      if (executionAgentId) {
        const freshAgent = await loadAgent(executionAgentId, { force: true })
        if (freshAgent) {
          useSpaceStore.setState((state) => ({
            selectedAgent: state.selectedAgent?.id === executionAgentId ? freshAgent : state.selectedAgent,
          }))
        }
      }
      setRecoverDialogOpen(false)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message || t('device.recoverFailed', { defaultValue: '恢复执行设备失败，请刷新后重试。' }))
    } finally {
      setIsSaving(false)
    }
  }

  const renderDeviceRow = (
    device: Device,
    options?: { selectable?: boolean; selected?: boolean; disabled?: boolean },
  ) => {
    const isCurrent = device.id === currentDevice?.id
    const selectable = options?.selectable ?? false
    const selected = options?.selected ?? false
    const disabled = options?.disabled ?? false
    const rowClassName = cn(
      'w-full flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
      selected
        ? 'border-primary/40 bg-primary/5'
        : selectable
          ? disabled
            ? 'border-border/30 bg-muted/5 opacity-60 cursor-not-allowed'
            : 'border-border/30 hover:border-border/60 hover:bg-muted/10'
          : 'border-border/40 bg-muted/10',
    )
    const content = (
      <>
        <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-body font-medium truncate">{device.name}</span>
            {isCurrent && (
              <span className="text-caption text-muted-foreground/45 shrink-0">{t('device.thisDevice')}</span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
            <DeviceStatusBadge status={device.status} compact lastHeartbeatAt={device.last_heartbeat_at} />
            <span className="text-caption text-muted-foreground/40">
              · {getDeviceTypeLabel(device)}
            </span>
          </div>
        </div>
        {selected && (
          <span className="shrink-0 text-caption text-primary/80">
            {t('device.bindingLocked', { defaultValue: '固定绑定' })}
          </span>
        )}
      </>
    )

    if (selectable) {
      return (
        <button
          key={device.id}
          type="button"
          onClick={() => handleBindDevice(device)}
          disabled={disabled || isSaving}
          className={rowClassName}
        >
          {content}
        </button>
      )
    }

    return (
      <div key={device.id} className={rowClassName}>
        {content}
      </div>
    )
  }

  const refreshAction = (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={() => selectedOrganization?.id && loadDevices(selectedOrganization.id)}
      className="h-7 w-7 p-0 text-muted-foreground/40 hover:text-foreground"
      aria-label={t('device.refresh', { defaultValue: '刷新设备列表' })}
    >
      <RefreshCw className="h-3.5 w-3.5" />
    </Button>
  )

  return (
    <div className={embedded ? 'space-y-3' : 'space-y-5'}>
      {embedded ? (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className={SETTINGS_SECTION_TITLE}>
              {t('tabs.device', { defaultValue: '设备' })}
            </div>
            <p className="text-caption text-muted-foreground/80 leading-relaxed">
              {t('device.embeddedDescription', {
                defaultValue: '工作目录所在的执行设备。绑定后固定，本工作空间不会迁移。',
              })}
            </p>
          </div>
          {refreshAction}
        </div>
      ) : (
        <SpaceSettingsSectionHeader
          marginBottomClassName="mb-1"
          title={t('tabs.device')}
          description={t('device.panelDescription', {
            defaultValue: '决定 Agent 在哪台机器上跑命令、读写文件。绑定后固定，本工作空间不会迁移执行设备。',
          })}
          actions={refreshAction}
        />
      )}

      <div className={embedded ? 'space-y-3' : 'space-y-4'}>
        {showPermissionHint && (
          <StatusNotice
            tone="info"
            size="sm"
            description={t('device.permissionHint', { defaultValue: '需要编辑者及以上权限才能管理设备绑定' })}
          />
        )}

        {showRemoteHint && (
          <StatusNotice
            tone="info"
            size="sm"
            description={
              controlDeviceName
                ? t('device.remoteEditDisabledWithDevice', { device: controlDeviceName })
                : t('device.remoteEditDisabledNoDevice')
            }
          />
        )}

        {boundDevice ? (
          <div className="space-y-2">
            {renderDeviceRow(boundDevice, { selected: true })}
            {canRecoverOfflineBinding ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRecoverDialogOpen(true)}
                disabled={isSaving}
              >
                {t('device.recoverToThisDevice', { defaultValue: '恢复到这台设备' })}
              </Button>
            ) : null}
          </div>
        ) : boundDeviceId ? (
          <div className="rounded-lg border border-border/40 bg-muted/10 px-3 py-3">
            <div className="text-body font-medium">
              {t('device.boundDeviceUnknown', { defaultValue: '已绑定的执行设备' })}
            </div>
            <div className="text-caption text-muted-foreground/45 mt-0.5">
              {t('device.boundDeviceUnknownHint', { id: boundDeviceId })}
            </div>
          </div>
        ) : showDevicePicker ? (
          <div className="space-y-2">
            <div className={SETTINGS_SECTION_TITLE}>
              {t('device.chooseDevice', { defaultValue: '选择执行设备' })}
            </div>
            {bindableDevices.length > 0 ? (
              <div className="space-y-1.5">
                {bindableDevices.map((device) => renderDeviceRow(device, {
                  selectable: true,
                  disabled: !canManage,
                }))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/40 px-3 py-4 text-center">
                <div className="text-body text-muted-foreground/60">
                  {t('device.noRegisteredDevices')}
                </div>
                <div className="text-caption text-muted-foreground/40 mt-1">
                  {t('device.noRegisteredDevicesHint', {
                    defaultValue: '请在本机打开 TabTin 桌面客户端后再试。',
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/40 px-3 py-4 text-center">
            <div className="text-body text-muted-foreground/60">{t('device.noDeviceBound')}</div>
            <div className="text-caption text-muted-foreground/40 mt-1">
              {t('device.noDeviceHint')}
            </div>
          </div>
        )}

        {error ? <StatusNotice tone="danger" size="sm" description={error} /> : null}
      </div>

      <ConfirmDialog
        open={recoverDialogOpen}
        onOpenChange={setRecoverDialogOpen}
        title={t('device.recoverDialogTitle', { defaultValue: '恢复到这台设备？' })}
        description={t('device.recoverDialogDescription', {
          device: currentDevice?.name ?? '',
          defaultValue: '旧执行设备已离线。确认后，当前工作空间的执行与文件访问将恢复到「{{device}}」。',
        })}
        variant="destructive"
        onConfirm={handleRecoverOfflineBinding}
      />
    </div>
  )
}
