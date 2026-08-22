import { joinApiPath } from '@tabtin/config'
import React, { useEffect, useState } from 'react'
import { Shield, Trash2, UserPlus } from 'lucide-react'
import { Button, Input, ScrollArea, Dialog, DialogContent, DialogHeader, DialogTitle } from '@components/ui'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import { addErrorBreadcrumb } from '@/services/errorReporter'

const log = createLogger('ResourcePermission')

interface PermissionEntry {
  id: string
  subject_type: string
  subject_id: string
  permission: string
  granted_by: string
  created_at: string
}

interface ResourcePermissionDialogProps {
  resourceType: string
  resourceId: string
  resourceName?: string
  onClose: () => void
}

const PERMISSION_LABELS: Record<string, string> = {
  viewer: '查看者',
  editor: '编辑者',
  admin: '管理员',
  owner: '所有者',
}

export const ResourcePermissionDialog: React.FC<ResourcePermissionDialogProps> = ({
  resourceType, resourceId, resourceName, onClose,
}) => {
  const [permissions, setPermissions] = useState<PermissionEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [newSubjectId, setNewSubjectId] = useState('')
  const [newPermission, setNewPermission] = useState<'viewer' | 'editor'>('viewer')
  const [error, setError] = useState('')

  useEffect(() => { void loadPermissions() }, [])

  const apiCall = async (url: string, method: string, body?: any) => {
    const token = await getAuthToken()
    return adapterApiRequest({
      url: joinApiPath(API_CONFIG.baseURL, `${url}`),
      method: method as any,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }

  const loadPermissions = async () => {
    setIsLoading(true)
    try {
      const response = await apiCall(
        API_ENDPOINTS.RESOURCE_PERMISSIONS.LIST(resourceType, resourceId),
        'GET',
      )
      if (response?.data?.success) {
        setPermissions(response.data.data.permissions || [])
      }
    } catch (err) {
      log.error('加载资源权限列表失败', { resourceType, resourceId }, err)
    }
    finally { setIsLoading(false) }
  }

  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newSubjectId.trim()) { setError('请输入用户 ID'); return }
    setIsLoading(true)
    setError('')
    // 授权是关键副作用：记面包屑丰富出错前时间线（不打 subject 值，避免泄露手机号/邮箱式 ID）
    addErrorBreadcrumb('action', 'permission', 'grant', { resourceType, resourceId, permission: newPermission })
    try {
      await apiCall(
        API_ENDPOINTS.RESOURCE_PERMISSIONS.GRANT(resourceType, resourceId),
        'POST',
        { subject_type: 'user', subject_id: newSubjectId.trim(), permission: newPermission },
      )
      log.info('授权成功', { resourceType, resourceId, permission: newPermission })
      setShowAdd(false)
      setNewSubjectId('')
      await loadPermissions()
    } catch (err) {
      log.error('授权失败', { resourceType, resourceId, permission: newPermission }, err)
      setError(err instanceof Error ? err.message : '授权失败')
    } finally { setIsLoading(false) }
  }

  const handleRevoke = async (permissionId: string) => {
    setIsLoading(true)
    addErrorBreadcrumb('action', 'permission', 'revoke', { resourceType, resourceId, permissionId })
    try {
      await apiCall(
        API_ENDPOINTS.RESOURCE_PERMISSIONS.REVOKE(resourceType, resourceId, permissionId),
        'DELETE',
      )
      log.info('撤销权限成功', { resourceType, resourceId, permissionId })
      await loadPermissions()
    } catch (err) {
      log.error('撤销权限失败', { resourceType, resourceId, permissionId }, err)
    }
    finally { setIsLoading(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            <DialogTitle className="text-subtitle font-semibold">权限管理</DialogTitle>
          </div>
        </DialogHeader>

        {resourceName && (
          <p className="text-body text-muted-foreground mb-4">
            {resourceName}
          </p>
        )}

        {error && (
          <div className="p-2 mb-3 bg-destructive/10 border border-destructive/20 rounded-lg">
            <p className="text-body text-destructive">{error}</p>
          </div>
        )}

        {!showAdd && (
          <Button variant="outline" size="form" onClick={() => setShowAdd(true)} className="mb-3 w-full">
            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
            添加权限
          </Button>
        )}

        {showAdd && (
          <form onSubmit={handleGrant} className="mb-4 p-3 bg-muted rounded-lg space-y-2">
            <Input
              value={newSubjectId}
              onChange={(e) => setNewSubjectId(e.target.value)}
              placeholder="用户 ID"
              className="text-body"
            />
            <div className="flex gap-1.5">
              {(['viewer', 'editor'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setNewPermission(p)}
                  className={cn(
                    'flex-1 px-2 py-1 rounded text-body transition-colors',
                    newPermission === p ? 'bg-primary text-primary-foreground' : 'bg-background border hover:bg-accent',
                  )}
                >
                  {PERMISSION_LABELS[p]}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="form" type="button" onClick={() => setShowAdd(false)} className="flex-1">
                取消
              </Button>
              <Button size="form" type="submit" disabled={isLoading} className="flex-1">
                授权
              </Button>
            </div>
          </form>
        )}

        <ScrollArea className="max-h-60">
          <div className="divide-y divide-border/30">
          {permissions.map((perm) => (
            <div key={perm.id} className="py-2.5 flex items-center justify-between">
              <div>
                <p className="text-body font-mono">{perm.subject_id}</p>
                <p className="text-body text-muted-foreground">
                  {perm.subject_type} · {PERMISSION_LABELS[perm.permission] || perm.permission}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleRevoke(perm.id)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          </div>
        </ScrollArea>

        {permissions.length === 0 && !isLoading && (
          <p className="text-body text-muted-foreground text-center py-4">暂无自定义权限</p>
        )}

        <Button variant="outline" size="form" onClick={onClose} className="w-full mt-4">
          关闭
        </Button>
      </DialogContent>
    </Dialog>
  )
}
