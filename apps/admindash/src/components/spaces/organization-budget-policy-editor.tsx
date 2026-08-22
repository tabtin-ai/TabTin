import {
  type BudgetPolicy,
  createBudgetPolicy,
  deleteBudgetPolicy,
  updateBudgetPolicy,
} from '@/billing-management/api/billing-admin'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useEffect, useMemo, useState } from 'react'

export interface OrganizationBudgetPolicyEditorProps {
  organizationId: string
  policy: BudgetPolicy | null
  onChanged: () => void
}

const DEFAULTS = {
  warning_threshold_percent: 80,
  critical_threshold_percent: 100,
  block_on_critical: false,
  is_active: true,
}

export function OrganizationBudgetPolicyEditor({
  organizationId,
  policy,
  onChanged,
}: OrganizationBudgetPolicyEditorProps) {
  const [warning, setWarning] = useState(String(DEFAULTS.warning_threshold_percent))
  const [critical, setCritical] = useState(String(DEFAULTS.critical_threshold_percent))
  const [blockOnCritical, setBlockOnCritical] = useState(DEFAULTS.block_on_critical)
  const [isActive, setIsActive] = useState(DEFAULTS.is_active)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    if (policy) {
      setWarning(String(policy.warning_threshold_percent))
      setCritical(String(policy.critical_threshold_percent))
      setBlockOnCritical(!!policy.block_on_critical)
      setIsActive(policy.is_active !== false)
    } else {
      setWarning(String(DEFAULTS.warning_threshold_percent))
      setCritical(String(DEFAULTS.critical_threshold_percent))
      setBlockOnCritical(DEFAULTS.block_on_critical)
      setIsActive(DEFAULTS.is_active)
    }
    setError(null)
    setSuccess(null)
  }, [policy])

  const validationError = useMemo(() => {
    const w = Number(warning)
    const c = Number(critical)
    if (!Number.isFinite(w) || !Number.isFinite(c)) return '阈值必须是数字'
    if (w < 0 || c < 0) return '阈值不能为负数'
    if (c < w) return '严重阈值不能小于预警阈值'
    return null
  }, [warning, critical])

  const openSave = () => {
    setError(null)
    setSuccess(null)
    if (validationError) {
      setError(validationError)
      return
    }
    setSaveOpen(true)
  }

  const persistSave = async () => {
    const w = Number(warning)
    const c = Number(critical)
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const body = {
        organization_id: organizationId,
        warning_threshold_percent: w,
        critical_threshold_percent: c,
        block_on_critical: blockOnCritical,
        is_active: isActive,
      }
      if (policy?.id) {
        await updateBudgetPolicy(policy.id, body)
        setSuccess('预算策略已更新')
      } else {
        await createBudgetPolicy(body)
        setSuccess('预算策略已创建')
      }
      setSaveOpen(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存预算策略失败')
    } finally {
      setSaving(false)
    }
  }

  const persistDelete = async () => {
    if (!policy?.id) return
    setDeleting(true)
    setError(null)
    setSuccess(null)
    try {
      await deleteBudgetPolicy(policy.id)
      setDeleteOpen(false)
      setSuccess('预算策略已删除')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除预算策略失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      {policy?.id ? (
        <div className="text-caption text-muted-foreground break-all">策略 ID：{policy.id}</div>
      ) : (
        <div className="text-caption text-muted-foreground">
          本组织尚未配置预算策略，保存后将创建一条。
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-body text-emerald-700 dark:text-emerald-300">
          {success}
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="text-body font-medium">预警阈值</div>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            step={1}
            value={warning}
            onChange={(e) => setWarning(e.target.value)}
            className="w-28 tabular-nums"
            aria-label="预警阈值百分比"
          />
          <span className="text-caption text-muted-foreground">%</span>
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-body font-medium">严重阈值</div>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={0}
            step={1}
            value={critical}
            onChange={(e) => setCritical(e.target.value)}
            className="w-28 tabular-nums"
            aria-label="严重阈值百分比"
          />
          <span className="text-caption text-muted-foreground">%</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-body font-medium">严重阈值硬阻断</div>
          <p className="text-caption text-muted-foreground">开启后达到严重阈值将拒绝新请求</p>
        </div>
        <Switch checked={blockOnCritical} onCheckedChange={setBlockOnCritical} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-body font-medium">启用策略</div>
          <p className="text-caption text-muted-foreground">关闭后不再参与命中计算</p>
        </div>
        <Switch checked={isActive} onCheckedChange={setIsActive} />
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" onClick={openSave} disabled={saving || deleting}>
          {saving ? '保存中…' : policy ? '保存修改' : '创建策略'}
        </Button>
        {policy ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null)
              setDeleteOpen(true)
            }}
            disabled={saving || deleting}
          >
            删除策略
          </Button>
        ) : null}
      </div>

      <SensitiveActionConfirmDialog
        open={saveOpen}
        title={policy ? '保存预算策略' : '创建预算策略'}
        targetLabel={`组织 ${organizationId}`}
        impact={
          policy
            ? `将更新本组织预算报警线：预警 ${warning}% / 严重 ${critical}%；硬阻断 ${blockOnCritical ? '开' : '关'}；启用 ${isActive ? '是' : '否'}。`
            : `将为本组织创建预算报警线：预警 ${warning}% / 严重 ${critical}%；硬阻断 ${blockOnCritical ? '开' : '关'}。`
        }
        loading={saving}
        onCancel={() => setSaveOpen(false)}
        onConfirm={() => void persistSave()}
      />

      <SensitiveActionConfirmDialog
        open={deleteOpen}
        title="删除预算策略"
        targetLabel={`组织 ${organizationId}`}
        impact="删除后本组织不再有预算报警线，命中记录也会随之消失（用量本身不受影响）。"
        confirmText="删除策略"
        confirmButtonLabel="确认删除"
        loading={deleting}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void persistDelete()}
      />
    </div>
  )
}
