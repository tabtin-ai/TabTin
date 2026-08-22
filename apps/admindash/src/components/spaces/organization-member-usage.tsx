import { spaceAdminApi } from '@/api/space-admin'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { MemberUsageItem } from '@/types/space-admin'
import { Loader2, RefreshCw, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

const METER_LABELS: Record<string, string> = {
  'llm.tokens': 'LLM',
  'storage.gb_day': '存储',
  'storage.bytes': '存储',
  'speech.asr.seconds': '语音识别',
  'speech.tts.characters': '语音合成',
  'media.image.count': '图片生成',
  'media.video.seconds': '视频生成',
  'rag.embedding.tokens': 'RAG',
}

const PERIOD_OPTIONS = [
  { label: '近 7 天', value: '7' },
  { label: '近 30 天', value: '30' },
  { label: '近 60 天', value: '60' },
  { label: '近 90 天', value: '90' },
]

interface OrganizationMemberUsageProps {
  organizationId: string
}

export function OrganizationMemberUsage({ organizationId }: OrganizationMemberUsageProps) {
  const [members, setMembers] = useState<MemberUsageItem[]>([])
  const [totalCredits, setTotalCredits] = useState('0')
  const [memberCount, setMemberCount] = useState(0)
  const [periodDays, setPeriodDays] = useState('30')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (days: string) => {
      setLoading(true)
      setError(null)
      try {
        const res = await spaceAdminApi.getOrganizationMemberUsage(organizationId, Number(days))
        setMembers(res.members)
        setTotalCredits(res.total_credits)
        setMemberCount(res.member_count)
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载成员消费统计失败')
        setMembers([])
      } finally {
        setLoading(false)
      }
    },
    [organizationId]
  )

  useEffect(() => {
    void load(periodDays)
  }, [periodDays, load])

  const maxCredits =
    members.length > 0 ? Math.max(...members.map((m) => Number(m.total_credits)), 0.01) : 1

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-subtitle">
            <Users className="h-4 w-4" />
            成员消费排行
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={periodDays} onValueChange={setPeriodDays}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load(periodDays)}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {error && (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        )}

        {loading && members.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-body text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : members.length === 0 && !error ? (
          <div className="rounded-md border border-dashed p-4 text-center text-body text-muted-foreground">
            所选时间段内暂无消费记录
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-md border bg-muted/10 px-3 py-2 text-body">
              <span className="text-muted-foreground">
                {memberCount} 位成员在近 {periodDays} 天内产生消费
              </span>
              <span className="font-medium">
                总计 {Number(totalCredits).toLocaleString(undefined, { maximumFractionDigits: 0 })}{' '}
                credits
              </span>
            </div>

            <div className="space-y-2">
              {members.map((member, idx) => {
                const credits = Number(member.total_credits)
                const barPct = (credits / maxCredits) * 100
                return (
                  <div key={member.user_id} className="rounded-md border bg-background p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-caption font-bold text-muted-foreground">
                          {idx + 1}
                        </span>
                        <span className="truncate text-body font-medium">
                          {member.display_name}
                        </span>
                        <span className="text-caption text-muted-foreground">
                          {member.user_id.slice(0, 8)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-body text-muted-foreground">
                          {member.event_count} 次
                        </span>
                        <Badge variant="outline" className="tabular-nums">
                          {member.percentage}%
                        </Badge>
                        <span className="w-20 text-right font-mono text-body font-semibold">
                          {credits.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-muted/30 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary/50 transition-all"
                        style={{ width: `${Math.max(barPct, 0.5)}%` }}
                      />
                    </div>
                    {member.by_meter.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {member.by_meter.map((meter) => (
                          <span
                            key={meter.meter_key}
                            className="rounded bg-muted/20 px-1.5 py-0.5 text-caption text-muted-foreground"
                          >
                            {METER_LABELS[meter.meter_key] ?? meter.meter_key}{' '}
                            {Number(meter.credits).toLocaleString(undefined, {
                              maximumFractionDigits: 0,
                            })}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
