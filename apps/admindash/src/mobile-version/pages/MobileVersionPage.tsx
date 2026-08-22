import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
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
import { Loader2, RefreshCw, Save, Smartphone } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  type MobilePlatform,
  type MobileVersionPolicy,
  listMobileVersionPolicies,
  saveMobileVersionPolicy,
} from '../api/mobile-version'

const PLATFORM_LABELS: Record<MobilePlatform, string> = {
  ios: 'iOS',
  android: 'Android',
}

type FormState = {
  enabled: boolean
  soft_prompt_enabled: boolean
  min_supported_build: string
  latest_build: string
  min_supported_version: string
  latest_version: string
  store_url: string
  force_title: string
  force_message: string
  soft_title: string
  soft_message: string
}

function policyToForm(policy: MobileVersionPolicy): FormState {
  return {
    enabled: policy.enabled,
    soft_prompt_enabled: policy.soft_prompt_enabled,
    min_supported_build: String(policy.min_supported_build ?? 0),
    latest_build: String(policy.latest_build ?? 0),
    min_supported_version: policy.min_supported_version || '',
    latest_version: policy.latest_version || '',
    store_url: policy.store_url || '',
    force_title: policy.force_title || '',
    force_message: policy.force_message || '',
    soft_title: policy.soft_title || '',
    soft_message: policy.soft_message || '',
  }
}


export function MobileVersionPage() {
  const { show: showToast, element: toastElement } = useSimpleToast()
  const [items, setItems] = useState<MobileVersionPolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [apiUnavailable, setApiUnavailable] = useState(false)
  const [editing, setEditing] = useState<MobileVersionPolicy | null>(null)
  const [form, setForm] = useState<FormState | null>(null)

  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listMobileVersionPolicies()
      setItems(data.items || [])
      setApiUnavailable(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载移动端版本策略失败'
      if (message.includes('404')) {
        setItems([])
        setApiUnavailable(true)
        showToast('当前后端未接入移动端版本门禁接口', 'error')
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

  const openEditDialog = (policy: MobileVersionPolicy) => {
    setEditing(policy)
    setForm(policyToForm(policy))
  }

  const closeDialog = () => {
    setEditing(null)
    setForm(null)
  }

  const handleSave = async () => {
    if (!editing || !form) return
    const minBuild = Number.parseInt(form.min_supported_build || '0', 10)
    const latestBuild = Number.parseInt(form.latest_build || '0', 10)
    if (Number.isNaN(minBuild) || minBuild < 0 || Number.isNaN(latestBuild) || latestBuild < 0) {
      showToast('build 号必须是非负整数', 'error')
      return
    }
    if (latestBuild && latestBuild < minBuild) {
      showToast('最新 build 不能小于最低支持 build', 'error')
      return
    }
    setSaving(true)
    try {
      await saveMobileVersionPolicy(editing.platform, {
        enabled: form.enabled,
        soft_prompt_enabled: form.soft_prompt_enabled,
        min_supported_build: minBuild,
        latest_build: latestBuild,
        min_supported_version: form.min_supported_version.trim(),
        latest_version: form.latest_version.trim(),
        store_url: form.store_url.trim(),
        force_title: form.force_title.trim(),
        force_message: form.force_message.trim(),
        soft_title: form.soft_title.trim(),
        soft_message: form.soft_message.trim(),
      })
      showToast('策略已保存')
      closeDialog()
      await loadItems()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存策略失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))

  return (
    <AdminPage>
      {toastElement}
      <AdminPageHeader
        icon={Smartphone}
        title="移动端版本门禁"
        description="配置 iOS / Android 最低支持版本；低于最低版本的客户端会被强制要求更新（不可跳过）。注意最低版本只能卡已上架的历史版本，避免拦住正在审核的新包。"
        actions={
          <Button variant="outline" onClick={loadItems} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        }
      />

      <AdminListCard title="平台策略">
        {apiUnavailable ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            当前后端未接入移动端版本门禁接口
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
                  <th className="px-3 py-2 font-medium">平台</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">最低支持 build</th>
                  <th className="px-3 py-2 font-medium">最新 build</th>
                  <th className="px-3 py-2 font-medium">去更新地址</th>
                  <th className="px-3 py-2 font-medium">更新时间</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.platform} className="border-b last:border-0">
                    <td className="px-3 py-3 font-medium">
                      {PLATFORM_LABELS[item.platform] ?? item.platform}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={item.enabled ? 'default' : 'outline'}>
                          {item.enabled ? '启用' : '停用'}
                        </Badge>
                        {item.soft_prompt_enabled ? (
                          <Badge variant="secondary">软提示</Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-3 font-mono">
                      {item.min_supported_build}
                      {item.min_supported_version ? (
                        <span className="ml-1 text-muted-foreground">
                          ({item.min_supported_version})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 font-mono">
                      {item.latest_build || '-'}
                      {item.latest_version ? (
                        <span className="ml-1 text-muted-foreground">
                          ({item.latest_version})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 max-w-xs truncate text-muted-foreground">
                      {item.store_url || '-'}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {formatDateTime(item.updated_at)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => openEditDialog(item)}>
                          编辑
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminListCard>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => (open ? undefined : closeDialog())}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              编辑 {editing ? (PLATFORM_LABELS[editing.platform] ?? editing.platform) : ''} 版本策略
            </DialogTitle>
          </DialogHeader>

          {form ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex items-center gap-2 md:col-span-2">
                <input
                  id="mobile-version-enabled"
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => setField('enabled', event.target.checked)}
                />
                <label htmlFor="mobile-version-enabled" className="text-body font-medium">
                  启用门禁（停用后该平台恒不拦截）
                </label>
              </div>
              <div className="flex items-center gap-2 md:col-span-2">
                <input
                  id="mobile-version-soft-enabled"
                  type="checkbox"
                  checked={form.soft_prompt_enabled}
                  onChange={(event) => setField('soft_prompt_enabled', event.target.checked)}
                />
                <label htmlFor="mobile-version-soft-enabled" className="text-body font-medium">
                  启用软提示（推荐更新）
                  <span className="ml-1 font-normal text-muted-foreground">
                    默认关；不影响强制更新。开启后落在「最低支持~最新」区间的用户会看到可关闭的更新提示，同一版本点「稍后」不再重复弹。
                  </span>
                </label>
              </div>
              <label className="space-y-1" htmlFor="mobile-version-min-build">
                <span className="text-body font-medium">最低支持 build（低于强制更新）</span>
                <Input
                  id="mobile-version-min-build"
                  type="number"
                  value={form.min_supported_build}
                  onChange={(event) => setField('min_supported_build', event.target.value)}
                />
              </label>
              <label className="space-y-1" htmlFor="mobile-version-latest-build">
                <span className="text-body font-medium">最新 build（低于推荐更新，0 关闭软提示）</span>
                <Input
                  id="mobile-version-latest-build"
                  type="number"
                  value={form.latest_build}
                  onChange={(event) => setField('latest_build', event.target.value)}
                />
              </label>
              <label className="space-y-1" htmlFor="mobile-version-min-version">
                <span className="text-body font-medium">最低支持版本号（仅展示）</span>
                <Input
                  id="mobile-version-min-version"
                  value={form.min_supported_version}
                  onChange={(event) => setField('min_supported_version', event.target.value)}
                  placeholder="1.2.0"
                />
              </label>
              <label className="space-y-1" htmlFor="mobile-version-latest-version">
                <span className="text-body font-medium">最新版本号（仅展示）</span>
                <Input
                  id="mobile-version-latest-version"
                  value={form.latest_version}
                  onChange={(event) => setField('latest_version', event.target.value)}
                  placeholder="1.3.0"
                />
              </label>
              <label className="space-y-1 md:col-span-2" htmlFor="mobile-version-store-url">
                <span className="text-body font-medium">
                  去更新跳转地址（Android 建议填官网落地页）
                </span>
                <Input
                  id="mobile-version-store-url"
                  value={form.store_url}
                  onChange={(event) => setField('store_url', event.target.value)}
                  placeholder="https://..."
                />
              </label>
              <label className="space-y-1" htmlFor="mobile-version-force-title">
                <span className="text-body font-medium">强更标题（留空用默认）</span>
                <Input
                  id="mobile-version-force-title"
                  value={form.force_title}
                  onChange={(event) => setField('force_title', event.target.value)}
                />
              </label>
              <label className="space-y-1" htmlFor="mobile-version-soft-title">
                <span className="text-body font-medium">推荐更新标题（留空用默认）</span>
                <Input
                  id="mobile-version-soft-title"
                  value={form.soft_title}
                  onChange={(event) => setField('soft_title', event.target.value)}
                />
              </label>
              <label className="space-y-1 md:col-span-2" htmlFor="mobile-version-force-message">
                <span className="text-body font-medium">强更正文（留空用默认）</span>
                <Textarea
                  id="mobile-version-force-message"
                  value={form.force_message}
                  onChange={(event) => setField('force_message', event.target.value)}
                />
              </label>
              <label className="space-y-1 md:col-span-2" htmlFor="mobile-version-soft-message">
                <span className="text-body font-medium">推荐更新正文（留空用默认）</span>
                <Textarea
                  id="mobile-version-soft-message"
                  value={form.soft_message}
                  onChange={(event) => setField('soft_message', event.target.value)}
                />
              </label>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
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
    </AdminPage>
  )
}
