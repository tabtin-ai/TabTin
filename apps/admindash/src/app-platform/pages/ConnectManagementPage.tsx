import { AdminPage, AdminPageHeader } from '@/components/admin-page'
import { AlertCircle, ExternalLink, Link2, ShieldAlert } from 'lucide-react'

const capabilityGaps = [
  ['后端 API', '列表 / 详情 / 撤销 / 批量撤销未恢复'],
  ['数据模型', 'Connect 管理表与状态口径待确认'],
  ['权限', '专用权限点未落地'],
  ['审计', '撤销与授权变更审计未接入'],
  ['脱敏', 'token / secret 展示策略待定义'],
  ['过滤', 'Organization / 用户 / App 过滤能力待定义'],
]

const missingAssets = [
  ['当前状态', '未恢复'],
  ['可查看连接', '否'],
  ['可撤销连接', '否'],
  ['可批量撤销', '否'],
]

const followUpTasks = [
  ['恢复后端 API', '按  补齐 Connect 列表、详情和撤销接口'],
  ['补权限与审计', '定义 Connect 专用权限点和审计事件'],
  ['再开放操作', 'API / 权限 / 审计齐备前不提供 revoke 操作'],
]

export function ConnectManagementPage() {
  return (
    <AdminPage>
      <AdminPageHeader title="Connect" icon={Link2} />

      <div className="grid gap-3 md:grid-cols-4">
        {missingAssets.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-background px-4 py-3">
            <div className="text-caption text-muted-foreground">{label}</div>
            <div className="mt-1 text-title font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <section className="rounded-lg border bg-background">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-body font-semibold">能力状态</h2>
            <p className="text-caption text-muted-foreground">不调用残留 Connect API</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-caption text-amber-800">
            <AlertCircle className="h-3.5 w-3.5" />
            未恢复
          </span>
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-2">
          {capabilityGaps.map(([label, detail]) => (
            <div key={label} className="rounded-lg border p-3">
              <div className="font-medium">{label}</div>
              <div className="mt-1 text-caption text-muted-foreground">{detail}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border bg-background">
        <div className="border-b px-4 py-3">
          <h2 className="text-body font-semibold">后续任务</h2>
        </div>
        <div className="divide-y">
          {followUpTasks.map(([title, detail]) => (
            <div key={title} className="flex items-start gap-3 px-4 py-3 text-body">
              <ShieldAlert className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div>
                <div className="font-medium">{title}</div>
                <div className="text-caption text-muted-foreground">{detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border bg-background p-4">
        <h2 className="text-body font-semibold">相关入口</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href="https://github.com/larchiveai/TabTin/issues/2032"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <ExternalLink className="h-4 w-4" />

          </a>
          <a
            href="/app-installs"
            className="inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <Link2 className="h-4 w-4" />
            App 安装
          </a>
          <a
            href="/cli-audit"
            className="inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <Link2 className="h-4 w-4" />
            CLI 审计
          </a>
        </div>
      </section>

      <section className="rounded-lg border border-dashed bg-background p-4 text-body text-muted-foreground">
        不可用能力：连接列表、连接详情、撤销、批量撤销、Connect 审计。API / 权限 /
        审计恢复前不提供真实 Connect 操作。
      </section>
    </AdminPage>
  )
}
