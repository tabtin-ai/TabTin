/**
 * Blank 模板 — 干净的起点
 *
 * 如需接入 TabData 数据，运行：
 *   tabtin site provision-token <site-id>
 * 然后在此文件中使用 @tabtin/sdk
 */
export default function App() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg text-center">
        {/* Logo */}
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-200">
          <span className="text-heading font-bold text-white">T</span>
        </div>

        <h1 className="mt-6 text-display font-bold tracking-tight text-foreground">
          Hello, TabSite
        </h1>
        <p className="mt-2 text-subtitle text-muted-foreground">
          编辑 <code className="rounded bg-muted px-1.5 py-0.5 text-body font-mono text-primary">src/App.tsx</code> 开始构建你的应用
        </p>

        {/* Quick start guide */}
        <div className="mt-8 rounded-xl border border-border bg-card p-6 text-left shadow-sm">
          <h2 className="text-body font-semibold text-foreground">快速开始</h2>
          <div className="mt-4 space-y-4">
            <Step n={1} title="开发">
              <code>npm run dev</code> 启动本地预览
            </Step>
            <Step n={2} title="接入数据">
              使用 <code>@tabtin/sdk</code> 查询 TabData
            </Step>
            <Step n={3} title="发布">
              <code>tabtin site build {'<site-id>'}</code> 一键发布到线上
            </Step>
          </div>
        </div>

        {/* SDK snippet */}
        <div className="mt-6 rounded-xl border border-border bg-foreground p-5 text-left shadow-sm">
          <div className="mb-2 text-caption font-medium text-muted-foreground">接入 TabData 示例</div>
          <pre className="overflow-x-auto text-caption leading-relaxed text-muted-foreground">
{`import { createClient } from '@tabtin/sdk'

const tabtin = createClient({
  baseURL: import.meta.env.VITE_TABTIN_API_URL,
  token: import.meta.env.VITE_TABTIN_TOKEN,
})
await tabtin.init(import.meta.env.VITE_TABTIN_SPACE_ID)

const { data } = await tabtin
  .from('你的数据表')
  .select('*')
  .limit(20)
  .execute()`}
          </pre>
        </div>

        <p className="mt-6 text-caption text-muted-foreground">
          Powered by TabTin · React + Vite + Tailwind CSS
        </p>
      </div>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-caption font-bold text-primary">
        {n}
      </div>
      <div>
        <div className="text-body font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-body text-muted-foreground [&>code]:rounded [&>code]:bg-muted [&>code]:px-1 [&>code]:py-0.5 [&>code]:font-mono [&>code]:text-caption [&>code]:text-primary">
          {children}
        </div>
      </div>
    </div>
  )
}
