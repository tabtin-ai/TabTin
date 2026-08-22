/**
 * AgentWorkspacePickerDialog — 群聊加/换 Agent 执行现场（单步选 Workspace）。
 *
 * Agent 已由调用方选定；候选口径对齐 ExecutionTargetWizard 的个人 Workspace。
 * 状态标记与侧栏同一套 ExecutionDeviceStatusTag；可在本机或远程（含离线）设备上新建。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Folder, Loader2, Plus } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@components/ui'
import { toast } from '@tabtin/smartsheet-ui'
import type { Space } from '@tabtin/app-shell'
import { ExecutionDeviceStatusTag } from '@components/context-space/ExecutionDeviceStatusTag'
import { resolveSpaceExecutionDeviceStatus } from '@components/context-space/executionDeviceStatus'
import type { ExecutionDeviceStatus } from '@components/context-space/terminalOverviewModel'
import { useAccountDevicesQuery } from '@/hooks/queries/accountDevices'
import { useEffectiveFeature } from '@/hooks/useEffectiveFeature'
import {
  DAEMON_CONTROL_CONTROL_STATE,
  DAEMON_CONTROL_DEVICE_KIND,
  DAEMON_CONTROL_DEVICE_ROLE,
  DAEMON_CONTROL_PRESENCE,
  type AccountDevice,
} from '@/services/daemonControlApi'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceAgentDialogStore } from '@stores/useSpaceAgentDialogStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { resolveDefaultExecutionWorkspaceId } from '@/utils/defaultExecutionSpace'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'

const log = createLogger('AgentWorkspacePickerDialog')

export interface AgentWorkspacePickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** 更换现场时传入当前绑定；加 Agent 不传，走 lastUsed/default。 */
  initialWorkspaceId?: string | null
  onConfirm: (workspaceId: string) => Promise<void>
}

function isPersonalWorkspace(space: Space, organizationId: string | null): boolean {
  if (space.is_archived || space.type === 'team_space') return false
  if (organizationId && space.organization_id !== organizationId) return false
  const source = space.provisioning_source
  if (source === 'system_project' || source === 'system_task') return false
  return true
}

function canCreateWorkspaceOnDevice(device: AccountDevice): boolean {
  return (
    (
      device.kind === DAEMON_CONTROL_DEVICE_KIND.electron
      || device.kind === DAEMON_CONTROL_DEVICE_KIND.daemon
    )
    && device.roles.includes(DAEMON_CONTROL_DEVICE_ROLE.executor)
    && device.control_state === DAEMON_CONTROL_CONTROL_STATE.active
  )
}

function resolveRemoteDeviceStatus(
  deviceName: string,
  offline: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): ExecutionDeviceStatus {
  return {
    label: t('desktop.deviceStatus.remote', { defaultValue: '远程' }),
    title: offline
      ? t('desktop.deviceStatus.offlineTitle', {
          device: deviceName,
          defaultValue: 'Agent 的执行设备「{{device}}」当前不在线',
        })
      : t('desktop.deviceStatus.remoteTitle', {
          device: deviceName,
          defaultValue: 'Agent 在「{{device}}」上工作，需切换到该设备才能操作这个应用',
        }),
    tone: 'remote',
    ...(offline
      ? {
          secondaryLabel: t('desktop.deviceStatus.offline', { defaultValue: '离线' }),
          secondaryTone: 'offline' as const,
        }
      : {}),
  }
}

const AddWorkspaceButton: React.FC<{
  disabled: boolean
  onCreated: (workspaceId: string) => void
}> = ({ disabled, onCreated }) => {
  const { t } = useTranslation('tabchat')
  const { t: tContext } = useTranslation('context')
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const currentDevice = useDeviceStore((s) => s.currentDevice)
  const daemonControlAvailable = useEffectiveFeature('daemon_control', organizationId).enabled
  const { data: accountDevices = [] } = useAccountDevicesQuery({
    enabled: daemonControlAvailable,
  })
  const openCreate = useSpaceAgentDialogStore((s) => s.openCreate)
  const openCreateForDaemon = useSpaceAgentDialogStore((s) => s.openCreateForDaemon)

  const createOptions = useMemo(() => ({ onCreated }), [onCreated])

  const remoteDevices = useMemo(() => {
    if (!daemonControlAvailable) return []
    const currentInstallationId = currentDevice?.fingerprint ?? null
    return accountDevices.filter((device) => (
      canCreateWorkspaceOnDevice(device)
      && device.installation_id !== currentInstallationId
    ))
  }, [accountDevices, currentDevice?.fingerprint, daemonControlAvailable])

  const handleCreateLocal = useCallback(() => {
    log.info('open local workspace create from picker')
    openCreate(createOptions)
  }, [createOptions, openCreate])

  const handleCreateRemote = useCallback((device: AccountDevice) => {
    const deviceName = device.name.trim() || t('addRemoteWorkspace', {
      device: device.device_id,
      defaultValue: device.device_id,
    })
    log.info('open remote workspace create from picker', {
      installationId: device.installation_id,
      presence: device.presence?.state,
    })
    openCreateForDaemon({
      installationId: device.installation_id,
      deviceName,
    }, createOptions)
  }, [createOptions, openCreateForDaemon, t])

  const addLabel = t('addWorkspace', { defaultValue: '添加工作空间' })

  if (remoteDevices.length === 0) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={handleCreateLocal}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-accent/10 hover:text-foreground disabled:opacity-50"
        title={addLabel}
        aria-label={addLabel}
      >
        <Plus className="h-4 w-4" />
      </button>
    )
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-accent/10 hover:text-foreground disabled:opacity-50"
          title={addLabel}
          aria-label={addLabel}
        >
          <Plus className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuItem onSelect={handleCreateLocal}>
          {t('addLocalWorkspace', { defaultValue: '本机工作空间' })}
        </DropdownMenuItem>
        {remoteDevices.map((device) => {
          const deviceName = device.name.trim() || device.device_id
          const offline = device.presence?.state === DAEMON_CONTROL_PRESENCE.offline
          return (
            <DropdownMenuItem
              key={device.device_id}
              onSelect={() => handleCreateRemote(device)}
              className="flex items-center justify-between gap-2"
            >
              <span className="min-w-0 truncate">
                {t('addRemoteWorkspace', { device: deviceName, defaultValue: deviceName })}
              </span>
              <ExecutionDeviceStatusTag status={resolveRemoteDeviceStatus(deviceName, offline, tContext)} />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const AgentWorkspacePickerDialog: React.FC<AgentWorkspacePickerDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  initialWorkspaceId = null,
  onConfirm,
}) => {
  const { t } = useTranslation('tabchat')
  const { t: tContext } = useTranslation('context')
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const spaces = useSpaceStore((s) => s.spaces)
  const agentCache = useSpaceStore((s) => s.agentCache)
  const devices = useDeviceStore((s) => s.devices)
  const currentDevice = useDeviceStore((s) => s.currentDevice)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const workspaces = useMemo(
    () => spaces.filter((space) => isPersonalWorkspace(space, organizationId)),
    [spaces, organizationId],
  )
  const hasSelectableWorkspaces = workspaces.length > 0

  useEffect(() => {
    if (!open) return
    const list = useSpaceStore.getState().spaces.filter((space) =>
      isPersonalWorkspace(space, organizationId),
    )
    if (initialWorkspaceId && list.some((space) => space.id === initialWorkspaceId)) {
      setWorkspaceId(initialWorkspaceId)
      return
    }
    if (list.length === 0) {
      setWorkspaceId(null)
      return
    }
    const lastUsed = useSpaceViewPrefsStore.getState().getLastUsedWorkspaceId(organizationId)
    const preferred = resolveDefaultExecutionWorkspaceId(organizationId, list, lastUsed)
    setWorkspaceId(preferred ?? list[0]?.id ?? null)
  }, [open, initialWorkspaceId, organizationId, hasSelectableWorkspaces])

  const handleCreated = useCallback((createdId: string) => {
    log.info('created workspace from picker', { workspaceId: createdId })
    setWorkspaceId(createdId)
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!workspaceId || submitting) return
    setSubmitting(true)
    try {
      await onConfirm(workspaceId)
    } catch (err) {
      log.warn('confirm workspace failed', { workspaceId, err })
      toast({
        title: t('addMemberFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [onConfirm, submitting, t, workspaceId])

  if (!open) return null

  return (
    <Dialog open onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>
      <DialogContent
        container={null}
        className="flex w-[420px] max-w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden p-0"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="border-b border-border/60 px-4 py-3 pr-12">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <DialogTitle className="text-body font-medium">{title}</DialogTitle>
              <p className="mt-0.5 text-caption text-muted-foreground">
                {description ?? t('pickAgentWorkspaceDescription')}
              </p>
            </div>
            <AddWorkspaceButton disabled={submitting} onCreated={handleCreated} />
          </div>
        </div>

        <div className="max-h-[52vh] overflow-y-auto px-2 py-2">
          {workspaces.length === 0 ? (
            <div className="px-3 py-6 text-center text-caption text-muted-foreground">
              {t('noPersonalWorkspaces')}
            </div>
          ) : (
            workspaces.map((space) => {
              const active = space.id === workspaceId
              const agentId = space.execution_agent_id ?? space.agent_id ?? null
              const agent = agentId ? agentCache[agentId] : null
              const deviceStatus = resolveSpaceExecutionDeviceStatus(
                space,
                agent,
                currentDevice,
                devices,
                tContext,
              )
              return (
                <button
                  key={space.id}
                  type="button"
                  disabled={submitting}
                  aria-pressed={active}
                  onClick={() => setWorkspaceId(space.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    active ? 'bg-accent/10' : 'hover:bg-muted/40',
                  )}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
                    <Folder className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-foreground/90">{space.name}</span>
                    {space.working_dir ? (
                      <span className="block truncate text-caption text-muted-foreground/80">
                        {space.working_dir}
                      </span>
                    ) : null}
                  </span>
                  {deviceStatus ? <ExecutionDeviceStatusTag status={deviceStatus} /> : null}
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            disabled={!workspaceId || submitting || workspaces.length === 0}
            onClick={() => void handleConfirm()}
          >
            {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            {t('confirmWorkspace')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
