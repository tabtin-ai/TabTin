/**
 * Skeleton HTML Viewer Modal
 * 全屏展示大型 HTML，支持智能折叠
 */

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { calculateHTMLSize, intelligentCollapseHTML } from '@/utils/htmlCollapse'
import { Braces, Check, Code, Copy, Download, FileCode, X } from 'lucide-react'
import { useMemo, useState } from 'react'

interface SkeletonViewerModalProps {
  isOpen: boolean
  onClose: () => void
  skeleton: {
    url: string
    html: string
    title?: string
  }
}

type ViewMode = 'smart-collapsed' | 'formatted' | 'raw'

export function SkeletonViewerModal({ isOpen, onClose, skeleton }: SkeletonViewerModalProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('smart-collapsed')
  const [copied, setCopied] = useState(false)

  // 计算 HTML 统计信息
  const stats = useMemo(() => {
    const lines = skeleton.html.split('\n').length
    const size = calculateHTMLSize(skeleton.html)
    const collapsed = intelligentCollapseHTML(skeleton.html)

    return {
      lines,
      size,
      collapsed,
    }
  }, [skeleton.html])

  // 复制到剪贴板
  const handleCopy = () => {
    navigator.clipboard.writeText(skeleton.html)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 下载为文件
  const handleDownload = () => {
    const blob = new Blob([skeleton.html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `skeleton-${Date.now()}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 在新标签页打开
  const handleOpenInNewTab = () => {
    const blob = new Blob([skeleton.html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 bg-background">
      {/* 头部 */}
      <div className="flex h-14 items-center justify-between border-b px-6">
        <div className="flex items-center gap-3">
          <FileCode className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-title font-semibold">Skeleton HTML Viewer</h2>
            <p className="text-body text-muted-foreground">{skeleton.title || 'Untitled'}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleCopy} className="h-8">
            {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
            {copied ? 'Copied!' : 'Copy'}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDownload} className="h-8">
            <Download className="mr-2 h-4 w-4" />
            Download
          </Button>
          <Button variant="ghost" size="sm" onClick={handleOpenInNewTab} className="h-8">
            <Code className="mr-2 h-4 w-4" />
            Open in New Tab
          </Button>
          <div className="w-px h-6 bg-border mx-2" />
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 统计信息栏 */}
      <div className="border-b bg-muted/30 px-6 py-2">
        <div className="flex items-center justify-between text-body">
          <div className="flex items-center gap-6">
            <div>
              <span className="text-muted-foreground">URL:</span>{' '}
              <span className="font-mono text-body">{skeleton.url}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Size:</span>{' '}
              <span className="font-mono">{stats.size.toFixed(1)} KB</span>
            </div>
            <div>
              <span className="text-muted-foreground">Lines:</span>{' '}
              <span className="font-mono">{stats.lines.toLocaleString()}</span>
            </div>
            {viewMode === 'smart-collapsed' && (
              <div>
                <span className="text-muted-foreground">Collapsed:</span>{' '}
                <span className="font-mono text-success">
                  {(
                    (1 -
                      stats.collapsed.stats.collapsedLines / stats.collapsed.stats.originalLines) *
                    100
                  ).toFixed(0)}
                  %
                </span>
                <span className="text-body text-muted-foreground ml-2">
                  (显示 {stats.collapsed.stats.collapsedLines} 行)
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 视图模式选项卡 */}
      <div className="border-b px-6">
        <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)} className="w-full">
          <TabsList className="h-11 bg-transparent">
            <TabsTrigger
              value="smart-collapsed"
              className="h-full rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              <Braces className="mr-2 h-4 w-4" />
              智能折叠
            </TabsTrigger>
            <TabsTrigger
              value="formatted"
              className="h-full rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              <Code className="mr-2 h-4 w-4" />
              格式化
            </TabsTrigger>
            <TabsTrigger
              value="raw"
              className="h-full rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              <FileCode className="mr-2 h-4 w-4" />
              原始 HTML
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden" style={{ height: 'calc(100vh - 140px)' }}>
        {/* 智能折叠视图 */}
        {viewMode === 'smart-collapsed' && (
          <ScrollArea className="h-full">
            <div className="p-6">
              <pre className="font-mono text-body leading-relaxed whitespace-pre-wrap">
                {stats.collapsed.collapsed}
              </pre>
            </div>
          </ScrollArea>
        )}

        {/* 格式化视图 */}
        {viewMode === 'formatted' && (
          <ScrollArea className="h-full">
            <div className="p-6">
              <pre className="font-mono text-body leading-relaxed whitespace-pre-wrap">
                {skeleton.html}
              </pre>
            </div>
          </ScrollArea>
        )}

        {/* 原始 HTML 视图 */}
        {viewMode === 'raw' && (
          <ScrollArea className="h-full">
            <div className="p-6">
              <div className="rounded-md border bg-muted/30 p-4">
                <pre className="font-mono text-body whitespace-pre-wrap break-all">
                  {skeleton.html}
                </pre>
              </div>
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
