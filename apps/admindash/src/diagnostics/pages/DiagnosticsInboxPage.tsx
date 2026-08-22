import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import { Download, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { createDiagnosticDownload, listDiagnosticBundles, type DiagnosticBundleItem } from '../api/diagnostics'

function short(value: string | null, length = 12) {
  if (!value) return '—'
  return value.length > length ? `${value.slice(0, length)}…` : value
}

function formatBytes(value: number) {
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function DiagnosticsInboxPage() {
  const { show } = useSimpleToast()
  const [lookup, setLookup] = useState('')
  const [items, setItems] = useState<DiagnosticBundleItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listDiagnosticBundles({ query: lookup.trim() })
      setItems(data.items)
      setTotal(data.pagination.total)
    } catch (err) {
      show(err instanceof Error ? err.message : '加载诊断包失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [lookup, show])

  // 首屏只加载一次；输入后由“查询”显式提交。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [])

  const download = async (item: DiagnosticBundleItem) => {
    setDownloading(item.id)
    try {
      const result = await createDiagnosticDownload(item.id)
      window.open(result.download_url, '_blank', 'noopener,noreferrer')
      show('已生成 5 分钟有效的下载链接')
    } catch (err) {
      show(err instanceof Error ? err.message : '生成下载链接失败', 'error')
    } finally {
      setDownloading(null)
    }
  }

  return (
    <AdminPage>
      <AdminPageHeader title="客户端诊断包" description="用户主动上传的完整日志与严重故障自动采集包。文件在可用后保留 24 小时，下载行为会被审计。" />
      <AdminListCard title="诊断包收件箱">
        <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void load() }}>
          <Input value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="输入用户 ID 或手机号" className="max-w-md" aria-label="用户 ID 或手机号" />
          <Button type="submit" disabled={loading}><Search className="mr-2 h-4 w-4" />查询</Button>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />刷新</Button>
        </form>
        <p className="mt-3 text-body text-muted-foreground">共 {total} 个诊断包。可按用户 ID 或手机号查询；中国大陆手机号支持 11 位、86 和 +86 写法。仅在用户明确选择上传时才会出现“用户主动上传”。</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-body" aria-label="客户端诊断包列表">
            <thead className="border-b text-muted-foreground"><tr><th className="p-2">来源</th><th className="p-2">用户 / 组织</th><th className="p-2">状态</th><th className="p-2">上传时间</th><th className="p-2">到期时间</th><th className="p-2">关联</th><th className="p-2" /></tr></thead>
            <tbody>
              {items.map((item) => <tr key={item.id} className="border-b last:border-0"><td className="p-2"><Badge variant={item.source === 'support_upload' ? 'default' : 'secondary'}>{item.source === 'support_upload' ? '用户主动上传' : '自动故障采集'}</Badge><div className="mt-1 text-muted-foreground">{formatBytes(item.bytes)}</div></td><td className="p-2 font-mono text-xs" title={`${item.user_id}\n${item.organization_id}`}>{short(item.user_id)}<br />{short(item.organization_id)}</td><td className="p-2"><Badge variant={item.status === 'available' && !item.expired ? 'success' : item.expired ? 'destructive' : 'warning'}>{item.expired ? '已过期' : item.status}</Badge></td><td className="p-2 whitespace-nowrap">{formatDateTime(item.created_at)}</td><td className="p-2 whitespace-nowrap">{formatDateTime(item.expires_at)}</td><td className="p-2 font-mono text-xs">{short(item.sentry_event_id)}</td><td className="p-2">{item.status === 'available' && !item.expired ? <Button size="sm" variant="outline" onClick={() => void download(item)} disabled={downloading === item.id}><Download className="mr-1 h-3.5 w-3.5" />下载</Button> : '—'}</td></tr>)}
              {!loading && !items.length ? <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">没有匹配的诊断包</td></tr> : null}
            </tbody>
          </table>
        </div>
      </AdminListCard>
    </AdminPage>
  )
}
