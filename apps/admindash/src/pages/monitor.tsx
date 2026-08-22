import { type AgentHealthResponse, agentDebugApi } from '@/api/agent-debug'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  Server,
  Terminal,
  XCircle,
  Zap,
} from 'lucide-react'
import { useEffect, useState } from 'react'

function AgentHealthPanel() {
  const [health, setHealth] = useState<AgentHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    agentDebugApi
      .getHealthCheck()
      .then(setHealth)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="rounded border bg-background p-4">
        <div className="flex items-center gap-2 mb-3">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-body font-semibold">Agent 健康状态</span>
        </div>
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (!health) return null

  const agents = health.agents ?? {}
  const tools = health.tools ?? {}
  const middlewareCount = health.middleware_count
  const allOk =
    health.redis === 'ok' &&
    health.postgresql === 'ok' &&
    Object.values(agents).every((v) => v === 'ok')

  return (
    <div className="rounded border bg-background p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-body font-semibold">Agent 健康状态</span>
        </div>
        {allOk ? (
          <span className="flex items-center gap-1 text-body text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> 正常
          </span>
        ) : (
          <span className="flex items-center gap-1 text-body text-destructive">
            <XCircle className="h-3.5 w-3.5" /> 异常
          </span>
        )}
      </div>
      <div className="space-y-2 text-body">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Redis</span>
          <StatusBadge value={health.redis} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">PostgreSQL</span>
          <StatusBadge value={health.postgresql} />
        </div>
        {middlewareCount !== undefined && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Middleware</span>
            <span className="font-mono">{middlewareCount}</span>
          </div>
        )}
        {Object.keys(agents).length > 0 && (
          <div className="border-t pt-2 mt-2">
            <span className="text-muted-foreground font-medium">Agents</span>
            <div className="mt-1 space-y-1">
              {Object.entries(agents).map(([name, status]) => (
                <div key={name} className="flex items-center justify-between pl-2">
                  <span className="font-mono">{name}</span>
                  <StatusBadge value={status} />
                </div>
              ))}
            </div>
          </div>
        )}
        {Object.keys(tools).length > 0 && (
          <div className="border-t pt-2 mt-2">
            <span className="text-muted-foreground font-medium">
              Tools ({Object.keys(tools).length})
            </span>
            <div className="mt-1 space-y-1 max-h-32 overflow-auto">
              {Object.entries(tools).map(([name, info]) => {
                const status = typeof info === 'string' ? info : info.status
                return (
                  <div key={name} className="flex items-center justify-between pl-2">
                    <span className="font-mono truncate max-w-[200px]">{name}</span>
                    <StatusBadge value={status} />
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ value }: { value: string }) {
  if (value === 'ok') {
    return <span className="text-success font-medium">ok</span>
  }
  return <span className="text-destructive font-medium truncate max-w-[150px]">{value}</span>
}

export function MonitorPage() {
  return (
    <div className="panel-container">
      {/* 顶部标题 */}
      <div className="flex h-12 items-center justify-between border-b px-4 bg-background">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="font-semibold">System Monitor</h1>
        </div>
        <div className="flex items-center gap-2 text-body">
          <span className="flex items-center gap-1.5 px-2 py-1 rounded bg-success/10 text-success">
            <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
            System Healthy
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 bg-muted/5">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-4">
          {/* 紧凑型指标面板 */}
          <div className="rounded border bg-background p-4 flex flex-col justify-between h-32">
            <div className="flex items-center justify-between">
              <span className="text-body font-medium text-muted-foreground">CPU Usage</span>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <div className="text-display font-bold">45%</div>
              <div className="mt-2 h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-info w-[45%]" />
              </div>
            </div>
          </div>

          <div className="rounded border bg-background p-4 flex flex-col justify-between h-32">
            <div className="flex items-center justify-between">
              <span className="text-body font-medium text-muted-foreground">Memory</span>
              <Server className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <div className="text-display font-bold">2.4 GB</div>
              <p className="text-body text-muted-foreground mt-1">Total: 8 GB</p>
            </div>
          </div>

          <div className="rounded border bg-background p-4 flex flex-col justify-between h-32">
            <div className="flex items-center justify-between">
              <span className="text-body font-medium text-muted-foreground">Response Time</span>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <div className="text-display font-bold">124ms</div>
              <p className="text-body text-muted-foreground mt-1">Avg. last hour</p>
            </div>
          </div>

          <div className="rounded border bg-background p-4 flex flex-col justify-between h-32">
            <div className="flex items-center justify-between">
              <span className="text-body font-medium text-muted-foreground">
                Active Connections
              </span>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <div className="text-display font-bold">23</div>
              <p className="text-body text-muted-foreground mt-1">Current users</p>
            </div>
          </div>
        </div>

        {/* Agent 健康状态 */}
        <div className="mb-4">
          <AgentHealthPanel />
        </div>

        {/* 终端风格日志面板 */}
        <div className="flex flex-col rounded border bg-[#1e1e1e] text-muted-foreground/60 h-[calc(100vh-240px)] font-mono text-body shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-4 py-2 bg-[#2d2d2d]">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4" />
              <span className="font-semibold">System Logs</span>
            </div>
            <div className="flex gap-2 text-body">
              <span className="cursor-pointer hover:text-white">Clear</span>
              <span className="cursor-pointer hover:text-white">Filter</span>
            </div>
          </div>
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-1">
              <div className="flex gap-3">
                <span className="text-muted-foreground w-36">2024-12-24 10:30:00</span>
                <span className="text-success font-bold w-12">[INFO]</span>
                <span>Agent execution completed successfully: exec-001</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground w-36">2024-12-24 10:25:00</span>
                <span className="text-info font-bold w-12">[DEBUG]</span>
                <span>Browser instance launched: Chrome 120 (Headless)</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground w-36">2024-12-24 10:20:00</span>
                <span className="text-warning font-bold w-12">[WARN]</span>
                <span>Anti-bot detection triggered, switching proxy...</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground w-36">2024-12-24 10:15:00</span>
                <span className="text-success font-bold w-12">[INFO]</span>
                <span>User admin logged in from 192.168.1.10</span>
              </div>
              <div className="flex gap-3">
                <span className="text-muted-foreground w-36">2024-12-24 10:10:00</span>
                <span className="text-info font-bold w-12">[DEBUG]</span>
                <span>WebSocket connection established</span>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}
