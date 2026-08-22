import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ToolEvent } from '@/types/agent-debug'
import { CheckCircle2, Code, Wrench, XCircle } from 'lucide-react'

/**
 * Tool Event 专用查看器
 * 显示工具名称、参数、执行结果等信息
 */
export function ToolEventViewer({ event }: { event: ToolEvent }) {
  const { input, output, name } = event
  const success = output?.success ?? true
  const parameters = input?.args || {}

  return (
    <div className="space-y-6">
      {/* 工具信息 */}
      <div>
        <h4 className="font-semibold mb-3 flex items-center gap-2">
          <Wrench className="h-4 w-4" />
          Tool: <span className="font-mono text-primary">{name}</span>
        </h4>
        <div className="flex items-center gap-2">
          {success ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-success" />
              <Badge variant="success">Success</Badge>
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4 text-destructive" />
              <Badge variant="destructive">Failed</Badge>
            </>
          )}
        </div>
      </div>

      {/* Parameters (Input) */}
      <div>
        <h4 className="font-semibold mb-2 flex items-center gap-2">
          <Code className="h-4 w-4" />
          Parameters
        </h4>
        {parameters && Object.keys(parameters).length > 0 ? (
          <div className="rounded-md border bg-muted/30">
            <ScrollArea className="max-h-[300px]">
              <pre className="p-4 text-body font-mono">{JSON.stringify(parameters, null, 2)}</pre>
            </ScrollArea>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/30 p-4 text-body text-muted-foreground">
            No parameters
          </div>
        )}
      </div>

      {/* Result (Output) */}
      <div>
        <h4 className="font-semibold mb-2 flex items-center gap-2">
          {success ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : (
            <XCircle className="h-4 w-4 text-destructive" />
          )}
          Result
        </h4>
        {output?.result !== undefined ? (
          <div className="rounded-md border bg-muted/30">
            <ScrollArea className="max-h-[400px]">
              <pre className="p-4 text-body font-mono">
                {typeof output.result === 'string'
                  ? output.result
                  : JSON.stringify(output.result, null, 2)}
              </pre>
            </ScrollArea>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/30 p-4 text-body text-muted-foreground">
            No result
          </div>
        )}
      </div>

      {/* 原始 Input/Output（折叠） */}
      <details className="group">
        <summary className="cursor-pointer font-semibold text-body text-muted-foreground hover:text-foreground">
          Raw Input/Output (Click to expand)
        </summary>
        <div className="mt-2 space-y-2">
          <div className="rounded-md border bg-muted/30">
            <div className="border-b px-3 py-1 text-body font-semibold">Input</div>
            <pre className="p-4 text-body font-mono">{JSON.stringify(input, null, 2)}</pre>
          </div>
          <div className="rounded-md border bg-muted/30">
            <div className="border-b px-3 py-1 text-body font-semibold">Output</div>
            <pre className="p-4 text-body font-mono">{JSON.stringify(output, null, 2)}</pre>
          </div>
        </div>
      </details>
    </div>
  )
}
