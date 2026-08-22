import {
  type AdminPermissionItem,
  type AdminRoleItem,
  createAdminRole,
  deleteAdminRole,
  getAdminPermissionCatalog,
  getAdminRoles,
  updateAdminRole,
  updateAdminRolePermissions,
} from '@/api/admin-rbac'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const SYSTEM_ROLE_NAME_MAP: Record<string, string> = {
  super_admin: '超级管理员',
  billing_admin: '计费管理员',
  support_agent: '客服支持',
  model_admin: '模型管理员',
  risk_admin: '风控运维管理员',
  finance_viewer: '财务只读',
  auditor: '审计员',
}

const CATEGORY_LABEL_MAP: Record<string, string> = {
  user: '用户',
  organization: '组织',
  team_member: '成员',
  space: '空间',
  plan: '套餐',
  entitlement: '权益',
  credit: 'credits',
  wallet: '钱包',
  billing: '计费',
  invoice: '账单',
  order: '订单',
  finance: '财务',
  support: '支持',
  risk: '风控',
  model: '模型',
  app_tool: '应用与工具',
  risk_ops: '风控与运维',
  adjustment: '调整单',
  refund: '退款',
  compensation: '补偿',
  audit: '审计',
  admin_governance: '后台治理',
}

const RISK_LABEL_MAP: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '极高风险',
}

function riskVariant(risk: string) {
  if (risk === 'high' || risk === 'critical') return 'destructive' as const
  if (risk === 'medium') return 'warning' as const
  return 'secondary' as const
}

function getRoleDisplayName(role: AdminRoleItem) {
  if (role.is_system) {
    return SYSTEM_ROLE_NAME_MAP[role.code] ?? role.name
  }
  return role.name
}

function getCategoryDisplayName(category: string) {
  return CATEGORY_LABEL_MAP[category] ?? category
}

function getRiskDisplayName(risk: string) {
  return RISK_LABEL_MAP[risk] ?? risk
}

export function AdminRbacPage() {
  const [permissions, setPermissions] = useState<AdminPermissionItem[]>([])
  const [roles, setRoles] = useState<AdminRoleItem[]>([])
  const [selectedRoleId, setSelectedRoleId] = useState('')
  const selectedRoleIdRef = useRef('')
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([])
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false)
  const [createDraft, setCreateDraft] = useState({ code: '', name: '', description: '' })
  const [editDraft, setEditDraft] = useState({ name: '', description: '', is_active: true })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? null
  const editableRole = selectedRole && !selectedRole.is_system
  const permissionCodes = useMemo(
    () => permissions.filter((item) => item.is_active).map((item) => item.code),
    [permissions]
  )
  const groupedPermissions = useMemo(() => {
    const groups = permissions.reduce<Record<string, AdminPermissionItem[]>>((acc, permission) => {
      const key = permission.category || 'uncategorized'
      acc[key] = acc[key] ?? []
      acc[key].push(permission)
      return acc
    }, {})
    return Object.entries(groups)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, items]) => ({
        category,
        items: [...items].sort((left, right) => left.code.localeCompare(right.code)),
      }))
  }, [permissions])

  const load = useCallback(async (preferredRoleId?: string) => {
    setLoading(true)
    setError('')
    try {
      const [permissionItems, roleItems] = await Promise.all([
        getAdminPermissionCatalog(),
        getAdminRoles(),
      ])
      setPermissions(permissionItems)
      setRoles(roleItems)
      const categories = Array.from(
        new Set(permissionItems.map((item) => item.category || 'uncategorized'))
      )
      setExpandedCategories((prev) => {
        const next = { ...prev }
        for (const category of categories) {
          if (next[category] === undefined) next[category] = true
        }
        return next
      })
      if (roleItems.length === 0) {
        selectedRoleIdRef.current = ''
        setSelectedRoleId('')
        setSelectedPermissions([])
      } else {
        const fallbackRole =
          roleItems.find((role) => role.id === preferredRoleId) ??
          roleItems.find((role) => role.id === selectedRoleIdRef.current) ??
          roleItems[0]
        selectedRoleIdRef.current = fallbackRole.id
        setSelectedRoleId(fallbackRole.id)
        setSelectedPermissions(fallbackRole.permission_codes)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载角色权限失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedRole) {
      setEditDraft({ name: '', description: '', is_active: true })
      return
    }
    setEditDraft({
      name: selectedRole.name,
      description: selectedRole.description || '',
      is_active: selectedRole.is_active,
    })
  }, [selectedRole])

  const selectRole = (roleId: string) => {
    const role = roles.find((item) => item.id === roleId)
    selectedRoleIdRef.current = roleId
    setSelectedRoleId(roleId)
    setSelectedPermissions(role?.permission_codes ?? [])
    setMessage('')
    setError('')
  }

  const togglePermission = (code: string) => {
    if (!editableRole) return
    setSelectedPermissions((prev) =>
      prev.includes(code) ? prev.filter((item) => item !== code) : [...prev, code]
    )
  }

  const setCategoryPermissions = (codes: string[], enabled: boolean) => {
    if (!editableRole) return
    setSelectedPermissions((prev) => {
      const set = new Set(prev)
      if (enabled) {
        for (const code of codes) {
          set.add(code)
        }
      } else {
        for (const code of codes) {
          set.delete(code)
        }
      }
      return Array.from(set)
    })
  }

  const savePermissions = async (payload: { reason: string; ticket_id: string }) => {
    if (!selectedRole) return
    if (!editableRole) {
      setError('系统内置角色只读，不允许修改权限')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const updated = await updateAdminRolePermissions(selectedRole.id, {
        permission_codes: selectedPermissions,
        reason: payload.reason,
        ticket_id: payload.ticket_id,
      })
      setRoles((prev) => prev.map((role) => (role.id === updated.id ? updated : role)))
      setSelectedPermissions(updated.permission_codes)
      setPermissionDialogOpen(false)
      setMessage('角色权限已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存角色权限失败')
    } finally {
      setSaving(false)
    }
  }

  const createRole = async (payload: { reason: string; ticket_id: string }) => {
    if (!createDraft.code.trim() || !createDraft.name.trim()) {
      setError('请填写角色 code 和角色名称')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const created = await createAdminRole({
        code: createDraft.code.trim().toLowerCase(),
        name: createDraft.name.trim(),
        description: createDraft.description.trim(),
        permission_codes: [],
        reason: payload.reason,
        ticket_id: payload.ticket_id,
      })
      setCreateDialogOpen(false)
      setCreateDraft({ code: '', name: '', description: '' })
      await load(created.id)
      setMessage('角色已创建')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建角色失败')
    } finally {
      setSaving(false)
    }
  }

  const updateRole = async (payload: { reason: string; ticket_id: string }) => {
    if (!selectedRole || !editableRole) return
    if (!editDraft.name.trim()) {
      setError('角色名称不能为空')
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const updated = await updateAdminRole(selectedRole.id, {
        name: editDraft.name.trim(),
        description: editDraft.description.trim(),
        is_active: editDraft.is_active,
        reason: payload.reason,
        ticket_id: payload.ticket_id,
      })
      setEditDialogOpen(false)
      await load(updated.id)
      setMessage('角色信息已更新')
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新角色失败')
    } finally {
      setSaving(false)
    }
  }

  const removeRole = async (payload: { reason: string; ticket_id: string }) => {
    if (!selectedRole || !editableRole) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      await deleteAdminRole(selectedRole.id, {
        reason: payload.reason,
        ticket_id: payload.ticket_id,
      })
      setDeleteDialogOpen(false)
      await load()
      setMessage('角色已删除')
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除角色失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-title font-semibold">权限管理</h1>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 p-3 text-body text-destructive">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-md border border-success/40 p-3 text-body text-success">
          {message}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>后台角色</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <PermissionGate permission={ADMIN_PERMISSION.ADMIN_ROLE_CREATE}>
              <Button
                className="w-full"
                disabled={loading || saving}
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus className="mr-1 h-4 w-4" />
                新建角色
              </Button>
            </PermissionGate>
            {roles.map((role) => (
              <button
                key={role.id}
                type="button"
                className={`w-full rounded-md border px-3 py-2 text-left text-body ${
                  selectedRoleId === role.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
                onClick={() => selectRole(role.id)}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{getRoleDisplayName(role)}</span>
                  {role.is_system ? <Badge variant="secondary">系统</Badge> : null}
                  {!role.is_active ? <Badge variant="warning">停用</Badge> : null}
                </div>
                <div className="text-caption text-muted-foreground">{role.code}</div>
              </button>
            ))}
            {!roles.length && !loading ? (
              <div className="rounded-md border border-dashed px-3 py-6 text-center text-body text-muted-foreground">
                暂无角色数据
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>角色权限</CardTitle>
            <CardDescription>
              当前角色：{selectedRole ? getRoleDisplayName(selectedRole) : '未选择'}，已选{' '}
              {selectedPermissions.length} 个权限点。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!editableRole && selectedRole ? (
              <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-body text-amber-800">
                系统内置角色只读，不支持编辑或删除。
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <PermissionGate permission={ADMIN_PERMISSION.ADMIN_ROLE_UPDATE}>
                <Button
                  variant="outline"
                  disabled={!editableRole}
                  onClick={() => setEditDialogOpen(true)}
                >
                  <Pencil className="mr-1 h-4 w-4" />
                  编辑角色
                </Button>
              </PermissionGate>
              <PermissionGate permission={ADMIN_PERMISSION.ADMIN_ROLE_DELETE}>
                <Button
                  variant="outline"
                  disabled={!editableRole}
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 className="mr-1 h-4 w-4" />
                  删除角色
                </Button>
              </PermissionGate>
              <Button
                variant="outline"
                disabled={!editableRole}
                onClick={() => setSelectedPermissions(permissionCodes)}
              >
                全选权限
              </Button>
              <Button
                variant="outline"
                disabled={!editableRole}
                onClick={() => setSelectedPermissions([])}
              >
                清空权限
              </Button>
              <PermissionGate
                permission={ADMIN_PERMISSION.ADMIN_ROLE_UPDATE}
                fallback={<Button disabled>只读</Button>}
              >
                <Button
                  disabled={loading || saving || !editableRole}
                  onClick={() => setPermissionDialogOpen(true)}
                >
                  保存权限
                </Button>
              </PermissionGate>
            </div>
            {groupedPermissions.map(({ category, items }) => {
              const activeItems = items.filter((item) => item.is_active)
              const activeCodes = activeItems.map((item) => item.code)
              const selectedCount = activeCodes.filter((code) =>
                selectedPermissions.includes(code)
              ).length
              const categoryChecked = activeCodes.length > 0 && selectedCount === activeCodes.length
              const categoryState = categoryChecked
                ? true
                : selectedCount > 0
                  ? ('indeterminate' as const)
                  : false
              const expanded = expandedCategories[category] ?? true
              return (
                <div key={category} className="rounded-md border">
                  <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
                    <button
                      type="button"
                      className="flex items-center gap-2 text-body font-medium"
                      onClick={() =>
                        setExpandedCategories((prev) => ({
                          ...prev,
                          [category]: !expanded,
                        }))
                      }
                    >
                      <span
                        className={cn('transition-transform', expanded ? 'rotate-0' : '-rotate-90')}
                      >
                        {expanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </span>
                      <span>{getCategoryDisplayName(category)}</span>
                      <span className="text-caption text-muted-foreground">
                        ({selectedCount}/{activeCodes.length})
                      </span>
                    </button>
                    <div className="flex items-center gap-2 text-caption text-muted-foreground">
                      <Checkbox
                        aria-label={`切换分类 ${getCategoryDisplayName(category)} 的全部权限`}
                        checked={categoryState}
                        disabled={!editableRole || activeCodes.length === 0}
                        onCheckedChange={(checked) =>
                          setCategoryPermissions(activeCodes, checked === true)
                        }
                      />
                      <span>按分类全选</span>
                    </div>
                  </div>
                  {expanded ? (
                    <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
                      {activeItems.map((permission) => (
                        <div
                          key={permission.code}
                          className="flex gap-2 rounded-md border p-2 text-body"
                        >
                          <Checkbox
                            aria-label={`切换权限 ${permission.name}`}
                            checked={selectedPermissions.includes(permission.code)}
                            disabled={!editableRole}
                            onCheckedChange={() => togglePermission(permission.code)}
                          />
                          <span>
                            <span className="font-medium">{permission.name}</span>
                            <span className="ml-2 text-caption text-muted-foreground">
                              {permission.code}
                            </span>
                            <span className="mt-1 block">
                              <Badge variant={riskVariant(permission.risk_level)}>
                                {getRiskDisplayName(permission.risk_level)}
                              </Badge>
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>

      <SensitiveActionConfirmDialog
        open={createDialogOpen}
        title="创建后台角色"
        targetLabel="自定义角色"
        impact="创建后可绑定后台账号，影响治理权限边界。"
        confirmText="确认"
        loading={saving}
        extraContent={
          <div className="space-y-3">
            <div>
              <label className="block text-body font-medium" htmlFor="admin-rbac-create-code">
                角色 code
              </label>
              <Input
                id="admin-rbac-create-code"
                className="mt-2"
                placeholder="例如：ops_manager"
                value={createDraft.code}
                onChange={(event) =>
                  setCreateDraft((prev) => ({ ...prev, code: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="block text-body font-medium" htmlFor="admin-rbac-create-name">
                角色名称
              </label>
              <Input
                id="admin-rbac-create-name"
                className="mt-2"
                placeholder="例如：运营经理"
                value={createDraft.name}
                onChange={(event) =>
                  setCreateDraft((prev) => ({ ...prev, name: event.target.value }))
                }
              />
            </div>
            <div>
              <label
                className="block text-body font-medium"
                htmlFor="admin-rbac-create-description"
              >
                说明
              </label>
              <Input
                id="admin-rbac-create-description"
                className="mt-2"
                placeholder="可选"
                value={createDraft.description}
                onChange={(event) =>
                  setCreateDraft((prev) => ({ ...prev, description: event.target.value }))
                }
              />
            </div>
          </div>
        }
        onCancel={() => setCreateDialogOpen(false)}
        onConfirm={createRole}
      />

      <SensitiveActionConfirmDialog
        open={editDialogOpen}
        title="编辑后台角色"
        targetLabel={
          selectedRole ? `${getRoleDisplayName(selectedRole)} (${selectedRole.code})` : '后台角色'
        }
        impact="角色元信息变更会影响后台账号识别和权限治理。"
        loading={saving}
        extraContent={
          <div className="space-y-3">
            <div>
              <label className="block text-body font-medium" htmlFor="admin-rbac-edit-name">
                角色名称
              </label>
              <Input
                id="admin-rbac-edit-name"
                className="mt-2"
                value={editDraft.name}
                onChange={(event) =>
                  setEditDraft((prev) => ({ ...prev, name: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="block text-body font-medium" htmlFor="admin-rbac-edit-description">
                说明
              </label>
              <Input
                id="admin-rbac-edit-description"
                className="mt-2"
                value={editDraft.description}
                onChange={(event) =>
                  setEditDraft((prev) => ({ ...prev, description: event.target.value }))
                }
              />
            </div>
            <div className="flex items-center gap-2 text-body">
              <Checkbox
                aria-label="启用该角色"
                checked={editDraft.is_active}
                onCheckedChange={(checked) =>
                  setEditDraft((prev) => ({ ...prev, is_active: checked === true }))
                }
              />
              启用该角色
            </div>
          </div>
        }
        onCancel={() => setEditDialogOpen(false)}
        onConfirm={updateRole}
      />

      <SensitiveActionConfirmDialog
        open={deleteDialogOpen}
        title="删除后台角色"
        targetLabel={
          selectedRole ? `${getRoleDisplayName(selectedRole)} (${selectedRole.code})` : '后台角色'
        }
        impact="删除后角色不可恢复，且已绑定后台账号会被阻止删除。"
        confirmText={selectedRole?.code || '确认'}
        loading={saving}
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={removeRole}
      />

      <SensitiveActionConfirmDialog
        open={permissionDialogOpen}
        title="保存角色权限"
        targetLabel={
          selectedRole ? `${getRoleDisplayName(selectedRole)} (${selectedRole.code})` : '后台角色'
        }
        impact={`将写入 ${selectedPermissions.length} 个权限点，请确认权限边界和工单信息。`}
        loading={saving}
        onCancel={() => setPermissionDialogOpen(false)}
        onConfirm={savePermissions}
      />
    </div>
  )
}
