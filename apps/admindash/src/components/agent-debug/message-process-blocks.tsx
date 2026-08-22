import { Brain, ChevronDown, Wrench } from 'lucide-react'
import {
  buildMessageProcessView,
  formatThinkingDuration,
} from './conversation-process-utils'

function formatJson(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

interface MessageProcessBlocksProps {
  contentBlocks: unknown[] | null | undefined
  className?: string
}

/** AdminDash 运行诊断：思考过程 + 工具执行步骤（轻量折叠，不对齐 Electron 全套 BlockTimeline）。 */
export function MessageProcessBlocks({ contentBlocks, className }: MessageProcessBlocksProps) {
  const process = buildMessageProcessView(contentBlocks)
  if (process.thinkingSteps.length === 0 && process.toolSteps.length === 0) {
    return null
  }

  return (
    <div className={className ?? 'space-y-2'}>
      {process.thinkingSteps.map((step, index) => {
        const duration = formatThinkingDuration(step.durationMs)
        const title =
          step.kind === 'redacted_thinking'
            ? '思考过程（已加密）'
            : duration
              ? `已思考 ${duration}`
              : '思考过程'

        return (
          <details
            key={`thinking-${index}`}
            className="group rounded-md border border-border/80 bg-muted/40"
            open={process.thinkingSteps.length === 1 && process.toolSteps.length === 0}
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-caption font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t px-3 py-2">
              <p className="whitespace-pre-wrap break-words text-body text-muted-foreground">
                {step.text}
              </p>
            </div>
          </details>
        )
      })}

      {process.toolSteps.length > 0 && (
        <details
          className="group rounded-md border border-border/80 bg-muted/40"
          open={process.toolSteps.length <= 3}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-caption font-medium text-foreground [&::-webkit-details-marker]:hidden">
            <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              执行过程 · {process.toolSteps.length} 步
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <ol className="space-y-2 border-t px-3 py-2">
            {process.toolSteps.map((step, index) => (
              <li key={`${step.id}-${index}`} className="rounded border bg-background/80 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-caption">
                  <span className="font-medium text-foreground">
                    {index + 1}. {step.name}
                  </span>
                  {step.isError && (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                      失败
                    </span>
                  )}
                </div>
                {formatJson(step.input) && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 text-caption text-muted-foreground">
                    {formatJson(step.input)}
                  </pre>
                )}
                {step.result != null && step.result !== '' && (
                  <pre
                    className={`mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded p-2 text-caption ${
                      step.isError
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-muted/60 text-muted-foreground'
                    }`}
                  >
                    {step.result}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

export function resolveDisplayText(
  content: string | null | undefined,
  contentBlocks: unknown[] | null | undefined
): string {
  const process = buildMessageProcessView(contentBlocks)
  if (process.textFromBlocks) return process.textFromBlocks
  const text = (content || '').trim()
  if (!text || text === '[工具调用]' || text === '[思考中]') return ''
  return text
}
