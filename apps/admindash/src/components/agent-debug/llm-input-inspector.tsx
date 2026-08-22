import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Event } from '@/types/agent-debug'
import { Check, ChevronDown, ChevronRight, Copy, MessageSquare, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'

type RecordValue = Record<string, unknown>

interface LlmInputInspectorProps {
  events: Event[]
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(record: RecordValue, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function readNumber(record: RecordValue, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function isLlmRequest(event: Event): boolean {
  const key = `${event.event_type} ${event.name}`.toLowerCase()
  return key.includes('llm_request') || event.event_type === 'llm'
}

function isPromptSnapshot(event: Event): boolean {
  return event.event_type === 'prompt_snapshot'
}

function normalizeContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return JSON.stringify(value, null, 2)
}

function getMessages(input: RecordValue, output: RecordValue | null): RecordValue[] {
  const candidate = Array.isArray(input.messages)
    ? input.messages
    : output && Array.isArray(output.messages)
      ? output.messages
      : []
  return candidate.filter(isRecord)
}

function getTools(input: RecordValue, output: RecordValue | null): RecordValue[] {
  const candidate = Array.isArray(input.tools)
    ? input.tools
    : output && Array.isArray(output.tools_schema)
      ? output.tools_schema
      : []
  return candidate.filter(isRecord)
}

function getSystemSections(input: RecordValue): RecordValue[] {
  const system = input.system
  if (!isRecord(system) || !Array.isArray(system.sections)) return []
  return system.sections.filter(isRecord)
}

function countChars(messages: RecordValue[], sections: RecordValue[]): number {
  return [...sections, ...messages].reduce((total, item) => {
    const explicit = readNumber(item, 'charCount', 'char_count')
    const content = readString(item, 'contentPreview', 'content_preview', 'content')
    return total + (explicit ?? content?.length ?? 0)
  }, 0)
}

function CollapsibleSection({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string
  badge?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="overflow-hidden rounded-lg border bg-background">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium">{title}</span>
        </span>
        {badge}
      </button>
      {open && <div className="border-t">{children}</div>}
    </section>
  )
}

export function LlmInputInspector({ events }: LlmInputInspectorProps) {
  const calls = useMemo(
    () =>
      events
        .filter((event) => isLlmRequest(event) || isPromptSnapshot(event))
        .sort((left, right) => left.seq - right.seq),
    [events]
  )
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, calls.length - 1))
  const [copied, setCopied] = useState(false)

  const safeIndex = Math.min(selectedIndex, Math.max(0, calls.length - 1))
  const event = calls[safeIndex]

  if (!event) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-body text-muted-foreground">
        本次执行没有记录 LLM 调用入参。较早的执行可能未开启快照记录。
      </div>
    )
  }

  const input = event.input ?? {}
  const output = event.output
  const messages = getMessages(input, output)
  const tools = getTools(input, output)
  const systemSections = getSystemSections(input)
  const model = readString(input, 'model') ?? '未记录'
  const iteration = readNumber(input, 'iteration') ?? safeIndex
  const messageCount = readNumber(input, 'messageCount', 'messages_count') ?? messages.length
  const toolCount = readNumber(input, 'toolCount', 'tools_count') ?? tools.length
  const totalChars =
    readNumber(input, 'totalChars', 'total_chars') ?? countChars(messages, systemSections)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(input, null, 2))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="h-full overflow-auto bg-muted/10 p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-subtitle font-semibold">LLM 调用入参</h2>
            <p className="mt-1 text-body text-muted-foreground">
              展示模型实际收到的系统提示、消息上下文、工具定义和生成参数。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {calls.length > 1 && (
              <select
                aria-label="选择 LLM 调用"
                className="h-9 rounded-md border bg-background px-3 text-body"
                value={safeIndex}
                onChange={(event) => setSelectedIndex(Number(event.target.value))}
              >
                {calls.map((call, index) => (
                  <option key={call.id} value={index}>
                    第 {index + 1} 次调用 · 迭代{' '}
                    {readNumber(call.input ?? {}, 'iteration') ?? index}
                  </option>
                ))}
              </select>
            )}
            <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
              {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
              {copied ? '已复制' : '复制原始入参'}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="模型" value={model} />
          <Metric label="迭代" value={`第 ${iteration + 1} 次`} />
          <Metric label="消息上下文" value={`${messageCount} 条`} />
          <Metric label="可用工具" value={`${toolCount} 个`} />
        </div>

        <p className="rounded-md border border-info/20 bg-info/5 px-4 py-3 text-body text-muted-foreground">
          这里的内容不只包含用户输入，还包含 Agent 规则、运行环境、历史消息和工具
          Schema，因此即使用户只问“1+1”，实际入参也可能很长。本次记录约{' '}
          {totalChars.toLocaleString()} 个字符。
        </p>

        <CollapsibleSection
          title="系统提示"
          badge={
            <Badge variant="secondary">{systemSections.length || (input.system ? 1 : 0)} 段</Badge>
          }
          defaultOpen
        >
          {systemSections.length > 0 ? (
            <div className="divide-y">
              {systemSections.map((section, index) => (
                <article
                  key={`${readString(section, 'name') ?? 'section'}-${index}`}
                  className="p-4"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="font-medium">
                      {readString(section, 'name') ?? `段落 ${index + 1}`}
                    </span>
                    <span className="text-caption text-muted-foreground">
                      {(readNumber(section, 'charCount', 'char_count') ?? 0).toLocaleString()} 字符
                    </span>
                  </div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-body">
                    {readString(section, 'contentPreview', 'content_preview', 'content') ??
                      '该段只记录了统计信息'}
                  </pre>
                </article>
              ))}
            </div>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-4 text-body">
              {normalizeContent(input.system_prompt ?? input.system) || '未记录完整系统提示'}
            </pre>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="消息上下文"
          badge={
            <Badge variant="secondary">
              <MessageSquare className="mr-1 h-3 w-3" />
              {messageCount} 条
            </Badge>
          }
        >
          {messages.length > 0 ? (
            <div className="divide-y">
              {messages.map((message, index) => (
                <article
                  key={`${readString(message, 'role') ?? 'message'}-${index}`}
                  className="p-4"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Badge variant="outline">{readString(message, 'role') ?? 'unknown'}</Badge>
                    <span className="text-caption text-muted-foreground">
                      {(readNumber(message, 'charCount', 'char_count') ?? 0).toLocaleString()} 字符
                    </span>
                  </div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-body">
                    {readString(message, 'contentPreview', 'content_preview', 'content') ??
                      normalizeContent(message)}
                  </pre>
                </article>
              ))}
            </div>
          ) : (
            <p className="p-4 text-body text-muted-foreground">
              当前仅记录了消息数量，未保留完整内容。
            </p>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="工具定义"
          badge={
            <Badge variant="secondary">
              <Wrench className="mr-1 h-3 w-3" />
              {toolCount} 个
            </Badge>
          }
        >
          {tools.length > 0 ? (
            <div className="divide-y">
              {tools.map((tool, index) => (
                <article key={`${readString(tool, 'name') ?? 'tool'}-${index}`} className="p-4">
                  <p className="font-mono text-body font-medium">
                    {readString(tool, 'name') ?? `工具 ${index + 1}`}
                  </p>
                  {readString(tool, 'description') && (
                    <p className="mt-1 text-body text-muted-foreground">
                      {readString(tool, 'description')}
                    </p>
                  )}
                  <details className="mt-3">
                    <summary className="cursor-pointer text-body text-muted-foreground">
                      查看参数 Schema
                    </summary>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-caption">
                      {JSON.stringify(tool.schema ?? tool.parameters ?? tool, null, 2)}
                    </pre>
                  </details>
                </article>
              ))}
            </div>
          ) : (
            <p className="p-4 text-body text-muted-foreground">
              当前仅记录了工具数量，未保留完整 Schema。
            </p>
          )}
        </CollapsibleSection>

        <CollapsibleSection title="生成参数">
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-4 text-body">
            {JSON.stringify(
              {
                model: input.model,
                maxTokens: input.maxTokens ?? input.max_tokens,
                temperature: input.temperature,
                requestSource: input.requestSource ?? input.request_source,
                iteration: input.iteration,
              },
              null,
              2
            )}
          </pre>
        </CollapsibleSection>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background p-3">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-body font-semibold" title={value}>
        {value}
      </p>
    </div>
  )
}
