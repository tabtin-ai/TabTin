import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { type UsageFilters, usageApi } from '../../api/usage'

interface ExportCsvButtonProps {
  filters: UsageFilters
  disabled?: boolean
}

function makeFilename(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `llm_usage_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.csv`
}

// 从浏览器层触发 Blob 下载（后端 streaming response，CSV header 已含 BOM）。
export function ExportCsvButton({ filters, disabled }: ExportCsvButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleClick = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)
    try {
      const blob = await usageApi.exportCsv({ ...filters, maxRows: 50000 })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = makeFilename()
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 2500)
    } catch (e) {
      const message =
        e instanceof Error ? e.message : typeof e === 'string' ? e : '导出失败'
      setError(message)
      setTimeout(() => setError(null), 4000)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={handleClick}
        className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-caption font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {loading ? '导出中…' : '导出 CSV'}
      </button>
      {error && (
        <span className="text-caption text-rose-600 dark:text-rose-300">⚠ {error}</span>
      )}
      {success && (
        <span className="text-caption text-emerald-600 dark:text-emerald-300">
          ✓ 下载完成
        </span>
      )}
    </div>
  )
}
