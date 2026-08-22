import { getApiClient } from '@/api/tabtin-client'
import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { Loader2, Package, PencilLine, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

interface CreditPackage {
  id: string
  name: string
  description: string
  price: string
  credits_amount: number
  bonus_credits: number
  total_credits: number
  discount_percentage: number
  sort_order: number
  is_active: boolean
  created_at: string | null
  updated_at: string | null
}

interface PackageForm {
  name: string
  description: string
  price: string
  credits_amount: number
  bonus_credits: number
  sort_order: number
  is_active: boolean
}

const EMPTY_FORM: PackageForm = {
  name: '',
  description: '',
  price: '',
  credits_amount: 0,
  bonus_credits: 0,
  sort_order: 0,
  is_active: true,
}

export function CreditPackageManagement({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()

  const [packages, setPackages] = useState<CreditPackage[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<PackageForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CreditPackage | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getApiClient().raw<{ packages: CreditPackage[] }>(
        'GET',
        '/services/billing/admin/billing/credit-packages'
      )
      setPackages(data.packages || [])
    } catch {
      showToast('加载套餐失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing('__new__')
    setForm(EMPTY_FORM)
  }

  const openEdit = (pkg: CreditPackage) => {
    setEditing(pkg.id)
    setForm({
      name: pkg.name,
      description: pkg.description,
      price: pkg.price,
      credits_amount: pkg.credits_amount,
      bonus_credits: pkg.bonus_credits,
      sort_order: pkg.sort_order,
      is_active: pkg.is_active,
    })
  }

  const handleSave = async () => {
    if (!form.name.trim() || !form.price) {
      showToast('名称和价格不能为空', 'error')
      return
    }
    setSaving(true)
    try {
      if (editing === '__new__') {
        await getApiClient().raw('POST', '/services/billing/admin/billing/credit-packages', {
          body: form,
        })
        showToast('套餐创建成功', 'success')
      } else {
        await getApiClient().raw(
          'PUT',
          `/services/billing/admin/billing/credit-packages/${editing}`,
          {
            body: form,
          }
        )
        showToast('套餐更新成功', 'success')
      }
      setEditing(null)
      void load()
    } catch {
      showToast('保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (payload: { reason: string; ticket_id: string }) => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await getApiClient().raw(
        'DELETE',
        `/services/billing/admin/billing/credit-packages/${deleteTarget.id}`,
        { params: { reason: payload.reason, ticket_id: payload.ticket_id } }
      )
      showToast('套餐已删除', 'success')
      setDeleteTarget(null)
      void load()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败', 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <AdminPage className={embedded ? 'space-y-4' : undefined}>
      {toastEl}
      <AdminPageHeader
        title="credits 包"
        icon={Package}
        back={
          embedded
            ? undefined
            : {
                label: '返回商品与定价',
                onClick: () => navigate('/billing/products'),
              }
        }
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            新建套餐
          </Button>
        }
      />

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setEditing(null)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === '__new__' ? '新建套餐' : '编辑套餐'}</DialogTitle>
            <DialogDescription>
              价格用元，额度用点，保存后客户端可按上下架状态售卖。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="credit-package-name" className="space-y-1 text-body">
              <span className="font-medium">套餐名称</span>
              <Input
                id="credit-package-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label htmlFor="credit-package-price" className="space-y-1 text-body">
              <span className="font-medium">价格（元）</span>
              <Input
                id="credit-package-price"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </label>
            <label htmlFor="credit-package-credits" className="space-y-1 text-body">
              <span className="font-medium">基础 credits 数</span>
              <Input
                id="credit-package-credits"
                type="number"
                value={form.credits_amount}
                onChange={(e) =>
                  setForm({ ...form, credits_amount: Number.parseInt(e.target.value) || 0 })
                }
              />
            </label>
            <label htmlFor="credit-package-bonus-credits" className="space-y-1 text-body">
              <span className="font-medium">赠送 credits 数</span>
              <Input
                id="credit-package-bonus-credits"
                type="number"
                value={form.bonus_credits}
                onChange={(e) =>
                  setForm({ ...form, bonus_credits: Number.parseInt(e.target.value) || 0 })
                }
              />
            </label>
            <label htmlFor="credit-package-sort-order" className="space-y-1 text-body">
              <span className="font-medium">排序</span>
              <Input
                id="credit-package-sort-order"
                type="number"
                value={form.sort_order}
                onChange={(e) =>
                  setForm({ ...form, sort_order: Number.parseInt(e.target.value) || 0 })
                }
              />
            </label>
            <label htmlFor="credit-package-description" className="space-y-1 text-body">
              <span className="font-medium">描述</span>
              <Input
                id="credit-package-description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Switch
                checked={form.is_active}
                onCheckedChange={(v) => setForm({ ...form, is_active: v })}
              />
              <span className="text-body">启用</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AdminListCard
        title="credits 包列表"
        description="价格用元，额度用点，避免和钱包余额混用。"
        actions={<Badge variant="outline">共 {packages.length} 个</Badge>}
      >
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : packages.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">暂无 credits 包</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-3 py-2">名称</th>
                  <th className="px-3 py-2">价格</th>
                  <th className="px-3 py-2">基础 / 赠送</th>
                  <th className="px-3 py-2">总 credits</th>
                  <th className="px-3 py-2">排序</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <tr key={pkg.id} className="border-b">
                    <td className="px-3 py-2 font-medium">{pkg.name}</td>
                    <td className="px-3 py-2">¥{pkg.price}</td>
                    <td className="px-3 py-2">
                      {pkg.credits_amount} / {pkg.bonus_credits}
                    </td>
                    <td className="px-3 py-2">{pkg.total_credits}</td>
                    <td className="px-3 py-2">{pkg.sort_order}</td>
                    <td className="px-3 py-2">
                      <Badge variant={pkg.is_active ? 'success' : 'secondary'}>
                        {pkg.is_active ? '启用' : '停用'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(pkg)}>
                          <PencilLine className="h-4 w-4" />
                        </Button>
                        <PermissionGate permission={ADMIN_PERMISSION.CREDIT_PACKAGE_UPDATE}>
                          <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(pkg)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </PermissionGate>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminListCard>
      <SensitiveActionConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 credits 套餐"
        targetLabel={deleteTarget?.name ?? ''}
        impact="删除后该套餐将无法继续售卖，历史订单仍保留但无法再被新购。"
        confirmText="删除套餐"
        loading={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(payload) => void handleDelete(payload)}
      />
    </AdminPage>
  )
}
