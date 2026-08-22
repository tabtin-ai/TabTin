/**
 * Provider 多 Key 管理面板（v0.1）
 *
 * 对照宪法 v0.1 §1.2.3 列规格：
 *   label / 密钥前缀+后4位 / key_type / priority / 状态（cooldown_until / disabled_until） /
 *   最近使用 / 错误数 / 总调用数 / 操作（添加 / 编辑 priority / 启用禁用 / 重置错误计数 / 删除）
 *
 * 行内展开在 ProviderTable 中，每个 Provider 一份独立的 keys 子视图。
 */

import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { ADMIN_PERMISSION, hasAdminPermission } from '@/lib/admin-permissions'
import { useAuthStore } from '@/stores/auth-store'
import { useCallback, useEffect, useState } from 'react'
import {
  type CreateKeyPayload,
  type ProviderKeyItem,
  type UpdateKeyPayload,
  providersApi,
} from '../../api/providers'

interface ProviderKeysSectionProps {
  providerId: string
}

interface NewKeyDraft {
  label: string
  api_key: string
  priority: string
  key_type: 'api_key' | 'oauth' | 'token'
}

const emptyDraft = (): NewKeyDraft => ({
  label: '',
  api_key: '',
  priority: '0',
  key_type: 'api_key',
})

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function getKeyStatus(k: ProviderKeyItem): {
  label: string
  cls: string
} {
  const now = Date.now()
  if (k.disabled_until) {
    const until = new Date(k.disabled_until).getTime()
    if (until > now) {
      return { label: `已禁用（${formatTime(k.disabled_until)}）`, cls: 'text-red-600' }
    }
  }
  if (k.cooldown_until) {
    const until = new Date(k.cooldown_until).getTime()
    if (until > now) {
      return { label: `冷却中（${formatTime(k.cooldown_until)}）`, cls: 'text-amber-600' }
    }
  }
  if (k.is_usable) {
    return { label: '可用', cls: 'text-green-600' }
  }
  return { label: '不可用', cls: 'text-muted-foreground' }
}

export function ProviderKeysSection({ providerId }: ProviderKeysSectionProps) {
  const [keys, setKeys] = useState<ProviderKeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [draft, setDraft] = useState<NewKeyDraft>(emptyDraft)
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ProviderKeyItem | null>(null)
  const { adminPermissions } = useAuthStore()
  const canDeleteKey = hasAdminPermission(adminPermissions, ADMIN_PERMISSION.PROVIDER_KEY_DELETE)

  const fetchKeys = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await providersApi.listKeys(providerId)
      setKeys(data.keys)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [providerId])

  useEffect(() => {
    fetchKeys()
  }, [fetchKeys])

  const handleAdd = async () => {
    setError('')
    if (!draft.label.trim()) {
      setError('label 不能为空')
      return
    }
    if (!draft.api_key.trim()) {
      setError('api_key 不能为空')
      return
    }
    const payload: CreateKeyPayload = {
      label: draft.label.trim(),
      api_key: draft.api_key.trim(),
      key_type: draft.key_type,
      priority: Number(draft.priority) || 0,
    }
    setBusyKeyId('__new__')
    try {
      await providersApi.createKey(providerId, payload)
      setDraft(emptyDraft())
      setShowAddForm(false)
      setStatusMessage('已添加密钥')
      await fetchKeys()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setBusyKeyId(null)
    }
  }

  const handleUpdate = async (key: ProviderKeyItem, patch: UpdateKeyPayload, statusMsg: string) => {
    setBusyKeyId(key.id)
    try {
      await providersApi.updateKey(providerId, key.id, patch)
      setStatusMessage(statusMsg)
      await fetchKeys()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setBusyKeyId(null)
    }
  }

  const handleResetErrors = async (key: ProviderKeyItem) => {
    setBusyKeyId(key.id)
    try {
      await providersApi.resetKeyErrors(providerId, key.id)
      setStatusMessage(`密钥 ${key.label} 错误计数已重置`)
      await fetchKeys()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setBusyKeyId(null)
    }
  }

  const handleDelete = async (payload: { reason: string; ticket_id: string }) => {
    if (!deleteTarget) return
    setBusyKeyId(deleteTarget.id)
    try {
      await providersApi.deleteKey(providerId, deleteTarget.id, payload)
      setStatusMessage(`密钥 ${deleteTarget.label} 已删除`)
      setDeleteTarget(null)
      await fetchKeys()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setBusyKeyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-body font-semibold">密钥列表（{keys.length}）</h4>
        <button
          type="button"
          className="rounded-md border px-2.5 py-1 text-caption font-medium hover:bg-muted transition-colors"
          onClick={() => setShowAddForm((v) => !v)}
        >
          {showAddForm ? '收起表单' : '+ 添加密钥'}
        </button>
      </div>

      {showAddForm && (
        <div className="rounded-md border p-3 space-y-2 bg-muted/30">
          <div className="grid grid-cols-4 gap-2">
            <input
              type="text"
              placeholder="label（如 main / backup）"
              className="rounded-md border px-2 py-1.5 text-caption bg-background"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <input
              type="password"
              autoComplete="off"
              placeholder="api_key（sk-...）"
              className="col-span-2 rounded-md border px-2 py-1.5 text-caption font-mono bg-background"
              value={draft.api_key}
              onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
            />
            <input
              type="number"
              placeholder="priority"
              className="rounded-md border px-2 py-1.5 text-caption bg-background"
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
            />
          </div>
          <div className="flex items-center justify-between">
            <select
              className="rounded-md border px-2 py-1 text-caption bg-background"
              value={draft.key_type}
              onChange={(e) =>
                setDraft({ ...draft, key_type: e.target.value as NewKeyDraft['key_type'] })
              }
            >
              <option value="api_key">api_key</option>
              <option value="oauth">oauth</option>
              <option value="token">token</option>
            </select>
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1 text-caption font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={handleAdd}
              disabled={busyKeyId === '__new__'}
            >
              {busyKeyId === '__new__' ? '保存中…' : '保存密钥'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-6 text-center text-caption text-muted-foreground">加载密钥列表…</div>
      ) : keys.length === 0 ? (
        <div className="rounded-md border border-dashed py-6 text-center text-caption text-muted-foreground">
          此 Provider 暂无密钥，点击右上角「+ 添加密钥」录入
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="px-2.5 py-2 text-left font-medium">label</th>
                <th className="px-2.5 py-2 text-left font-medium">前缀+后4位</th>
                <th className="px-2.5 py-2 text-left font-medium">type</th>
                <th className="px-2.5 py-2 text-center font-medium">priority</th>
                <th className="px-2.5 py-2 text-left font-medium">状态</th>
                <th className="px-2.5 py-2 text-left font-medium">最近使用</th>
                <th className="px-2.5 py-2 text-center font-medium">错误数</th>
                <th className="px-2.5 py-2 text-center font-medium">总调用</th>
                <th className="px-2.5 py-2 text-center font-medium">总 token</th>
                <th className="px-2.5 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const status = getKeyStatus(k)
                const busy = busyKeyId === k.id
                const isDisabled = !!(
                  k.disabled_until && new Date(k.disabled_until).getTime() > Date.now()
                )
                return (
                  <tr key={k.id} className="border-b hover:bg-muted/10 transition-colors">
                    <td className="px-2.5 py-2 font-medium">{k.label}</td>
                    <td className="px-2.5 py-2">
                      <code className="rounded bg-muted px-1 text-[10px] font-mono">
                        {k.api_key_preview}
                      </code>
                    </td>
                    <td className="px-2.5 py-2 text-muted-foreground">{k.key_type}</td>
                    <td className="px-2.5 py-2 text-center">
                      <input
                        type="number"
                        defaultValue={k.priority}
                        disabled={busy}
                        className="w-16 rounded border px-1 py-0.5 text-center text-caption bg-background"
                        onBlur={(e) => {
                          const next = Number(e.target.value)
                          if (Number.isFinite(next) && next !== k.priority) {
                            handleUpdate(k, { priority: next }, `${k.label} priority 已更新`)
                          }
                        }}
                      />
                    </td>
                    <td className={`px-2.5 py-2 ${status.cls}`}>{status.label}</td>
                    <td className="px-2.5 py-2 text-muted-foreground">
                      {formatTime(k.last_used_at)}
                    </td>
                    <td className="px-2.5 py-2 text-center">{k.error_count}</td>
                    <td className="px-2.5 py-2 text-center">{k.total_requests}</td>
                    <td className="px-2.5 py-2 text-center text-muted-foreground">
                      {k.total_tokens.toLocaleString('zh-CN')}
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="flex flex-wrap justify-end gap-1">
                        {isDisabled ? (
                          <button
                            type="button"
                            className="rounded px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
                            onClick={() =>
                              handleUpdate(k, { is_active: true }, `密钥 ${k.label} 已启用`)
                            }
                            disabled={busy}
                          >
                            启用
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="rounded px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                            onClick={() =>
                              handleUpdate(k, { is_active: false }, `密钥 ${k.label} 已禁用`)
                            }
                            disabled={busy}
                          >
                            禁用
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                          onClick={() => handleResetErrors(k)}
                          disabled={busy}
                        >
                          重置错误
                        </button>
                        {canDeleteKey ? (
                          <button
                            type="button"
                            className="rounded px-2 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-100 dark:hover:bg-red-900/40"
                            onClick={() => setDeleteTarget(k)}
                            disabled={busy}
                          >
                            删除
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-caption text-red-700 dark:bg-red-950/40 dark:border-red-900/60 dark:text-red-300">
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-caption text-emerald-700 dark:bg-emerald-950/40 dark:border-emerald-900/60 dark:text-emerald-300">
          {statusMessage}
        </div>
      )}
      <SensitiveActionConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 Provider Key"
        targetLabel={deleteTarget?.label ?? ''}
        impact="删除后该密钥将立即失效，Provider 可能因剩余可用密钥不足而降级。"
        confirmText="删除密钥"
        loading={Boolean(deleteTarget && busyKeyId === deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(payload) => void handleDelete(payload)}
      />
    </div>
  )
}
