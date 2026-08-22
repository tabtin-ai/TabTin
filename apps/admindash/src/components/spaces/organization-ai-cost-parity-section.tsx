import {
  getOrganizationBillingPolicy,
  getOrganizationLowBalanceConfig,
  updateOrganizationBillingPolicy,
  updateOrganizationLowBalanceConfig,
} from '@/billing-management/api/billing-admin'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

/**
 * Electron「AI 成本」自动补充 + 低余额（OrganizationServiceCatalogPanel）的后台对齐。
 * 邮件提醒开关与 Electron 一致暂不展示（SHOW_LOW_BALANCE_EMAIL_ALERT=false）。
 * 预算策略 / 命中排障由同 tab「预算策略与命中」卡片负责，本组件不重复。
 */

/** 与 Electron OrganizationServiceCatalogPanel 一致：本期隐藏邮件提醒 */
const SHOW_LOW_BALANCE_EMAIL_ALERT = false

function formatYuanAmount(value?: string | number | null): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  // 去掉多余尾零，便于 Input 编辑
  return String(Number(n.toFixed(2)))
}

export interface OrganizationAiCostParitySectionProps {
  organizationId: string
}

export function OrganizationAiCostParitySection({
  organizationId,
}: OrganizationAiCostParitySectionProps) {
  const budgetHref = `/billing/budget?organization_id=${encodeURIComponent(organizationId)}`
  const orgBillingHref = `/organizations/${encodeURIComponent(organizationId)}#billing`

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const [topupEnabled, setTopupEnabled] = useState(false)
  const [topupAmount, setTopupAmount] = useState('')
  const [topupCap, setTopupCap] = useState('')
  const [monthTopupSpentYuan, setMonthTopupSpentYuan] = useState<string | null>(null)
  const [topupPolicyLoaded, setTopupPolicyLoaded] = useState(false)
  const [topupPolicyError, setTopupPolicyError] = useState(false)
  const [topupSaving, setTopupSaving] = useState(false)
  const [unlimitedCapConfirmOpen, setUnlimitedCapConfirmOpen] = useState(false)
  const [topupSensitiveOpen, setTopupSensitiveOpen] = useState(false)

  const [lowBalWarningCredits, setLowBalWarningCredits] = useState('')
  const [lowBalCriticalCredits, setLowBalCriticalCredits] = useState('')
  const [lowBalEmailEnabled, setLowBalEmailEnabled] = useState(true)
  const [lowBalLoadError, setLowBalLoadError] = useState(false)
  const [lowBalSaving, setLowBalSaving] = useState(false)
  const [lowBalSensitiveOpen, setLowBalSensitiveOpen] = useState(false)

  const load = useCallback(async () => {
    if (!organizationId) return
    setLoading(true)
    setLoadError(null)
    setActionError(null)
    setActionSuccess(null)

    let policyOk = false
    let lowBalOk = false
    const errors: string[] = []

    try {
      const policy = await getOrganizationBillingPolicy(organizationId)
      setTopupEnabled(!!policy.auto_topup_enabled)
      setTopupAmount(formatYuanAmount(policy.auto_topup_spend_yuan ?? '0'))
      setTopupCap(formatYuanAmount(policy.auto_topup_monthly_cap_yuan ?? '0'))
      setMonthTopupSpentYuan(policy.auto_topup_spent_yuan ?? null)
      setTopupPolicyError(false)
      policyOk = true
    } catch (e) {
      setTopupPolicyError(true)
      errors.push(e instanceof Error ? e.message : '加载自动补充策略失败')
    } finally {
      setTopupPolicyLoaded(true)
    }

    try {
      const cfg = await getOrganizationLowBalanceConfig(organizationId)
      setLowBalWarningCredits(cfg.warning_credits)
      setLowBalCriticalCredits(cfg.critical_credits)
      setLowBalEmailEnabled(cfg.email_enabled)
      setLowBalLoadError(false)
      lowBalOk = true
    } catch (e) {
      setLowBalLoadError(true)
      errors.push(e instanceof Error ? e.message : '加载低余额配置失败')
    }

    if (!policyOk && !lowBalOk) {
      setLoadError(errors.join('；') || '加载 AI 成本配置失败')
    } else if (errors.length) {
      setActionError(errors.join('；'))
    }

    setLoading(false)
  }, [organizationId])

  useEffect(() => {
    void load()
  }, [load])

  const validateTopup = useCallback((): string | null => {
    const amount = Number(topupAmount)
    const cap = Number(topupCap)
    if (topupEnabled) {
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(cap) || cap < 0) {
        return '请填写有效的每次补充金额与每月上限（金额须 > 0，上限 ≥ 0）'
      }
      if (cap > 0 && cap < amount) {
        return '每月上限不能小于每次补充金额'
      }
    }
    return null
  }, [topupEnabled, topupAmount, topupCap])

  const handleSaveTopupClick = useCallback(() => {
    setActionError(null)
    setActionSuccess(null)
    const err = validateTopup()
    if (err) {
      setActionError(err)
      return
    }
    const cap = Number(topupCap)
    if (topupEnabled && cap === 0) {
      setUnlimitedCapConfirmOpen(true)
      return
    }
    setTopupSensitiveOpen(true)
  }, [validateTopup, topupEnabled, topupCap])

  const persistTopup = useCallback(
    async (payload: { reason: string; ticket_id: string }) => {
      const amount = Number(topupAmount)
      const cap = Number(topupCap)
      setTopupSaving(true)
      setActionError(null)
      setActionSuccess(null)
      try {
        const policy = await updateOrganizationBillingPolicy(organizationId, {
          auto_topup_enabled: topupEnabled,
          ...(topupEnabled && Number.isFinite(amount) && amount > 0
            ? { auto_topup_spend_yuan: amount, auto_topup_monthly_cap_yuan: cap }
            : {}),
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        setTopupEnabled(!!policy.auto_topup_enabled)
        setTopupAmount(formatYuanAmount(policy.auto_topup_spend_yuan ?? '0'))
        setTopupCap(formatYuanAmount(policy.auto_topup_monthly_cap_yuan ?? '0'))
        if (policy.auto_topup_spent_yuan != null) {
          setMonthTopupSpentYuan(policy.auto_topup_spent_yuan)
        }
        setTopupSensitiveOpen(false)
        setActionSuccess('自动补充策略已保存')
      } catch (e) {
        setActionError(e instanceof Error ? e.message : '保存自动补充策略失败')
      } finally {
        setTopupSaving(false)
      }
    },
    [organizationId, topupEnabled, topupAmount, topupCap]
  )

  const validateLowBalance = useCallback((): string | null => {
    const wCredits = Number(lowBalWarningCredits)
    const cCredits = Number(lowBalCriticalCredits)
    if (!Number.isFinite(wCredits) || wCredits < 0 || !Number.isFinite(cCredits) || cCredits < 0) {
      return '预警 / 危急阈值须为非负数字'
    }
    if (cCredits >= wCredits) {
      return '危急阈值必须小于预警阈值'
    }
    return null
  }, [lowBalWarningCredits, lowBalCriticalCredits])

  const handleSaveLowBalanceClick = useCallback(() => {
    setActionError(null)
    setActionSuccess(null)
    const err = validateLowBalance()
    if (err) {
      setActionError(err)
      return
    }
    setLowBalSensitiveOpen(true)
  }, [validateLowBalance])

  const persistLowBalance = useCallback(
    async (payload: { reason: string; ticket_id: string }) => {
      const wCredits = Number(lowBalWarningCredits)
      const cCredits = Number(lowBalCriticalCredits)
      setLowBalSaving(true)
      setActionError(null)
      setActionSuccess(null)
      try {
        const cfg = await updateOrganizationLowBalanceConfig(organizationId, {
          warning_credits: wCredits,
          critical_credits: cCredits,
          ...(SHOW_LOW_BALANCE_EMAIL_ALERT ? { email_enabled: lowBalEmailEnabled } : {}),
          reason: payload.reason,
          ticket_id: payload.ticket_id,
        })
        setLowBalWarningCredits(cfg.warning_credits)
        setLowBalCriticalCredits(cfg.critical_credits)
        setLowBalEmailEnabled(cfg.email_enabled)
        setLowBalSensitiveOpen(false)
        setActionSuccess('低余额预警已保存')
      } catch (e) {
        setActionError(e instanceof Error ? e.message : '保存低余额配置失败')
      } finally {
        setLowBalSaving(false)
      }
    },
    [organizationId, lowBalWarningCredits, lowBalCriticalCredits, lowBalEmailEnabled]
  )

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>自动补充 / 低余额</CardTitle>
                <Badge variant="outline">可写</Badge>
              </div>
              <CardDescription>
                对齐 Electron Owner「AI 成本」：点券自动补充与低余额预警。组织{' '}
                <code className="text-caption">{organizationId}</code>。
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
                {loading ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                刷新
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link to={budgetHref}>
                  预算管理
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link to={orgBillingHref}>
                  本组织订阅与账单
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {loadError}
            </div>
          ) : null}
          {actionError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {actionError}
            </div>
          ) : null}
          {actionSuccess ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-body text-emerald-700 dark:text-emerald-300">
              {actionSuccess}
            </div>
          ) : null}

          {loading && !topupPolicyLoaded ? (
            <div className="flex h-20 items-center justify-center text-body text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载中…
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="space-y-3 rounded border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-subtitle font-medium">点券自动补充</div>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      点券不足时从组织现金钱包按金额购买补充
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={topupSaving || topupPolicyError || !topupPolicyLoaded}
                    onClick={handleSaveTopupClick}
                  >
                    {topupSaving ? '保存中…' : '保存'}
                  </Button>
                </div>

                {topupPolicyError ? (
                  <p className="text-body text-muted-foreground">
                    自动补充策略加载失败，请刷新重试。
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-body font-medium">启用自动补充</div>
                        <p className="text-caption text-muted-foreground">
                          关闭后不会从现金钱包扣款补充
                        </p>
                      </div>
                      <Switch
                        checked={topupEnabled}
                        disabled={!topupPolicyLoaded}
                        onCheckedChange={setTopupEnabled}
                      />
                    </div>
                    <div className="block space-y-1">
                      <div className="text-body font-medium">每次补充金额</div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-caption text-muted-foreground">¥</span>
                        <Input
                          type="number"
                          min={0.01}
                          step={0.01}
                          value={topupAmount}
                          disabled={!topupEnabled}
                          onChange={(e) => setTopupAmount(e.target.value)}
                          className="w-36 tabular-nums"
                          aria-label="每次补充金额（元）"
                        />
                      </div>
                    </div>
                    <div className="block space-y-1">
                      <div className="text-body font-medium">每月上限</div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-caption text-muted-foreground">¥</span>
                        <Input
                          type="number"
                          min={0}
                          step={0.01}
                          value={topupCap}
                          disabled={!topupEnabled}
                          onChange={(e) => setTopupCap(e.target.value)}
                          className="w-36 tabular-nums"
                          aria-label="每月上限（元）"
                        />
                      </div>
                      <p className="text-caption text-muted-foreground">填 0 表示本月不限额</p>
                    </div>
                    <p className="text-caption text-muted-foreground">
                      {monthTopupSpentYuan != null
                        ? `本月已补充 ¥${formatYuanAmount(monthTopupSpentYuan)}`
                        : '本月已补充金额暂不可用'}
                    </p>
                  </>
                )}
              </section>

              <section className="space-y-3 rounded border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-subtitle font-medium">低余额预警</div>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      点券余额低于阈值时触发预警 / 危急级别
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={lowBalSaving || lowBalLoadError}
                    onClick={handleSaveLowBalanceClick}
                  >
                    {lowBalSaving ? '保存中…' : '保存低余额'}
                  </Button>
                </div>

                {lowBalLoadError ? (
                  <p className="text-body text-muted-foreground">
                    低余额配置加载失败，请刷新重试。
                  </p>
                ) : (
                  <>
                    <div className="block space-y-1">
                      <div className="text-body font-medium">预警阈值</div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          value={lowBalWarningCredits}
                          onChange={(e) => setLowBalWarningCredits(e.target.value)}
                          className="w-36 tabular-nums"
                          aria-label="预警阈值（credits）"
                        />
                        <span className="text-caption text-muted-foreground">credits</span>
                      </div>
                    </div>
                    <div className="block space-y-1">
                      <div className="text-body font-medium">危急阈值</div>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          value={lowBalCriticalCredits}
                          onChange={(e) => setLowBalCriticalCredits(e.target.value)}
                          className="w-36 tabular-nums"
                          aria-label="危急阈值（credits）"
                        />
                        <span className="text-caption text-muted-foreground">credits</span>
                      </div>
                      <p className="text-caption text-muted-foreground">须小于预警阈值</p>
                    </div>
                    {SHOW_LOW_BALANCE_EMAIL_ALERT ? (
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-body font-medium">邮件提醒</div>
                          <p className="text-caption text-muted-foreground">
                            向组织 Owner 发送邮件
                          </p>
                        </div>
                        <Switch
                          checked={lowBalEmailEnabled}
                          onCheckedChange={setLowBalEmailEnabled}
                        />
                      </div>
                    ) : null}
                  </>
                )}
              </section>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={unlimitedCapConfirmOpen}
        onOpenChange={setUnlimitedCapConfirmOpen}
        title="确认不限额？"
        description="每月上限为 0 表示本月不限额：后端会跳过月上限检查，可能持续从现金钱包扣款补充点券。"
        confirmLabel="继续保存"
        variant="destructive"
        onConfirm={() => {
          setUnlimitedCapConfirmOpen(false)
          setTopupSensitiveOpen(true)
        }}
      />

      <SensitiveActionConfirmDialog
        open={topupSensitiveOpen}
        title="保存自动补充策略"
        targetLabel={`组织 ${organizationId}`}
        impact={`将${topupEnabled ? '启用' : '关闭'}自动补充${
          topupEnabled
            ? `：每次 ¥${formatYuanAmount(topupAmount)}，每月上限 ¥${formatYuanAmount(topupCap)}${
                Number(topupCap) === 0 ? '（不限额）' : ''
              }`
            : ''
        }。`}
        loading={topupSaving}
        onCancel={() => setTopupSensitiveOpen(false)}
        onConfirm={(payload) => void persistTopup(payload)}
      />

      <SensitiveActionConfirmDialog
        open={lowBalSensitiveOpen}
        title="保存低余额预警"
        targetLabel={`组织 ${organizationId}`}
        impact={`预警 ${lowBalWarningCredits} credits / 危急 ${lowBalCriticalCredits} credits。`}
        loading={lowBalSaving}
        onCancel={() => setLowBalSensitiveOpen(false)}
        onConfirm={(payload) => void persistLowBalance(payload)}
      />
    </>
  )
}
