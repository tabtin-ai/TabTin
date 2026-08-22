const PROJECTS = [
  {
    title: '电商数据看板',
    description: '为电商客户设计的实时数据分析面板，支持多维度数据筛选和可视化图表。',
    tags: ['React', 'TabData', 'Recharts'],
    color: 'from-blue-500 to-cyan-400',
  },
  {
    title: '团队协作工具',
    description: '支持多人实时协作的项目管理工具，包含任务看板、文档编辑和即时通讯。',
    tags: ['TypeScript', 'WebSocket', 'CRDTs'],
    color: 'from-violet-500 to-purple-400',
  },
  {
    title: '智能客服系统',
    description: '基于 AI 的智能客服平台，支持多轮对话、意图识别和自动工单分配。',
    tags: ['AI', 'NLP', 'Node.js'],
    color: 'from-amber-500 to-orange-400',
  },
  {
    title: '内容管理平台',
    description: '面向媒体团队的内容管理系统，支持富文本编辑、版本控制和发布审核。',
    tags: ['Next.js', 'PostgreSQL', 'S3'],
    color: 'from-emerald-500 to-teal-400',
  },
]

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="mx-auto max-w-5xl px-6 pt-20 pb-12">
        <div className="flex items-center gap-5">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-200">
            <span className="text-heading font-bold text-white">YN</span>
          </div>
          <div>
            <h1 className="text-heading font-bold text-foreground">Your Name</h1>
            <p className="text-subtitle text-muted-foreground">全栈开发者 · 产品设计师</p>
          </div>
        </div>
        <p className="mt-6 max-w-2xl text-body leading-relaxed text-muted-foreground">
          这是你的作品集模板。在这里展示你最好的项目和作品。
          替换示例内容，添加项目截图和链接，打造你的专属作品集。
        </p>
        <div className="mt-6 flex gap-4">
          <a href="#" className="text-body text-primary hover:underline">GitHub</a>
          <a href="#" className="text-body text-primary hover:underline">Twitter</a>
          <a href="#" className="text-body text-primary hover:underline">Email</a>
        </div>
      </header>

      {/* Projects */}
      <section className="mx-auto max-w-5xl px-6 py-12">
        <h2 className="text-title font-bold text-foreground">精选项目</h2>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {PROJECTS.map((p) => (
            <div key={p.title} className="group cursor-pointer overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
              <div className={`h-40 bg-gradient-to-br ${p.color} opacity-80 transition-opacity group-hover:opacity-100`} />
              <div className="p-6">
                <h3 className="text-subtitle font-semibold text-foreground group-hover:text-primary transition-colors">
                  {p.title}
                </h3>
                <p className="mt-2 text-body text-muted-foreground">{p.description}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {p.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-muted px-2.5 py-0.5 text-caption font-medium text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <p className="text-center text-caption text-muted-foreground">
            Powered by TabTin · React + Vite + Tailwind CSS
          </p>
        </div>
      </footer>
    </div>
  )
}
