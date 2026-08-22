/**
 * LLM Event 专用查看器
 * 用于展示 LLM Event 的 messages 和 response
 * 支持智能折叠和简洁模式
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { LLMEvent } from '@/types/agent-debug'
import { AlertCircle, Brain, Check, ChevronDown, ChevronRight, Copy, Eye } from 'lucide-react'
import { useMemo, useState } from 'react'
import { SkeletonViewerModal } from './skeleton-viewer-modal'

interface LLMEventViewerProps {
  event: LLMEvent
}

interface Message {
  role: string
  content: string
  isError?: boolean // 标记是否为错误消息
  isToolCall?: boolean // 标记是否为工具调用
}

interface ToolSummary {
  total: number
  unique: number
  duplicateCount: number
  duplicateNames: string[]
  duplicateNameSet: Set<string>
  domainCounts: Record<string, number>
}

interface ToolInjectionMetrics {
  schema_tools_count?: number
  runtime_tools_count?: number
  runtime_tools_unique_count?: number
  runtime_tools_duplicate_count?: number
  registry_tools_count?: number
  runtime_domains?: string[]
}

function inferToolDomain(toolName: string): string {
  if (
    toolName.startsWith('file_') ||
    toolName.startsWith('code_') ||
    toolName === 'read_diagnostics' ||
    toolName === 'tool_search'
  ) {
    return 'tabcode'
  }
  if (toolName.startsWith('sql_')) return 'sql'
  if (toolName === 'todo_write') return 'todo'
  if (toolName.startsWith('rag_')) return 'rag'
  if (toolName === 'terminal_execute' || toolName === 'execute_in_terminal') return 'terminal'
  if (toolName.startsWith('web_')) return 'web'
  if (
    toolName.startsWith('batch_') ||
    toolName.startsWith('create_') ||
    toolName.startsWith('update_') ||
    toolName.startsWith('delete_') ||
    toolName.startsWith('extract_') ||
    toolName.startsWith('parse_')
  ) {
    return 'tabdata'
  }
  return 'other'
}

function safeParseJSON(content: string): unknown | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// 消息分析：识别错误工具调用（仅 tool role）
function analyzeMessage(message: Message): { isError: boolean; isToolCall: boolean } {
  const content = message.content.toLowerCase()
  const isToolCall = message.role === 'tool' || content.includes('tool call')

  // 只对 tool 消息做错误检测，避免 system/assistant 文本误判
  let isError = false
  if (message.role === 'tool') {
    const parsed = safeParseJSON(message.content)
    if (isRecord(parsed)) {
      const payload = parsed
      const resultPayload = isRecord(payload.result) ? payload.result : null
      const outputPayload = isRecord(payload.output) ? payload.output : null
      const successFalse =
        payload.success === false ||
        resultPayload?.success === false ||
        outputPayload?.success === false
      const hasErrorField =
        (typeof payload.error === 'string' && payload.error.trim().length > 0) ||
        (typeof resultPayload?.error === 'string' && resultPayload.error.trim().length > 0)
      isError = successFalse || hasErrorField
    } else {
      isError =
        content.includes('"success": false') ||
        content.includes('"error":') ||
        content.includes('无权访问') ||
        content.includes('"failed"')
    }
  }
  return { isError, isToolCall }
}

// 消息角色图标和颜色
const roleConfig: Record<string, { icon: string; color: string; bg: string }> = {
  system: { icon: '🔧', color: 'text-info', bg: 'bg-info/10 border-info/30' },
  user: { icon: '👤', color: 'text-success', bg: 'bg-success/10 border-success/30' },
  assistant: { icon: '🤖', color: 'text-type-ai', bg: 'bg-type-ai/10 border-type-ai/30' },
  human: { icon: '👤', color: 'text-success', bg: 'bg-success/10 border-success/30' },
  ai: { icon: '🤖', color: 'text-type-ai', bg: 'bg-type-ai/10 border-type-ai/30' },
  tool: { icon: '🧰', color: 'text-warning', bg: 'bg-warning/10 border-warning/30' },
}

const fallbackRoleConfig = {
  icon: '💬',
  color: 'text-muted-foreground',
  bg: 'bg-muted/30 border-muted',
}

// 估算 tokens
function estimateTokens(text: string): number {
  // 简单估算：4 字符 ≈ 1 token
  return Math.ceil(text.length / 4)
}

// 消息组件
function MessageItem({ message, index }: { message: Message; index: number }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showSkeletonModal, setShowSkeletonModal] = useState(false)

  const config = roleConfig[message.role] ?? fallbackRoleConfig
  const tokens = estimateTokens(message.content)
  const isLong = message.content.length > 500

  // 检查是否包含 HTML skeleton
  const hasHTML = message.content.includes('<html>') || message.content.includes('Skeleton HTML:')
  const extractedHTML = hasHTML ? extractSkeletonHTML(message.content) : null

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 如果是错误消息，使用更醒目的样式
  const cardClassName = cn(
    'rounded-md border p-3',
    message.isError
      ? 'bg-destructive/10 border-destructive/30'
      : message.isToolCall && !message.isError
        ? 'bg-warning/10 border-warning/30'
        : config.bg
  )

  return (
    <>
      <div className={cardClassName}>
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-title">{config.icon}</span>
            <span className={cn('font-semibold text-body', config.color)}>{message.role}</span>
            <span className="text-body text-muted-foreground">
              ({tokens.toLocaleString()} tokens)
            </span>
            {message.isError && (
              <Badge variant="destructive" className="text-body h-5">
                Error
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {hasHTML && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSkeletonModal(true)}
                className="h-7 text-body"
              >
                <Brain className="mr-1 h-3 w-3" />
                查看 HTML
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={handleCopy} className="h-7 w-7">
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
        </div>

        <div className="text-body whitespace-pre-wrap break-words">
          {isLong && !isExpanded ? (
            <>
              {message.content.substring(0, 500)}...
              <Button
                variant="link"
                size="sm"
                onClick={() => setIsExpanded(true)}
                className="ml-2 h-auto p-0 text-body"
              >
                <Eye className="mr-1 h-3 w-3" />
                查看完整内容
              </Button>
            </>
          ) : (
            <>
              {message.content}
              {isLong && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setIsExpanded(false)}
                  className="ml-2 h-auto p-0 text-body"
                >
                  折叠
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Skeleton Viewer Modal */}
      {hasHTML && extractedHTML && showSkeletonModal && (
        <SkeletonViewerModal
          isOpen={showSkeletonModal}
          onClose={() => setShowSkeletonModal(false)}
          skeleton={{
            url: extractedHTML.url || 'Unknown',
            html: extractedHTML.html,
            title: `Message #${index + 1} HTML`,
          }}
        />
      )}
    </>
  )
}

// 从 message 中提取 skeleton HTML
function extractSkeletonHTML(content: string): { url: string | null; html: string } | null {
  // 尝试提取 URL
  const urlMatch = content.match(/URL:\s*(.+)/)
  const url = urlMatch ? urlMatch[1].trim() : null

  // 尝试提取 HTML（查找 <html> 到 </html> 或 </div> 最后一个）
  const htmlStartIndex = content.indexOf('<html>')
  if (htmlStartIndex === -1) return null

  // 找到最后一个 closing tag
  const possibleEnds = ['</html>', '</div>', '</footer>']
  let htmlEndIndex = -1
  for (const end of possibleEnds) {
    const lastIndex = content.lastIndexOf(end)
    if (lastIndex > htmlEndIndex) {
      htmlEndIndex = lastIndex + end.length
    }
  }

  if (htmlEndIndex === -1) return null

  const html = content.substring(htmlStartIndex, htmlEndIndex)
  return { url, html }
}

export function LLMEventViewer({ event }: LLMEventViewerProps) {
  const [showResponseModal, setShowResponseModal] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showFullHistory, setShowFullHistory] = useState(false) // 是否显示完整历史

  // 高级调试信息的折叠状态（默认折叠）
  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [showCombinedPrompt, setShowCombinedPrompt] = useState(false)

  const messages: Message[] = event.input?.messages || []
  const systemPrompt: string | undefined = event.input?.system_prompt
  const tools: Array<{ name?: string; description?: string; schema?: unknown }> =
    event.input?.tools || []
  const response = event.output?.content || ''
  const usage = event.usage || event.output?.usage
  const backendToolInjection = event.input?.tool_injection as ToolInjectionMetrics | undefined

  const toolSummary: ToolSummary = useMemo(() => {
    const names = tools.map((tool) => tool.name).filter((name): name is string => Boolean(name))
    const counter = new Map<string, number>()
    for (const name of names) {
      counter.set(name, (counter.get(name) || 0) + 1)
    }
    const duplicateNames = Array.from(counter.entries())
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort()
    const uniqueNames = Array.from(counter.keys())
    const domainCounts: Record<string, number> = {}
    for (const name of uniqueNames) {
      const domain = inferToolDomain(name)
      domainCounts[domain] = (domainCounts[domain] || 0) + 1
    }
    return {
      total: tools.length,
      unique: uniqueNames.length,
      duplicateCount: duplicateNames.length,
      duplicateNames,
      duplicateNameSet: new Set(duplicateNames),
      domainCounts,
    }
  }, [tools])

  const toolMetrics = useMemo(() => {
    const schemaToolsCount =
      readFiniteNumber(backendToolInjection?.schema_tools_count) ?? toolSummary.total
    const runtimeToolsCount =
      readFiniteNumber(backendToolInjection?.runtime_tools_count) ?? toolSummary.total
    const runtimeUniqueCount =
      readFiniteNumber(backendToolInjection?.runtime_tools_unique_count) ?? toolSummary.unique
    const runtimeDuplicateCount =
      readFiniteNumber(backendToolInjection?.runtime_tools_duplicate_count) ??
      Math.max(0, runtimeToolsCount - runtimeUniqueCount)
    const registryToolsCount = readFiniteNumber(backendToolInjection?.registry_tools_count)
    const runtimeDomains = Array.isArray(backendToolInjection?.runtime_domains)
      ? backendToolInjection.runtime_domains.filter(
          (domain): domain is string => typeof domain === 'string' && domain.trim().length > 0
        )
      : []
    const runtimeDomainCounts: Record<string, number> = {}
    for (const domain of runtimeDomains) {
      runtimeDomainCounts[domain] = (runtimeDomainCounts[domain] || 0) + 1
    }
    return {
      hasBackendMetrics: Boolean(backendToolInjection),
      schemaToolsCount,
      runtimeToolsCount,
      runtimeUniqueCount,
      runtimeDuplicateCount,
      registryToolsCount,
      runtimeDomainCounts,
    }
  }, [backendToolInjection, toolSummary])

  // 分析所有 messages，标记错误和工具调用
  const analyzedMessages = useMemo(() => {
    return messages.map((msg) => {
      const analysis = analyzeMessage(msg)
      return {
        ...msg,
        isError: analysis.isError,
        isToolCall: analysis.isToolCall,
      }
    })
  }, [messages])

  // 统计错误消息
  const errorMessageCount = useMemo(() => {
    return analyzedMessages.filter((msg) => msg.isError).length
  }, [analyzedMessages])

  // 智能过滤：默认只显示最后 N 条关键消息（排除中间的错误重试）
  const displayedMessages = useMemo(() => {
    if (showFullHistory) {
      return analyzedMessages
    }

    // 简洁模式：只显示最后一个完整的对话流程
    // 策略：从后往前找，找到最后一个 human 消息，然后显示该消息之后的所有内容
    let lastHumanIndex = -1
    for (let i = analyzedMessages.length - 1; i >= 0; i--) {
      if (analyzedMessages[i].role === 'human' || analyzedMessages[i].role === 'user') {
        lastHumanIndex = i
        break
      }
    }

    if (lastHumanIndex === -1) {
      // 没有 human 消息，显示最后 5 条
      return analyzedMessages.slice(-5)
    }

    // 显示最后一个 human 消息及其之后的所有消息
    const lastConversation = analyzedMessages.slice(lastHumanIndex)

    // 如果最后一个对话流程太长（超过 8 条），只显示最后 8 条
    if (lastConversation.length > 8) {
      return lastConversation.slice(-8)
    }

    return lastConversation
  }, [analyzedMessages, showFullHistory])

  // 被隐藏的消息数量
  const hiddenMessageCount = messages.length - displayedMessages.length
  const combinedPrompt = [
    tools.length
      ? `# Tools\n${tools
          .map((tool) => {
            const schema = tool.schema ? JSON.stringify(tool.schema, null, 2) : ''
            return `- ${tool.name || 'unknown_tool'}${tool.description ? `: ${tool.description}` : ''}${schema ? `\n${schema}` : ''}`
          })
          .join('\n')}`
      : '',
    messages.length
      ? `# Messages\n${messages.map((msg) => `- ${msg.role}: ${msg.content}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  const handleCopyResponse = () => {
    navigator.clipboard.writeText(response)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-3">
      {/* Usage 统计 - 紧凑横向布局 */}
      {usage && (
        <div className="rounded-md border bg-gradient-to-r from-info/5 to-type-ai/5 px-4 py-2.5">
          <div className="flex items-center justify-between flex-wrap gap-3 text-body">
            <div className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-primary" />
              <span className="font-semibold text-body">Usage</span>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span className="text-body text-muted-foreground">Prompt:</span>
                <span className="font-mono font-semibold text-body">
                  {usage.prompt_tokens?.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-body text-muted-foreground">Completion:</span>
                <span className="font-mono font-semibold text-body">
                  {usage.completion_tokens?.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-body text-muted-foreground">Total:</span>
                <span className="font-mono font-semibold text-body text-primary">
                  {usage.total_tokens?.toLocaleString()}t
                </span>
              </div>
              {usage.estimated_cost_usd !== undefined && (
                <div className="flex items-center gap-1.5">
                  <span className="text-body text-muted-foreground">Cost:</span>
                  <span className="font-mono font-semibold text-body text-success">
                    ${usage.estimated_cost_usd.toFixed(6)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 工具注入口径摘要（避免和全局注册数混淆） */}
      {tools.length > 0 && (
        <div className="rounded-md border bg-gradient-to-r from-success/5 to-info/5 px-4 py-2.5">
          <div className="flex items-center justify-between flex-wrap gap-3 text-body">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-body">Tool Injection</span>
              <Badge variant="outline" className="text-caption">
                {toolMetrics.hasBackendMetrics ? '后端实时口径' : '前端推断口径'}
              </Badge>
            </div>
            <div className="flex items-center gap-4 text-body">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Schema 注入:</span>
                <span className="font-mono font-semibold">{toolMetrics.schemaToolsCount}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">运行时原始:</span>
                <span className="font-mono font-semibold">{toolMetrics.runtimeToolsCount}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">运行时去重后:</span>
                <span className="font-mono font-semibold text-primary">
                  {toolMetrics.runtimeUniqueCount}
                </span>
              </div>
              {toolMetrics.runtimeDuplicateCount > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">重复工具名:</span>
                  <span className="font-mono font-semibold text-warning">
                    {toolMetrics.runtimeDuplicateCount}
                  </span>
                </div>
              )}
              {toolMetrics.registryToolsCount !== null && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">全局注册:</span>
                  <span className="font-mono font-semibold">{toolMetrics.registryToolsCount}</span>
                </div>
              )}
            </div>
          </div>

          {Object.keys(toolMetrics.runtimeDomainCounts).length > 0 && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className="text-caption text-muted-foreground">后端解析域:</span>
              {Object.entries(toolMetrics.runtimeDomainCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([domain, count]) => (
                  <Badge key={domain} variant="secondary" className="text-caption">
                    {domain}: {count}
                  </Badge>
                ))}
            </div>
          )}

          {Object.keys(toolSummary.domainCounts).length > 0 && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className="text-caption text-muted-foreground">
                {Object.keys(toolMetrics.runtimeDomainCounts).length > 0
                  ? '工具名推断分布:'
                  : '推断域分布:'}
              </span>
              {Object.entries(toolSummary.domainCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([domain, count]) => (
                  <Badge key={domain} variant="secondary" className="text-caption">
                    {domain}: {count}
                  </Badge>
                ))}
            </div>
          )}

          {toolSummary.duplicateCount > 0 && (
            <div className="mt-2 text-caption text-warning">
              重复工具名: {toolSummary.duplicateNames.join(', ')}
            </div>
          )}
          {toolMetrics.schemaToolsCount !== toolMetrics.runtimeToolsCount && (
            <p className="mt-2 text-caption text-warning">
              注意：Schema 注入数与运行时口径不一致（{toolMetrics.schemaToolsCount} vs{' '}
              {toolMetrics.runtimeToolsCount}）。
            </p>
          )}
          <p className="mt-2 text-caption text-muted-foreground">
            说明：运行时口径用于解释当前会话真实可用工具；全局注册是 ToolHub
            全量工具池，两者含义不同。
          </p>
        </div>
      )}

      {/* 高级调试信息（默认折叠） */}
      <div className="rounded-md border bg-muted/20">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-muted/30 transition-colors"
          onClick={() => setShowSystemPrompt(!showSystemPrompt)}
        >
          <div className="flex items-center gap-2">
            <span className="text-body font-semibold">🧩 System Prompt</span>
            {systemPrompt && (
              <Badge variant="outline" className="text-body">
                {Math.ceil(systemPrompt.length / 4)} tokens
              </Badge>
            )}
          </div>
          {showSystemPrompt ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        {showSystemPrompt && systemPrompt && (
          <div className="border-t px-4 py-3">
            <div className="flex justify-end mb-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigator.clipboard.writeText(systemPrompt)}
                className="h-7 text-body"
              >
                <Copy className="mr-1 h-3 w-3" />
                复制
              </Button>
            </div>
            <div className="rounded-md bg-muted/50 p-3 max-h-60 overflow-y-auto">
              <pre className="text-body font-mono whitespace-pre-wrap break-words">
                {systemPrompt}
              </pre>
            </div>
          </div>
        )}
      </div>

      {tools.length > 0 && (
        <div className="rounded-md border bg-muted/20">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-muted/30 transition-colors"
            onClick={() => setShowTools(!showTools)}
          >
            <div className="flex items-center gap-2">
              <span className="text-body font-semibold">🧰 Tools</span>
              <Badge variant="outline" className="text-body">
                Schema {toolMetrics.schemaToolsCount}
              </Badge>
              <Badge variant="secondary" className="text-body">
                运行时去重后 {toolMetrics.runtimeUniqueCount}
              </Badge>
              {toolMetrics.runtimeDuplicateCount > 0 ? (
                <Badge variant="destructive" className="text-body">
                  重复 {toolMetrics.runtimeDuplicateCount}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-body text-success border-success/30">
                  无重复
                </Badge>
              )}
              {toolMetrics.registryToolsCount !== null && (
                <Badge variant="outline" className="text-body">
                  全局注册 {toolMetrics.registryToolsCount}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-body text-muted-foreground">
                {toolMetrics.hasBackendMetrics
                  ? '会话运行口径（后端）'
                  : '会话运行口径（前端推断）'}
              </span>
              {showTools ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </button>
          {showTools && (
            <div className="border-t px-4 py-3 max-h-96 overflow-y-auto space-y-2">
              {tools.map((tool, index) => (
                <div
                  key={`${tool.name || 'tool'}-${index}`}
                  className="rounded-md border bg-background p-2.5"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-body font-semibold">
                      {tool.name || 'unknown_tool'}
                    </span>
                    {tool.name && toolSummary.duplicateNameSet.has(tool.name) && (
                      <Badge variant="destructive" className="text-caption h-5">
                        duplicate
                      </Badge>
                    )}
                    {tool.name && (
                      <Badge variant="outline" className="text-caption h-5">
                        {inferToolDomain(tool.name)}
                      </Badge>
                    )}
                  </div>
                  {tool.description && (
                    <div className="text-body text-muted-foreground mb-2">{tool.description}</div>
                  )}
                  {tool.schema !== undefined && tool.schema !== null && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-body text-muted-foreground hover:text-foreground">
                        查看 Schema
                      </summary>
                      <pre className="mt-2 text-caption font-mono whitespace-pre-wrap break-words text-muted-foreground bg-muted/30 p-2 rounded">
                        {JSON.stringify(tool.schema, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {combinedPrompt && (
        <div className="rounded-md border bg-muted/20">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-muted/30 transition-colors"
            onClick={() => setShowCombinedPrompt(!showCombinedPrompt)}
          >
            <div className="flex items-center gap-2">
              <span className="text-body font-semibold">🧾 LLM 实际输入</span>
              <Badge variant="outline" className="text-body">
                Tools + Messages
              </Badge>
            </div>
            {showCombinedPrompt ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {showCombinedPrompt && (
            <div className="border-t px-4 py-3">
              <div className="flex justify-end mb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(combinedPrompt)}
                  className="h-7 text-body"
                >
                  <Copy className="mr-1 h-3 w-3" />
                  复制
                </Button>
              </div>
              <div className="rounded-md bg-muted/50 p-3 max-h-96 overflow-y-auto">
                <pre className="text-body font-mono whitespace-pre-wrap break-words">
                  {combinedPrompt}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Messages 列表（核心内容，默认展开） */}
      {messages.length > 0 && (
        <div className="rounded-md border">
          <div className="flex items-center justify-between px-4 py-2.5 bg-primary/5 border-b">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-body">💬 Messages ({messages.length})</h4>
              {hiddenMessageCount > 0 && (
                <Badge variant="secondary" className="text-body">
                  隐藏了 {hiddenMessageCount} 条历史消息
                </Badge>
              )}
              {errorMessageCount > 0 && (
                <Badge variant="destructive" className="text-body">
                  {errorMessageCount} 个工具失败消息
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {hiddenMessageCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowFullHistory(!showFullHistory)}
                  className="h-7 text-body"
                >
                  {showFullHistory ? (
                    <>
                      <ChevronRight className="mr-1 h-3 w-3" />
                      简洁模式
                    </>
                  ) : (
                    <>
                      <ChevronDown className="mr-1 h-3 w-3" />
                      完整历史
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* 错误消息折叠提示 */}
          {!showFullHistory && errorMessageCount > 0 && (
            <div className="mx-4 mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-body text-warning">
                  <AlertCircle className="h-3 w-3" />
                  <span>检测到 {errorMessageCount} 个工具失败消息（权限问题、工具调用失败等）</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowFullHistory(true)}
                  className="h-6 text-body"
                >
                  查看完整历史
                </Button>
              </div>
            </div>
          )}

          <div className="px-4 pb-4 pt-3 space-y-2.5">
            {displayedMessages.map((message, index) => (
              <MessageItem
                key={`${message.role}-${message.content.slice(0, 32)}`}
                message={message}
                index={index}
              />
            ))}
          </div>
        </div>
      )}

      {/* Response（核心内容，默认展开） */}
      {response && (
        <div className="rounded-md border">
          <div className="flex items-center justify-between px-4 py-2.5 bg-success/10 border-b">
            <h4 className="font-semibold text-body">📤 Response</h4>
            <div className="flex items-center gap-2">
              {response.length > 200 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowResponseModal(true)}
                  className="h-7 text-body"
                >
                  <Eye className="mr-1 h-3 w-3" />
                  查看完整响应
                </Button>
              )}
              <Button variant="ghost" size="icon" onClick={handleCopyResponse} className="h-7 w-7">
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="rounded-md bg-muted/30 p-3">
              <pre className="text-body whitespace-pre-wrap break-words">
                {response.length > 200 ? `${response.substring(0, 200)}...` : response}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Response Modal */}
      {showResponseModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-8"
          onClick={() => setShowResponseModal(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setShowResponseModal(false)
            }
          }}
        >
          <div
            className="bg-background rounded-lg max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="font-semibold">LLM Response</h3>
              <Button variant="ghost" size="icon" onClick={handleCopyResponse} className="h-8 w-8">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <ScrollArea className="flex-1 p-4">
              <pre className="text-body font-mono whitespace-pre-wrap break-words">{response}</pre>
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  )
}
