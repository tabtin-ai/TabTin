/**
 * FolderSearch — 文件夹内关键词搜索面板
 *
 * 调用主进程 ripgrepSearch，展示匹配结果列表。
 * 点击结果可选中文件并跳转预览。
 *
 * 健壮性要点（ 修复）：
 * - 失败显式反馈：ripgrepSearch 返回 success:false 或抛错时设置 error state，
 *   UI 显示「搜索失败 + 原因」，区别于「无匹配结果」。之前静默 setResults([])
 *   会让用户搜什么都是「无匹配结果」，看起来就是「搜索功能无效」。
 * - IME composing 屏蔽：中文输入法组词期间不触发 doSearch，避免拿半截拼音 /
 *   半截汉字去搜，导致用户感觉「输入就搜、搜不到」。
 * - abortRef 取消旧请求：用户快速输入时只保留最新一次 doSearch 的结果，
 *   防止旧请求慢一拍回来覆盖新结果。
 * - Windows 路径兼容：ripgrep 在 Windows 下返回的 file 路径用 `\` 分隔，
 *   rootPath 被 normalize 成 `/`。直接 startsWith 比较永远不成立，会展示
 *   完整绝对路径；handleSearchSelect 里 split('/') 也不会切，name 会变成
 *   整个路径。统一走 split(/[\\/]/) 处理。
 * - rootPath 变化时清空 query / results：避免切换目录后残留旧目录的搜索态。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X, Loader2, AlertTriangle } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { FileIcon } from '@components/shared/file-icon/FileIcon'
import { getBaseName } from './utils'

interface SearchResult {
  file: string
  line: number
  column: number
  text: string
  matchText: string
  isDirectory?: boolean
  matchKind?: 'content' | 'path'
}

interface FolderSearchProps {
  rootPath: string
  onSelectResult: (filePath: string, line?: number, isDirectory?: boolean) => void
  onClose: () => void
  className?: string
}

export const FolderSearch: React.FC<FolderSearchProps> = ({
  rootPath,
  onSelectResult,
  onClose,
  className,
}) => {
  const { t } = useTranslation('context')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const isComposingRef = useRef(false)
  // abortRef：每次 doSearch 自增 nonce，await 回来后比对，旧请求的结果丢弃。
  // 比 useKeywordSearch 的 abortRef boolean 更适合这里——多次快速输入时只
  // 认最新一次的 nonce，不会出现「旧请求 boolean 翻 false 又翻 true」的竞态。
  const searchNonceRef = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // rootPath 变化（切目录 / 切 Space）时清空搜索态，避免新目录里残留旧结果。
  useEffect(() => {
    setQuery('')
    setResults([])
    setHasSearched(false)
    setError(null)
    setTruncated(false)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
    searchNonceRef.current++  // 让已经在飞的旧请求回来时被丢弃
  }, [rootPath])

  const doSearch = useCallback(async (pattern: string) => {
    const trimmed = pattern.trim()
    if (!trimmed) {
      setResults([])
      setHasSearched(false)
      setError(null)
      setTruncated(false)
      return
    }
    const nonce = ++searchNonceRef.current
    setIsSearching(true)
    setHasSearched(true)
    setError(null)
    try {
      const res = await window.tabtin.fileSystem.ripgrepSearch({
        cwd: rootPath,
        pattern: trimmed,
        maxResults: 100,
        includePathMatches: true,
      })
      // 丢弃过期响应：用户在 await 期间又输入了新关键词，旧结果不应覆盖新结果。
      if (nonce !== searchNonceRef.current) return
      if (res.success) {
        setResults(res.results ?? [])
        setTruncated(res.truncated ?? false)
      } else {
        // 失败显式反馈：之前静默 setResults([]) 会让用户以为「无匹配」，
        // 但实际可能是 rg 没装 / 路径无权限 / 超时——这条 error 文案让用户
        // 知道是搜索本身失败，并把后端 error 透出来便于诊断。
        setResults([])
        setTruncated(false)
        setError(res.error || t('folder.search.failed', { defaultValue: '搜索失败' }))
      }
    } catch (err) {
      if (nonce !== searchNonceRef.current) return
      setResults([])
      setTruncated(false)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (nonce === searchNonceRef.current) {
        setIsSearching(false)
      }
    }
  }, [rootPath, t])

  const handleInputChange = useCallback((value: string) => {
    setQuery(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    // IME composing 期间不触发 doSearch：用户在用中文输入法组词时，
    // e.target.value 是半截拼音 / 半截汉字，搜了也是噪音；等 compositionEnd
    // 再走一次 doSearch。composing 期间仍要把字符同步到 input（setQuery），
    // 否则用户看不到自己正在输入。
    if (isComposingRef.current) return
    timerRef.current = setTimeout(() => doSearch(value), 300)
  }, [doSearch])

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLInputElement>) => {
    isComposingRef.current = false
    // compositionEnd 时 value 已经是最终汉字，补发起一次搜索。composing 期间
    // handleInputChange 跳过了 doSearch，如果不在 end 时补一次，用户确认汉字后
    // 还要再敲一个字符才会触发搜索——这就是「输入中文搜不到」的体感来源。
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => doSearch((e.target as HTMLInputElement).value), 300)
  }, [doSearch])

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  const getRelativePath = (absPath: string) => {
    // Windows 下 ripgrep 返回的路径用 `\`，rootPath 被 FileExplorerPane normalize
    // 成 `/`。直接 startsWith 比较永远不成立，会落进 else 分支返回完整绝对路径，
    // 在 UI 里铺一长串。统一把 absPath 也 normalize 成 `/` 再比，命中后跳过
    // rootPath + 1 个分隔符。
    const normalizedAbs = absPath.replace(/\\/g, '/')
    const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalizedAbs.startsWith(normalizedRoot + '/')) {
      return normalizedAbs.slice(normalizedRoot.length + 1)
    }
    if (normalizedAbs === normalizedRoot) return ''
    return absPath
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 搜索输入 */}
      <div className="flex items-center gap-1.5 px-2 py-2 border-b border-border/20">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <input
          ref={inputRef}
          className="flex-1 min-w-0 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground/40"
          placeholder={t('folder.search.placeholder', { defaultValue: '搜索文件或文件夹...' })}
          value={query}
          onChange={e => handleInputChange(e.target.value)}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
          }}
        />
        {isSearching && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/40" />}
        <button
          className="p-0.5 rounded text-muted-foreground/40 hover:text-foreground transition-colors"
          onClick={onClose}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* 搜索结果 */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {/* 错误态：搜索本身失败（rg 没装 / 路径无权限 / 超时 / IPC 拒绝）。
            必须独立于「无匹配结果」——前者是搜索功能失效，后者是搜了但没命中。
             之前这里没有 error 分支，失败时静默 setResults([]) 落进 noResults
            分支，用户看到「无匹配结果」但实际是搜索挂了，体感就是「搜索功能无效」。 */}
        {error && !isSearching ? (
          <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-8 text-center text-caption text-destructive/80">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive/70" />
            <span>{t('folder.search.failed', { defaultValue: '搜索失败' })}</span>
            <span className="text-muted-foreground/60 break-all max-w-full">{error}</span>
          </div>
        ) : hasSearched && !isSearching && results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-caption text-muted-foreground/60">
            {t('folder.search.noResults', { defaultValue: '无匹配结果' })}
          </div>
        ) : (
          <div className="flex flex-col py-1">
            {results.map((r, i) => (
              <button
                key={`${r.file}:${r.line}:${i}`}
                type="button"
                className="flex flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-muted/30 min-w-0"
                onClick={() => onSelectResult(r.file, r.line, r.isDirectory)}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <FileIcon
                    fileName={getBaseName(r.file) || r.file}
                    isDirectory={Boolean(r.isDirectory)}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                  <span className="truncate text-caption text-foreground/80">
                    {getRelativePath(r.file)}
                  </span>
                  {r.matchKind !== 'path' && (
                    <span className="shrink-0 text-caption text-muted-foreground/40 tabular-nums">
                      :{r.line}
                    </span>
                  )}
                </div>
                <div className="pl-[18px] truncate text-caption text-muted-foreground/60 font-mono">
                  {r.matchKind === 'path'
                    ? t(
                      r.isDirectory ? 'folder.search.folderNameMatch' : 'folder.search.fileNameMatch',
                      { defaultValue: r.isDirectory ? '文件夹名称匹配' : '文件名称匹配' },
                    )
                    : r.text.trim()}
                </div>
              </button>
            ))}
            {truncated && (
              <div className="px-3 py-2 text-caption text-muted-foreground/40 text-center">
                {t('folder.search.truncated', { defaultValue: '结果过多，仅显示前 100 条' })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
