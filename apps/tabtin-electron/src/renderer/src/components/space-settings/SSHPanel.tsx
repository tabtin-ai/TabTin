/**
 * SSHPanel — SSH 远程服务器管理面板（设备管理域）
 *
 * 展示「当前这台 Electron 设备」下的 SSH 服务器列表，支持增删改、连通性测试、禁用/启用。
 *
 * IA Phase 1·1B：本面板已从 Agent 资料页迁入「设置 → 设备」组。设备身份不再
 * 从当前 Agent 推导，而是经 useCurrentDeviceId 取当前 Electron 设备对应的后端 Device.id。
 * CRUD / 连通性测试仍走设备级 sshApi（/context/devices/{deviceId}/ssh-servers）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Server, Plus, Trash2, Edit2, Plug, Check, X, Loader2, Eye, EyeOff,
  Power, PowerOff, KeyRound, RotateCw
} from 'lucide-react'
import {
  Button, Input, Select, SelectContent,
  SelectItem, SelectTrigger, SelectValue, Textarea, ConfirmDialog, StatusNotice
} from '@components/ui'
import { useCurrentDeviceId } from '@/hooks/useCurrentDeviceId'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { SSHApiService } from '@/services/sshApi'
import type { RemoteServer, RemoteServerCreate } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { SETTINGS_CONTROL_SM } from '@components/settings/settingsUi'
import { SettingsPanelLayout } from '@components/settings/SettingsPanelLayout'
import { SettingsPanelHeader } from '@components/settings/SettingsPanelHeader'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'

interface SSHPanelProps {
  /**
   * 是否可管理。设备域语义下默认 true：用户管理自己这台机器的 SSH 服务器。
   * 保留该 prop 以便未来在受限场景（如只读共享）下复用。
   */
  canManage?: boolean
}

const EMPTY_FORM: RemoteServerCreate = {
  name: '',
  host: '',
  port: 22,
  username: '',
  auth_method: 'password',
  credential_value: '',
}

const PORT_MIN = 1
const PORT_MAX = 65535

export const SSHPanel: React.FC<SSHPanelProps> = ({ canManage = true }) => {
  const { t } = useTranslation('space')
  // 设备域上下文：取「当前这台 Electron 设备」对应的后端 Device.id（不再从 Agent 推导）。
  const { deviceId, device, isLoading: deviceResolving, retry: retryDevice } = useCurrentDeviceId()
  // retry 依赖「选中团队」才能触发设备注册；无团队时禁用重试按钮并提示（B1），避免点了无反馈。
  const selectedOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id)

  const [servers, setServers] = useState<RemoteServer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RemoteServerCreate>({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; message: string }>>({})
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [resetHostKeyTarget, setResetHostKeyTarget] = useState<RemoteServer | null>(null)

  const showSuccess = useCallback((msg: string, autoDismissMs = 3000) => {
    setSuccessMsg(msg)
    if (autoDismissMs > 0) {
      setTimeout(() => setSuccessMsg((prev) => prev === msg ? '' : prev), autoDismissMs)
    }
  }, [])

  const loadServers = useCallback(async () => {
    if (!deviceId) return
    setLoading(true)
    setError('')
    try {
      const res = await SSHApiService.listServers(deviceId)
      setServers(res.servers ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssh.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [deviceId, t])

  useEffect(() => {
    loadServers()
  }, [loadServers])

  const isFormValid = useCallback((): boolean => {
    if (!form.name || !form.host || !form.username) return false
    const port = form.port ?? 22
    if (port < PORT_MIN || port > PORT_MAX) return false
    if (!editingId && !form.credential_value) return false
    return true
  }, [form, editingId])

  const handleCreate = async () => {
    if (!deviceId || !isFormValid()) return
    setSaving(true)
    setError('')
    try {
      const newServer = await SSHApiService.createServer(deviceId, form)
      setShowForm(false)
      setForm({ ...EMPTY_FORM })
      await loadServers()
      showSuccess(t('ssh.createSuccess'), 0)
      handleTest(newServer.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssh.createFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = async () => {
    if (!editingId) return
    setSaving(true)
    setError('')
    try {
      await SSHApiService.updateServer(editingId, {
        name: form.name || undefined,
        host: form.host || undefined,
        port: form.port || undefined,
        username: form.username || undefined,
        auth_method: form.auth_method || undefined,
        credential_value: form.credential_value || undefined,
      })
      setEditingId(null)
      setShowForm(false)
      setForm({ ...EMPTY_FORM })
      await loadServers()
      showSuccess(t('ssh.updateSuccess'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssh.updateFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = (serverId: string) => {
    const server = servers.find((s) => s.id === serverId)
    setDeleteTarget({ id: serverId, name: server?.name || serverId })
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setError('')
    try {
      await SSHApiService.deleteServer(deleteTarget.id)
      await loadServers()
      showSuccess(t('ssh.deleteSuccess'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssh.deleteFailed'))
    }
  }

  const handleResetHostKey = (server: RemoteServer) => {
    setResetHostKeyTarget(server)
  }

  const confirmResetHostKey = async () => {
    if (!resetHostKeyTarget) return
    setError('')
    try {
      await SSHApiService.resetHostKey(resetHostKeyTarget.id)
      await loadServers()
      showSuccess(t('ssh.resetHostKeySuccess'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssh.resetHostKeyFailed'))
    }
  }

  const handleToggleStatus = async (server: RemoteServer) => {
    const newStatus = server.status === 'active' ? 'disabled' : 'active'
    setError('')
    try {
      await SSHApiService.updateServer(server.id, { status: newStatus })
      await loadServers()
      showSuccess(newStatus === 'active' ? t('ssh.enableSuccess') : t('ssh.disableSuccess'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ssh.toggleFailed'))
    }
  }

  const handleTest = async (serverId: string) => {
    setTestingId(serverId)
    setTestResult((prev) => ({ ...prev, [serverId]: { success: false, message: t('ssh.testing') } }))
    try {
      const res = await SSHApiService.testConnection(serverId)
      setTestResult((prev) => ({
        ...prev,
        [serverId]: {
          success: res.success,
          message: res.success
            ? (res.os_info ? t('ssh.connectSuccessWithOS', { osInfo: res.os_info }) : t('ssh.connectSuccess'))
            : res.error || t('ssh.connectFailed'),
        },
      }))
    } catch (err) {
      setTestResult((prev) => ({
        ...prev,
        [serverId]: { success: false, message: err instanceof Error ? err.message : t('ssh.testFailed') },
      }))
    } finally {
      setTestingId(null)
      setSuccessMsg((prev) => prev === t('ssh.createSuccess') ? '' : prev)
    }
  }

  const startEdit = (server: RemoteServer) => {
    setEditingId(server.id)
    setShowForm(true)
    setForm({
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      auth_method: server.auth_method,
      credential_value: '',
    })
  }

  const handlePortChange = (value: string) => {
    const num = parseInt(value)
    if (isNaN(num)) return
    setForm({ ...form, port: Math.min(PORT_MAX, Math.max(PORT_MIN, num)) })
  }

  // 当前设备仍在识别中（注册/拉取未完成）：短暂加载态，避免空态闪现。
  // 设备组合面板无 flex 高度上下文，flex-1 会塌陷 → 用平铺 + 垂直留白（对齐 McpPanel·1D，B2）。
  if (deviceResolving) {
    return (
      <div className="py-12 text-center space-y-3">
        <Loader2 className="h-6 w-6 text-muted-foreground/30 mx-auto animate-spin" />
        <div className="text-body text-muted-foreground/60">{t('ssh.deviceLoading')}</div>
      </div>
    )
  }

  // 没识别到当前设备（如离线 / 注册失败 / 注册从未触发的超时兜底）：
  // SSH 配置挂在设备下，提示稍后重试，并给一个直接重新触发设备注册的入口。
  if (!deviceId || !device) {
    return (
      <div className="py-12 text-center space-y-3">
        <Server className="h-8 w-8 text-muted-foreground/30 mx-auto" />
        <div className="text-body text-muted-foreground/60">{t('ssh.noCurrentDevice')}</div>
        <div className="text-caption text-muted-foreground/30 max-w-xs mx-auto">
          {t('ssh.noCurrentDeviceHint')}
        </div>
        <Button
          variant="outline"
          onClick={retryDevice}
          disabled={!selectedOrganizationId}
          className={cn(SETTINGS_CONTROL_SM, 'gap-1 mx-auto')}
        >
          <RotateCw className="h-3 w-3" />
          {t('ssh.retryDevice')}
        </Button>
        {!selectedOrganizationId && (
          <div className="text-caption text-muted-foreground/30 max-w-xs mx-auto">
            {t('ssh.retryNeedOrganization')}
          </div>
        )}
      </div>
    )
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Server className="h-4 w-4" />}
        title={t('tabs.ssh')}
        subtitle={t('ssh.subtitle', { name: device.name })}
        meta={(
          <Button
            variant="outline"
            onClick={() => {
              setShowForm(true)
              setEditingId(null)
              setForm({ ...EMPTY_FORM })
            }}
            disabled={!canManage}
            className={cn(SETTINGS_CONTROL_SM, 'gap-1')}
          >
            <Plus className="h-3 w-3" />
            {t('ssh.addServer')}
          </Button>
        )}
      />

      {successMsg ? (
        <StatusNotice
          tone="success"
          size="sm"
          description={successMsg}
          icon={<Check className="h-3.5 w-3.5" />}
        />
      ) : null}
      {error ? <StatusNotice tone="danger" size="sm" description={error} /> : null}

      {/* Add/Edit Form */}
        {showForm && (
          <div className="rounded-lg border border-border/40 p-3 space-y-3 bg-muted/5">
            <div className="text-body font-medium">
              {editingId ? t('ssh.editServer') : t('ssh.addSSHServer')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder={t('ssh.namePlaceholder')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="h-8 text-body"
                disabled={!canManage}
              />
              <Input
                placeholder={t('ssh.hostPlaceholder')}
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                className="h-8 text-body"
                disabled={!canManage}
              />
              <Input
                placeholder={t('ssh.portPlaceholder')}
                type="number"
                min={PORT_MIN}
                max={PORT_MAX}
                value={form.port ?? 22}
                onChange={(e) => handlePortChange(e.target.value)}
                className="h-8 text-body"
                disabled={!canManage}
              />
              <Input
                placeholder={t('ssh.usernamePlaceholder')}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                className="h-8 text-body"
                disabled={!canManage}
              />
            </div>

            <div className="space-y-2">
              <Select
                value={form.auth_method}
                onValueChange={(v) => setForm({ ...form, auth_method: v as 'key' | 'password' })}
                disabled={!canManage}
              >
                <SelectTrigger className="h-8 text-body">
                  <SelectValue placeholder={t('ssh.authMethodPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">{t('ssh.authPassword')}</SelectItem>
                  <SelectItem value="key">{t('ssh.authKey')}</SelectItem>
                </SelectContent>
              </Select>

              {form.auth_method === 'password' ? (
                <div className="relative">
                  <Input
                    placeholder={editingId ? t('ssh.passwordEditPlaceholder') : t('ssh.passwordPlaceholder')}
                    type={showPassword ? 'text' : 'password'}
                    value={form.credential_value ?? ''}
                    onChange={(e) => setForm({ ...form, credential_value: e.target.value })}
                    className="h-8 text-body pr-8"
                    disabled={!canManage}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              ) : (
                <Textarea
                  placeholder={editingId ? t('ssh.keyEditPlaceholder') : t('ssh.keyPlaceholder')}
                  value={form.credential_value ?? ''}
                  onChange={(e) => setForm({ ...form, credential_value: e.target.value })}
                  className="text-body font-mono min-h-[80px]"
                />
              )}
            </div>

            <div className="flex items-center gap-2 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowForm(false)
                  setEditingId(null)
                  setForm({ ...EMPTY_FORM })
                }}
                className="h-7 text-body"
              >
                {t('ssh.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={editingId ? handleUpdate : handleCreate}
                disabled={saving || !isFormValid() || !canManage}
                className="h-7 text-body"
              >
                {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                {editingId ? t('ssh.save') : t('ssh.create')}
              </Button>
            </div>
          </div>
        )}

        {/* Server List */}
        {loading && servers.length === 0 ? (
          <ManagementCardListSkeleton count={4} />
        ) : servers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/40 px-3 py-5 text-center">
            <Server className="h-5 w-5 text-muted-foreground/30 mx-auto mb-1.5" />
            <div className="text-body text-muted-foreground/60">{t('ssh.empty')}</div>
            <div className="text-caption text-muted-foreground/30 mt-0.5">
              {t('ssh.emptyHint')}
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {servers.map((server) => {
              const isDisabled = server.status === 'disabled'
              return (
                <div
                  key={server.id}
                  className={cn(
                    'flex items-center justify-between rounded-lg border border-border/40 px-3 py-2.5',
                    isDisabled ? 'bg-muted/20 opacity-60' : 'bg-muted/10',
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Server className={cn('h-4 w-4 shrink-0', isDisabled ? 'text-muted-foreground/30' : 'text-muted-foreground')} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-body font-medium truncate">{server.name}</span>
                        {isDisabled && (
                          <span className="text-caption text-muted-foreground/40 bg-muted/40 rounded px-1 py-0.5">
                            {t('ssh.disabled')}
                          </span>
                        )}
                      </div>
                      <div className="text-caption text-muted-foreground/60">
                        {server.username}@{server.host}:{server.port}
                        {server.last_connected_at && (
                          <span className="ml-2">
                            · {t('ssh.lastConnected', { date: new Date(server.last_connected_at).toLocaleDateString() })}
                          </span>
                        )}
                      </div>
                      {testResult[server.id] && (
                        <div
                          className={cn(
                            'text-caption mt-0.5',
                            testResult[server.id].success ? 'text-success' : 'text-destructive'
                          )}
                        >
                          {testResult[server.id].success ? (
                            <Check className="h-3 w-3 inline mr-0.5" />
                          ) : (
                            <X className="h-3 w-3 inline mr-0.5" />
                          )}
                          {testResult[server.id].message}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleStatus(server)}
                      disabled={!canManage}
                      className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground"
                      title={isDisabled ? t('ssh.enable') : t('ssh.disable')}
                    >
                      {isDisabled ? <PowerOff className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTest(server.id)}
                      disabled={testingId === server.id || isDisabled}
                      className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground"
                      title={t('ssh.testConnection')}
                    >
                      {testingId === server.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Plug className="h-3 w-3" />
                      )}
                    </Button>
                    {server.os_info?.host_key_fingerprint && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleResetHostKey(server)}
                        disabled={!canManage}
                        className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-warning"
                        title={t('ssh.resetHostKey')}
                      >
                        <KeyRound className="h-3 w-3" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startEdit(server)}
                      disabled={!canManage}
                      className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground"
                      title={t('ssh.edit')}
                    >
                      <Edit2 className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(server.id)}
                      disabled={!canManage}
                      className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-destructive"
                      title={t('ssh.delete')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Help text */}
        <div className="rounded-lg bg-muted/20 px-3 py-2.5 space-y-1">
          <div className="text-body font-medium text-muted-foreground">{t('ssh.helpTitle')}</div>
          <ul className="text-body text-muted-foreground/60 space-y-0.5 list-disc list-inside">
            <li>{t('ssh.helpTip1')}</li>
            <li>{t('ssh.helpTip2')}</li>
            <li>{t('ssh.helpTip3')}</li>
            <li>{t('ssh.helpTip4')}</li>
          </ul>
        </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={t('ssh.deleteConfirmTitle', '删除确认')}
        description={deleteTarget ? t('ssh.deleteConfirm', { name: deleteTarget.name }) : ''}
        variant="destructive"
        onConfirm={confirmDelete}
      />

      <ConfirmDialog
        open={!!resetHostKeyTarget}
        onOpenChange={(open) => { if (!open) setResetHostKeyTarget(null) }}
        title={t('ssh.resetHostKeyConfirmTitle', '重置主机密钥')}
        description={resetHostKeyTarget ? t('ssh.resetHostKeyConfirm', { name: resetHostKeyTarget.name }) : ''}
        variant="destructive"
        onConfirm={confirmResetHostKey}
      />
    </SettingsPanelLayout>
  )
}
