import { useState } from 'react'

const NAV_ITEMS = [
  {
    section: '快速开始',
    items: [
      { id: 'intro', title: '简介' },
      { id: 'install', title: '安装' },
      { id: 'quickstart', title: '快速上手' },
    ],
  },
  {
    section: '核心概念',
    items: [
      { id: 'architecture', title: '架构概览' },
      { id: 'config', title: '配置' },
      { id: 'deploy', title: '部署' },
    ],
  },
  {
    section: 'API 参考',
    items: [
      { id: 'api-client', title: '客户端 API' },
      { id: 'api-hooks', title: 'React Hooks' },
    ],
  },
]

const CONTENT: Record<string, { title: string; body: string }> = {
  intro: {
    title: '简介',
    body: `欢迎使用文档站模板！这个模板为你提供了一个开箱即用的文档站点结构。

## 特性

- **侧边栏导航**：多级目录结构，清晰组织文档
- **响应式布局**：适配桌面和移动端
- **搜索支持**：快速查找文档内容
- **代码高亮**：展示代码示例

## 下一步

1. 编辑 \`src/App.tsx\` 修改导航结构
2. 替换示例内容为你的文档
3. 运行 \`tabtin site build\` 发布上线`,
  },
  install: {
    title: '安装',
    body: `## 系统要求

- Node.js 18+
- pnpm 8+

## 安装步骤

\`\`\`bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev

# 构建生产版本
pnpm build
\`\`\``,
  },
  quickstart: {
    title: '快速上手',
    body: `## 创建你的第一个页面

编辑 \`src/App.tsx\` 中的 \`CONTENT\` 对象来添加新页面。

每个页面需要：
- 一个唯一的 ID
- 标题
- Markdown 格式的内容

## 发布

使用 TabTin CLI 一键发布：

\`\`\`bash
tabtin site build <site-id>
\`\`\``,
  },
}

export default function App() {
  const [activePage, setActivePage] = useState('intro')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const page = CONTENT[activePage] || CONTENT.intro

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? 'w-64' : 'w-0'} shrink-0 overflow-hidden border-r border-border bg-card transition-all`}>
        <div className="px-4 py-5">
          <h1 className="text-body font-bold text-foreground">📚 Docs</h1>
        </div>
        <nav className="px-2 pb-6">
          {NAV_ITEMS.map((section) => (
            <div key={section.section} className="mb-4">
              <div className="px-3 py-1 text-caption font-semibold uppercase text-muted-foreground">
                {section.section}
              </div>
              {section.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setActivePage(item.id)}
                  className={`mt-0.5 block w-full rounded-md px-3 py-1.5 text-left text-body transition-colors ${
                    activePage === item.id
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {item.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1">
        <div className="border-b border-border px-6 py-3">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ☰
          </button>
        </div>
        <article className="mx-auto max-w-3xl px-8 py-12">
          <h1 className="text-heading font-bold text-foreground">{page.title}</h1>
          <div className="prose mt-6 text-body leading-relaxed text-muted-foreground [&>h2]:mt-8 [&>h2]:text-subtitle [&>h2]:font-semibold [&>h2]:text-foreground [&>ul]:list-disc [&>ul]:pl-6 [&>ol]:list-decimal [&>ol]:pl-6 [&>p]:mt-4 [&>pre]:mt-4 [&>pre]:rounded-lg [&>pre]:bg-muted [&>pre]:p-4 [&>pre]:text-caption [&>pre]:font-mono">
            {page.body.split('\n').map((line, i) => {
              if (line.startsWith('## ')) return <h2 key={i}>{line.slice(3)}</h2>
              if (line.startsWith('- ')) return <li key={i}>{line.slice(2)}</li>
              if (line.startsWith('```')) return null
              if (line.trim() === '') return <br key={i} />
              return <p key={i}>{line}</p>
            })}
          </div>
        </article>
      </main>
    </div>
  )
}
