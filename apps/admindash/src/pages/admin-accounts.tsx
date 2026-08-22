import {
  type AdminAccountItem,
  createAdminAccount,
  listAdminAccounts,
  updateAdminAccount,
} from '@/api/admin-accounts'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import { useCallback, useEffect, useState } from 'react'

export function AdminAccountsPage() {
  const [items, setItems] = useState<AdminAccountItem[]>([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [newUserId, setNewUserId] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newRoleCodes, setNewRoleCodes] = useState('super_admin')
  const [reason, setReason] = useState('')
  const [pendingToggleAccount, setPendingToggleAccount] = useState<AdminAccountItem | null>(null)
  const [pendingRoleAccount, setPendingRoleAccount] = useState<AdminAccountItem | null>(null)
  const [roleCodesDraft, setRoleCodesDraft] = useState('')

  const load = useCallback(async (searchKeyword: string) => {
    setLoading(true)
    setError('')
    try {
      const response = await listAdminAccounts({ keyword: searchKeyword })
      setItems(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载后台账号失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load('')
  }, [load])

  const createAccount = async () => {
    if (!newUserId || !reason) {
      setError('创建后台账号必须填写 User ID 和原因')
      return
    }
    setLoading(true)
    setError('')
    setMessage('')
    try {
      await createAdminAccount({
        user_id: newUserId,
        display_name: newDisplayName,
        role_codes: newRoleCodes
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        reason,
      })
      setMessage('后台账号已创建')
      setNewUserId('')
      setNewDisplayName('')
      setReason('')
      await load(keyword)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建后台账号失败')
    } finally {
      setLoading(false)
    }
  }

  const toggleLogin = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingToggleAccount) return
    const nextEnabled = !pendingToggleAccount.admin_login_enabled
    setLoading(true)
    setError('')
    try {
      await updateAdminAccount(pendingToggleAccount.id, {
        admin_login_enabled: nextEnabled,
        status: nextEnabled ? 'active' : 'disabled',
        reason: payload.reason,
        ticket_id: payload.ticket_id,
      })
      setPendingToggleAccount(null)
      await load(keyword)
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新后台账号失败')
    } finally {
      setLoading(false)
    }
  }

  const assignRoles = async (payload: { reason: string; ticket_id: string }) => {
    if (!pendingRoleAccount) return
    const roleCodes = roleCodesDraft
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (!roleCodes.length) {
      setError('分配后台角色至少需要一个角色 code')
      return
    }
    setLoading(true)
    setError('')
    try {
      await updateAdminAccount(pendingRoleAccount.id, {
        role_codes: roleCodes,
        reason: payload.reason,
        ticket_id: payload.ticket_id,
      })
      setMessage('后台角色已更新')
      setPendingRoleAccount(null)
      setRoleCodesDraft('')
      await load(keyword)
    } catch (err) {
      setError(err instanceof Error ? err.message : '分配后台角色失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-title font-semibold">后台账号</h1>
      </div>

      <PermissionGate permission={ADMIN_PERMISSION.ADMIN_ACCOUNT_CREATE}>
        <Card>
          <CardHeader>
            <CardTitle>创建后台账号</CardTitle>
            <CardDescription>
              绑定已有 User 为后台账号并分配角色。完整超级管理员请填
              <code className="mx-1">super_admin</code>
              （会同步开通全部后台能力）；普通客服可填
              <code className="mx-1">support_agent</code>。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-5">
            <Input
              placeholder="User ID"
              value={newUserId}
              onChange={(event) => setNewUserId(event.target.value)}
            />
            <Input
              placeholder="显示名"
              value={newDisplayName}
              onChange={(event) => setNewDisplayName(event.target.value)}
            />
            <Input
              placeholder="角色：super_admin 或 support_agent"
              value={newRoleCodes}
              onChange={(event) => setNewRoleCodes(event.target.value)}
            />
            <Input
              placeholder="原因"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button disabled={loading} onClick={createAccount}>
              创建
            </Button>
          </CardContent>
        </Card>
      </PermissionGate>

      <Card>
        <CardHeader>
          <CardTitle>后台账号列表</CardTitle>
          <CardDescription>只有后台治理权限可管理后台账号。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex gap-2">
            <Input
              placeholder="搜索姓名、邮箱、手机号、部门"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button variant="outline" disabled={loading} onClick={() => void load(keyword)}>
              搜索
            </Button>
          </div>
          {message ? <div className="mb-3 text-body text-success">{message}</div> : null}
          {error ? <div className="mb-3 text-body text-destructive">{error}</div> : null}
          <div className="overflow-x-auto rounded-md border">
            <div className="grid min-w-[1220px] grid-cols-[220px_220px_120px_190px_160px_120px_160px_110px] bg-muted/40 px-4 py-2 text-caption font-medium">
              <div>后台账号</div>
              <div>关联用户</div>
              <div>状态</div>
              <div>角色</div>
              <div>部门 / 岗位</div>
              <div>后台登录</div>
              <div>最近登录</div>
              <div>角色分配</div>
            </div>
            {items.map((item) => (
              <div
                key={item.id}
                className="grid min-w-[1220px] grid-cols-[220px_220px_120px_190px_160px_120px_160px_110px] border-t px-4 py-3 text-body"
              >
                <div>
                  <div className="font-medium">{item.display_name || '未命名后台账号'}</div>
                  <div className="break-all text-caption text-muted-foreground">{item.id}</div>
                </div>
                <div>
                  <div>{item.email || item.phone || '—'}</div>
                  <div className="break-all text-caption text-muted-foreground">{item.user_id}</div>
                </div>
                <div>
                  <Badge variant={item.status === 'active' ? 'success' : 'warning'}>
                    {item.status}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1">
                  {item.role_codes.map((role) => (
                    <Badge key={role} variant="outline">
                      {role}
                    </Badge>
                  ))}
                </div>
                <div>
                  {item.department || '—'} / {item.position || '—'}
                </div>
                <div>
                  <PermissionGate permission={ADMIN_PERMISSION.ADMIN_ACCOUNT_UPDATE}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPendingToggleAccount(item)}
                    >
                      {item.admin_login_enabled ? '禁用' : '启用'}
                    </Button>
                  </PermissionGate>
                </div>
                <div>{formatDateTime(item.last_admin_login_at)}</div>
                <div>
                  <PermissionGate permission={ADMIN_PERMISSION.ADMIN_ACCOUNT_ASSIGN_ROLE}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setPendingRoleAccount(item)
                        setRoleCodesDraft(item.role_codes.join(', '))
                      }}
                    >
                      分配
                    </Button>
                  </PermissionGate>
                </div>
              </div>
            ))}
            {!items.length ? (
              <div className="px-4 py-8 text-center text-body text-muted-foreground">
                暂无后台账号
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <SensitiveActionConfirmDialog
        open={Boolean(pendingToggleAccount)}
        title={pendingToggleAccount?.admin_login_enabled ? '禁用后台登录确认' : '启用后台登录确认'}
        targetLabel={
          pendingToggleAccount
            ? `${pendingToggleAccount.display_name || pendingToggleAccount.id} (${pendingToggleAccount.id})`
            : '后台账号'
        }
        impact={
          pendingToggleAccount?.admin_login_enabled
            ? '禁用后该账号将无法继续访问后台。'
            : '启用后该账号将恢复后台登录能力。'
        }
        loading={loading}
        onCancel={() => setPendingToggleAccount(null)}
        onConfirm={toggleLogin}
      />

      <SensitiveActionConfirmDialog
        open={Boolean(pendingRoleAccount)}
        title="分配后台角色确认"
        targetLabel={
          pendingRoleAccount
            ? `${pendingRoleAccount.display_name || pendingRoleAccount.id} (${pendingRoleAccount.id})`
            : '后台账号'
        }
        impact="角色修改会直接影响后台治理权限边界，请确认角色列表与工单。"
        confirmText="确认"
        loading={loading}
        extraContent={
          <div>
            <label className="block text-body font-medium" htmlFor="admin-account-role-codes">
              角色 code（逗号分隔）
            </label>
            <Input
              id="admin-account-role-codes"
              className="mt-2"
              value={roleCodesDraft}
              onChange={(event) => setRoleCodesDraft(event.target.value)}
              placeholder="例如：support_agent,operator"
            />
          </div>
        }
        onCancel={() => {
          setPendingRoleAccount(null)
          setRoleCodesDraft('')
        }}
        onConfirm={assignRoles}
      />
    </div>
  )
}
