import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { AlertTriangle, Loader2, Plus, RefreshCw, Save, Settings2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type PlatformConfigItem,
  type PlatformConfigValueType,
  deletePlatformConfigItem,
  listPlatformConfigItems,
  savePlatformConfigItem,
  updatePlatformConfigItem,
} from '../api/platform-config'

type FormState = {
  key: string
  name: string
  description: string
  category: string
  value_type: PlatformConfigValueType
  value: string
  default_value: string
  is_active: boolean
  is_system: boolean
  sort_order: string
  extra_schema: string
}

const VALUE_TYPES: { value: PlatformConfigValueType; label: string }[] = [
  { value: 'integer', label: '整数' },
  { value: 'decimal', label: '小数' },
  { value: 'boolean', label: '布尔' },
  { value: 'string', label: '字符串' },
  { value: 'json', label: 'JSON' },
]

const emptyForm: FormState = {
  key: '',
  name: '',
  description: '',
  category: 'product_limits',
  value_type: 'integer',
  value: '3',
  default_value: '3',
  is_active: true,
  is_system: false,
  sort_order: '100',
  extra_schema: '{}',
}

function valueToText(value: unknown, type: PlatformConfigValueType): string {
  if (type === 'json') return JSON.stringify(value ?? {}, null, 2)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (value === null || value === undefined) return ''
  return String(value)
}

function itemToForm(item: PlatformConfigItem): FormState {
  return {
    key: item.key,
    name: item.name,
    description: item.description || '',
    category: item.category,
    value_type: item.value_type,
    value: valueToText(item.value, item.value_type),
    default_value: valueToText(item.default_value, item.value_type),
    is_active: item.is_active,
    is_system: item.is_system,
    sort_order: String(item.sort_order ?? 0),
    extra_schema: JSON.stringify(item.extra_schema ?? {}, null, 2),
  }
}

function parseTypedValue(raw: string, type: PlatformConfigValueType): unknown {
  if (type === 'integer') return Number.parseInt(raw, 10)
  if (type === 'decimal') return raw.trim()
  if (type === 'boolean') return raw === 'true'
  if (type === 'json') return raw.trim() ? JSON.parse(raw) : {}
  return raw
}


export function PlatformConfigPage() {
  const { show: showToast, element: toastElement } = useSimpleToast()
  const [items, setItems] = useState<PlatformConfigItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<PlatformConfigItem | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [deleteTarget, setDeleteTarget] = useState<PlatformConfigItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [apiUnavailable, setApiUnavailable] = useState(false)

  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listPlatformConfigItems({ include_inactive: true })
      setItems(data.items || [])
      setApiUnavailable(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载公共配置失败'
      if (message.includes('404')) {
        setItems([])
        setApiUnavailable(true)
        showToast('当前后端未接入平台配置接口', 'error')
      } else {
        showToast(message, 'error')
      }
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  const categories = useMemo(
    () => ['all', ...Array.from(new Set(items.map((item) => item.category))).sort()],
    [items]
  )

  const filteredItems = useMemo(() => {
    if (selectedCategory === 'all') return items
    return items.filter((item) => item.category === selectedCategory)
  }, [items, selectedCategory])

  const productLimitCount = items.filter((item) => item.category === 'product_limits').length
  const activeCount = items.filter((item) => item.is_active).length

  const openCreateDialog = () => {
    setEditingItem(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  const openEditDialog = (item: PlatformConfigItem) => {
    setEditingItem(item)
    setForm(itemToForm(item))
    setDialogOpen(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const extraSchema = form.extra_schema.trim() ? JSON.parse(form.extra_schema) : {}
      const payload = {
        key: form.key.trim(),
        name: form.name.trim(),
        description: form.description,
        category: form.category.trim(),
        value_type: form.value_type,
        value: parseTypedValue(form.value, form.value_type),
        default_value: parseTypedValue(form.default_value, form.value_type),
        is_active: form.is_active,
        sort_order: Number.parseInt(form.sort_order || '0', 10),
        extra_schema: extraSchema,
      }

      if (editingItem) {
        await updatePlatformConfigItem(editingItem.key, payload)
        showToast('配置已更新')
      } else {
        await savePlatformConfigItem({ ...payload, is_system: form.is_system })
        showToast('配置已创建')
      }

      setDialogOpen(false)
      await loadItems()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存配置失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (payload: { reason: string; ticket_id: string }) => {
    if (!deleteTarget) return
    if (deleteTarget.is_system) {
      showToast('系统内置配置不能删除，可以停用或修改配置值', 'error')
      return
    }
    setDeleting(true)
    try {
      await deletePlatformConfigItem(deleteTarget.key, payload)
      showToast('配置已删除')
      setDeleteTarget(null)
      await loadItems()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除配置失败', 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AdminPage>
      {toastElement}
      <AdminPageHeader
        icon={Settings2}
        title="公共配置 / 平台限制"
        actions={
          <>
            <Button variant="outline" onClick={loadItems} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新
            </Button>
            <Button onClick={openCreateDialog} disabled={apiUnavailable}>
              <Plus className="mr-2 h-4 w-4" />
              新增配置
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <AdminMetricCard title="配置总数" value={items.length} icon={Settings2} />
        <AdminMetricCard title="已启用" value={activeCount} icon={Settings2} />
        <AdminMetricCard title="产品限制" value={productLimitCount} icon={AlertTriangle} />
      </div>

      <AdminListCard
        title="配置列表"
        actions={
          <select
            className="h-9 rounded-md border bg-background px-3 text-body"
            value={selectedCategory}
            onChange={(event) => setSelectedCategory(event.target.value)}
          >
            {categories.map((category) => (
              <option key={category} value={category}>
                {category === 'all' ? '全部分类' : category}
              </option>
            ))}
          </select>
        }
      >
        {apiUnavailable ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            当前后端未接入平台配置接口
          </div>
        ) : loading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">配置项</th>
                  <th className="px-3 py-2 font-medium">分类</th>
                  <th className="px-3 py-2 font-medium">类型</th>
                  <th className="px-3 py-2 font-medium">当前值</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">更新时间</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={item.key} className="border-b last:border-0">
                    <td className="px-3 py-3">
                      <div className="font-medium">{item.name}</div>
                      <div className="mt-1 font-mono text-small text-muted-foreground">
                        {item.key}
                      </div>
                      {item.description ? (
                        <div className="mt-1 max-w-xl text-small text-muted-foreground">
                          {item.description}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">{item.category}</td>
                    <td className="px-3 py-3">{item.value_type}</td>
                    <td className="px-3 py-3 font-mono">
                      {valueToText(item.value, item.value_type)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={item.is_active ? 'default' : 'outline'}>
                          {item.is_active ? '启用' : '停用'}
                        </Badge>
                        {item.is_system ? <Badge variant="secondary">内置</Badge> : null}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {formatDateTime(item.updated_at)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openEditDialog(item)}>
                          编辑
                        </Button>
                        {!item.is_system ? (
                          <PermissionGate permission={ADMIN_PERMISSION.PLATFORM_CONFIG_UPDATE}>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              onClick={() => setDeleteTarget(item)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </PermissionGate>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminListCard>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingItem ? '编辑配置' : '新增配置'}</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1" htmlFor="platform-config-key">
              <span className="text-body font-medium">配置键</span>
              <Input
                id="platform-config-key"
                value={form.key}
                disabled={Boolean(editingItem)}
                onChange={(event) => setForm((prev) => ({ ...prev, key: event.target.value }))}
                placeholder="product_limits.max_organizations_per_user"
              />
            </label>
            <label className="space-y-1" htmlFor="platform-config-name">
              <span className="text-body font-medium">名称</span>
              <Input
                id="platform-config-name"
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </label>
            <label className="space-y-1" htmlFor="platform-config-category">
              <span className="text-body font-medium">分类</span>
              <Input
                id="platform-config-category"
                value={form.category}
                onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
              />
            </label>
            <label className="space-y-1" htmlFor="platform-config-value-type">
              <span className="text-body font-medium">类型</span>
              <select
                id="platform-config-value-type"
                className="h-9 w-full rounded-md border bg-background px-3 text-body"
                value={form.value_type}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    value_type: event.target.value as PlatformConfigValueType,
                  }))
                }
              >
                {VALUE_TYPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1" htmlFor="platform-config-value">
              <span className="text-body font-medium">当前值</span>
              <Input
                id="platform-config-value"
                value={form.value}
                onChange={(event) => setForm((prev) => ({ ...prev, value: event.target.value }))}
              />
            </label>
            <label className="space-y-1" htmlFor="platform-config-default-value">
              <span className="text-body font-medium">默认值</span>
              <Input
                id="platform-config-default-value"
                value={form.default_value}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, default_value: event.target.value }))
                }
              />
            </label>
            <label className="space-y-1" htmlFor="platform-config-sort-order">
              <span className="text-body font-medium">排序</span>
              <Input
                id="platform-config-sort-order"
                type="number"
                value={form.sort_order}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, sort_order: event.target.value }))
                }
              />
            </label>
            <div className="flex items-center gap-4 pt-7">
              <label className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, is_active: event.target.checked }))
                  }
                />
                启用
              </label>
              <label className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={form.is_system}
                  disabled={Boolean(editingItem)}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, is_system: event.target.checked }))
                  }
                />
                系统内置
              </label>
            </div>
            <label className="space-y-1 md:col-span-2" htmlFor="platform-config-description">
              <span className="text-body font-medium">描述</span>
              <Textarea
                id="platform-config-description"
                value={form.description}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, description: event.target.value }))
                }
              />
            </label>
            <label className="space-y-1 md:col-span-2" htmlFor="platform-config-extra-schema">
              <span className="text-body font-medium">表单元数据 JSON</span>
              <Textarea
                id="platform-config-extra-schema"
                className="font-mono"
                rows={5}
                value={form.extra_schema}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, extra_schema: event.target.value }))
                }
              />
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SensitiveActionConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除平台配置"
        targetLabel={deleteTarget?.key ?? ''}
        impact="删除后该配置项将从平台运行时移除，依赖此配置的功能可能立刻受影响。"
        confirmText="删除配置"
        loading={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(payload) => void handleDelete(payload)}
      />
    </AdminPage>
  )
}
