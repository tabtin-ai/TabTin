import {
  getOrganizationServiceCatalog,
  type ServiceCatalogItem,
} from '@/billing-management/api/billing-admin'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatMeterUnitPrice } from '@/lib/billing-labels'
import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

const CATEGORY_LABELS: Record<string, string> = {
  llm: '大模型',
  media: '多媒体',
  speech: '语音',
  knowledge: '知识',
  storage: '存储',
}

const CATEGORY_ORDER = ['llm', 'media', 'speech', 'knowledge', 'storage']

function formatPrice(item: ServiceCatalogItem): string {
  if (item.unit_price == null || item.unit_price === '') {
    return '按模型动态定价'
  }
  return formatMeterUnitPrice({
    unitPrice: item.unit_price,
    currency: 'CREDITS',
    unit: item.unit || '单位',
  })
}

export function OrganizationBillingPricingParitySection({
  organizationId,
}: {
  organizationId: string
}) {
  const [services, setServices] = useState<ServiceCatalogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getOrganizationServiceCatalog(organizationId)
      setServices(data.services || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载计费规则失败')
      setServices([])
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    void load()
  }, [load])

  const grouped = useMemo(() => {
    const map = new Map<string, ServiceCatalogItem[]>()
    for (const svc of services) {
      const key = svc.category || 'other'
      const list = map.get(key) ?? []
      list.push(svc)
      map.set(key, list)
    }
    const keys = [
      ...CATEGORY_ORDER.filter((k) => map.has(k)),
      ...[...map.keys()].filter((k) => !CATEGORY_ORDER.includes(k)),
    ]
    return keys.map((key) => ({ key, items: map.get(key) ?? [] }))
  }, [services])

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-subtitle">计费规则</CardTitle>
            <CardDescription className="mt-1">
              只读查看各 AI 服务的计费方式、单价和单位。
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        ) : null}
        {loading && services.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载服务目录…
          </div>
        ) : null}
        {!loading && services.length === 0 && !error ? (
          <div className="rounded-md border border-dashed px-3 py-6 text-center text-body text-muted-foreground">
            暂无服务目录数据
          </div>
        ) : null}

        {grouped.map((group) => (
          <section key={group.key} className="space-y-2">
            <h4 className="text-body font-medium">
              {CATEGORY_LABELS[group.key] ?? group.key}
            </h4>
            <div className="divide-y rounded-md border bg-background">
              {group.items.map((item) => (
                <div
                  key={item.service_key}
                  className="flex items-start justify-between gap-4 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-medium">{item.name}</span>
                      {!item.enabled ? <Badge variant="secondary">已关闭</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-caption text-muted-foreground">{item.description}</p>
                  </div>
                  <div className="shrink-0 text-right text-body font-medium tabular-nums">
                    {formatPrice(item)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}

        <p className="text-caption text-muted-foreground">
          此处仅展示计费规则；模型请看「模型配置」，成本保护请看「AI 成本」。
        </p>
      </CardContent>
    </Card>
  )
}
