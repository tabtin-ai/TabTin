import { AdminPage } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  FileCode,
  Link2,
  Loader2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Tag,
  Wrench,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getToolDetail, runAuditTools, toggleToolStatus } from '../api/tool-management'
import type { AuditToolResult, ToolDetail } from '../types'

const RISK_STYLES: Record<string, { label: string; color: string; icon: typeof Shield }> = {
  safe: {
    label: '安全 (safe)',
    color: 'text-success bg-success/10 border-success/30',
    icon: ShieldCheck,
  },
  review: {
    label: '需审核 (review)',
    color: 'text-warning bg-warning/10 border-warning/30',
    icon: Shield,
  },
  strict: {
    label: '严格 (strict)',
    color: 'text-destructive bg-destructive/10 border-destructive/30',
    icon: ShieldAlert,
  },
}

export function ToolDetailPage() {
  const { toolName } = useParams<{ toolName: string }>()
  const navigate = useNavigate()
  const [tool, setTool] = useState<ToolDetail | null>(null)
  const [audit, setAudit] = useState<AuditToolResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [auditLoading, setAuditLoading] = useState(false)
  const [schemaExpanded, setSchemaExpanded] = useState(false)
  const [returnSchemaExpanded, setReturnSchemaExpanded] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<'active' | 'disabled' | null>(null)
  const [sensitiveReason, setSensitiveReason] = useState('')
  const [sensitiveTicketId, setSensitiveTicketId] = useState('')
  const [sensitiveSubmitting, setSensitiveSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const decodedName = toolName ? decodeURIComponent(toolName) : ''

  const fetchTool = useCallback(async () => {
    if (!decodedName) return
    setLoading(true)
    try {
      const detail = await getToolDetail(decodedName)
      setTool(detail)
    } catch (err) {
      console.error('Failed to fetch tool detail:', err)
    } finally {
      setLoading(false)
    }
  }, [decodedName])

  const fetchAudit = useCallback(async () => {
    if (!decodedName) return
    setAuditLoading(true)
    try {
      const resp = await runAuditTools({ tool: decodedName })
      const t = resp.tools.find((r) => r.name === decodedName)
      if (t) setAudit(t)
    } catch (err) {
      console.error('Audit failed:', err)
    } finally {
      setAuditLoading(false)
    }
  }, [decodedName])

  useEffect(() => {
    fetchTool()
    fetchAudit()
  }, [fetchTool, fetchAudit])

  const handleToggle = async () => {
    if (!tool) return
    const newStatus = tool.status === 'active' ? 'disabled' : 'active'
    setPendingStatus(newStatus)
    setSensitiveReason('')
    setSensitiveTicketId('')
    setErrorMessage('')
  }

  const executeToggle = async () => {
    if (!tool || !pendingStatus) return
    const reason = sensitiveReason.trim()
    if (!reason) {
      setErrorMessage('reason 必填')
      return
    }
    setSensitiveSubmitting(true)
    try {
      await toggleToolStatus(tool.name, pendingStatus, {
        reason,
        ticket_id: sensitiveTicketId.trim() || undefined,
      })
      setPendingStatus(null)
      await fetchTool()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '状态切换失败')
    } finally {
      setSensitiveSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!tool) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p>工具 "{decodedName}" 不存在</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/tools')}>
          返回列表
        </Button>
      </div>
    )
  }

  const risk = RISK_STYLES[tool.risk_level] || RISK_STYLES.review
  const RiskIcon = risk.icon

  return (
    <AdminPage>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button
            type="button"
            className="mb-2 flex items-center gap-1 text-body text-muted-foreground hover:text-foreground"
            onClick={() => navigate('/tools')}
          >
            <ArrowLeft className="h-4 w-4" />
            返回列表
          </button>
          <h1 className="text-heading font-bold tracking-tight font-mono">{tool.name}</h1>
          {tool.display_name && tool.display_name !== tool.name && (
            <p className="text-muted-foreground">{tool.display_name}</p>
          )}
          <p className="mt-2 text-body text-muted-foreground max-w-2xl">{tool.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={tool.status === 'active' ? 'destructive' : 'default'}
            size="sm"
            onClick={handleToggle}
          >
            {tool.status === 'active' ? '禁用' : '启用'}
          </Button>
        </div>
      </div>

      {errorMessage ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
          {errorMessage}
        </div>
      ) : null}
      {pendingStatus ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-md border bg-background p-4 shadow-lg">
            <div className="text-subtitle font-semibold">敏感工具治理操作</div>
            <div className="mt-2 text-body text-muted-foreground">
              Tool 启停会影响 Agent/Tool runtime 可用性。请填写 reason，ticket 可选。
            </div>
            <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-body">
              {pendingStatus === 'active' ? '启用' : '禁用'} Tool：{tool.name}
            </div>
            <Input
              className="mt-3"
              placeholder="reason（必填）"
              value={sensitiveReason}
              onChange={(event) => setSensitiveReason(event.target.value)}
              disabled={sensitiveSubmitting}
            />
            <Input
              className="mt-3"
              placeholder="ticket_id（可选）"
              value={sensitiveTicketId}
              onChange={(event) => setSensitiveTicketId(event.target.value)}
              disabled={sensitiveSubmitting}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setPendingStatus(null)}
                disabled={sensitiveSubmitting}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={executeToggle}
                disabled={sensitiveSubmitting || !sensitiveReason.trim()}
              >
                {sensitiveSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                确认执行
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Meta Grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <MetaCard label="域" value={tool.domain} icon={Wrench} />
        <MetaCard label="来源" value={tool.source} icon={FileCode} />
        <MetaCard label="接口类型" value={tool.interface_type} icon={Code2} />
        <MetaCard label="执行位置" value={tool.execution_target} icon={ExternalLink} />
        <MetaCard label="分类" value={tool.category} icon={Tag} />
        <div className={`rounded-lg border p-3 ${risk.color}`}>
          <div className="flex items-center gap-1 text-body opacity-70">
            <RiskIcon className="h-3 w-3" />
            风险等级
          </div>
          <div className="mt-1 text-body font-semibold">{risk.label}</div>
        </div>
      </div>

      {/* Skills */}
      <Section title="关联 Skill" icon={Link2}>
        {tool.linked_skills.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {tool.linked_skills.map((s) => (
              <Badge key={s.skill_key} variant="secondary" className="text-body">
                {s.skill_key}
                <span className="ml-1 opacity-60">({s.relation_type})</span>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-body text-muted-foreground">无关联 Skill</p>
        )}
      </Section>

      {/* Parameters Schema */}
      <Section title="参数 Schema" icon={Code2}>
        {Object.keys(tool.parameters_schema).length > 0 ? (
          <CollapsibleJson
            data={tool.parameters_schema}
            expanded={schemaExpanded}
            onToggle={() => setSchemaExpanded(!schemaExpanded)}
          />
        ) : (
          <p className="text-body text-muted-foreground">无参数 Schema</p>
        )}
      </Section>

      {/* Return Schema */}
      <Section title="返回值 Schema" icon={Code2}>
        {Object.keys(tool.return_schema).length > 0 ? (
          <CollapsibleJson
            data={tool.return_schema}
            expanded={returnSchemaExpanded}
            onToggle={() => setReturnSchemaExpanded(!returnSchemaExpanded)}
          />
        ) : (
          <p className="text-body text-muted-foreground">无返回值 Schema</p>
        )}
      </Section>

      {/* Permissions */}
      {tool.permissions.length > 0 && (
        <Section title="所需权限" icon={Shield}>
          <div className="flex flex-wrap gap-2">
            {tool.permissions.map((p) => (
              <Badge key={p} variant="outline" className="text-body">
                {p}
              </Badge>
            ))}
          </div>
        </Section>
      )}

      {/* Documentation */}
      {tool.documentation && (
        <Section title="文档" icon={BookOpen}>
          <div className="prose prose-sm max-w-none whitespace-pre-wrap rounded bg-muted/30 p-4 text-body">
            {tool.documentation}
          </div>
        </Section>
      )}

      {/* Tags */}
      {tool.tags.length > 0 && (
        <Section title="标签" icon={Tag}>
          <div className="flex flex-wrap gap-2">
            {tool.tags.map((t) => (
              <Badge key={t} variant="secondary" className="text-body">
                {t}
              </Badge>
            ))}
          </div>
        </Section>
      )}

      {/* Audit Results */}
      <Section title="审计检查" icon={Check}>
        {auditLoading ? (
          <div className="flex items-center gap-2 text-body text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在运行审计...
          </div>
        ) : audit ? (
          <div className="space-y-3">
            <div className="flex items-center gap-4 text-body">
              <span className="text-success">✓ 通过: {audit.pass_count}</span>
              {audit.fail_count > 0 && (
                <span className="text-destructive">✗ 失败: {audit.fail_count}</span>
              )}
              {audit.warn_count > 0 && (
                <span className="text-warning">⚠ 警告: {audit.warn_count}</span>
              )}
            </div>
            <div className="space-y-1">
              {audit.checks.map((c) => (
                <div
                  key={`${c.status}-${c.message}`}
                  className={`flex items-start gap-2 rounded px-3 py-1.5 text-body ${
                    c.status === '✓'
                      ? 'bg-success/10 text-success'
                      : c.status === '✗'
                        ? 'bg-destructive/10 text-destructive'
                        : c.status === '⚠'
                          ? 'bg-warning/10 text-warning'
                          : 'bg-muted text-muted-foreground'
                  }`}
                >
                  <span className="font-mono w-4 flex-shrink-0">{c.status}</span>
                  <span>{c.message}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-body text-muted-foreground">审计数据不可用</p>
        )}
      </Section>

      {/* Meta Info */}
      <div className="grid grid-cols-2 gap-4 text-body text-muted-foreground border-t pt-4">
        <div>版本: {tool.version || '—'}</div>
        <div>来源引用: {tool.source_ref || '—'}</div>
        <div>创建: {tool.created_at ? new Date(tool.created_at).toLocaleString('zh-CN') : '—'}</div>
        <div>更新: {tool.updated_at ? new Date(tool.updated_at).toLocaleString('zh-CN') : '—'}</div>
      </div>
    </AdminPage>
  )
}

function MetaCard({
  label,
  value,
  icon: Icon,
}: {
  label: string
  value: string
  icon: typeof Wrench
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1 text-body text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1 text-body font-medium truncate">{value || '—'}</div>
    </div>
  )
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof Wrench
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-3 flex items-center gap-2 text-body font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </div>
  )
}

function CollapsibleJson({
  data,
  expanded,
  onToggle,
}: {
  data: Record<string, unknown>
  expanded: boolean
  onToggle: () => void
}) {
  const json = JSON.stringify(data, null, 2)
  const lines = json.split('\n')
  const preview = lines.slice(0, 8).join('\n')

  return (
    <div>
      <pre className="overflow-x-auto rounded bg-muted/40 p-3 text-body font-mono leading-relaxed">
        {expanded ? json : preview}
        {!expanded && lines.length > 8 && '\n...'}
      </pre>
      {lines.length > 8 && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-1 text-body text-primary hover:underline flex items-center gap-1"
        >
          {expanded ? (
            <>
              <ChevronDown className="h-3 w-3" /> 收起
            </>
          ) : (
            <>
              <ChevronRight className="h-3 w-3" /> 展开全部 ({lines.length} 行)
            </>
          )}
        </button>
      )}
    </div>
  )
}
