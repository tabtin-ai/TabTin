import { useState } from 'react'

const SAMPLE_POSTS = [
  {
    id: 1,
    title: '开始使用 TabSite 搭建博客',
    excerpt: '这篇文章介绍如何使用 TabSite 的博客模板快速搭建你的个人博客，支持 Markdown 渲染和代码高亮。',
    date: '2026-03-24',
    tag: '教程',
    readTime: '5 分钟',
  },
  {
    id: 2,
    title: '接入 TabData 实现动态内容',
    excerpt: '通过 @tabtin/sdk 连接 TabData 数据表，将博客文章存储在云端，实现真正的动态博客。',
    date: '2026-03-23',
    tag: '进阶',
    readTime: '8 分钟',
  },
  {
    id: 3,
    title: '自定义主题与样式指南',
    excerpt: '如何修改 Tailwind CSS 配置来打造独一无二的博客主题，包括颜色、字体和布局调整。',
    date: '2026-03-22',
    tag: '设计',
    readTime: '4 分钟',
  },
]

export default function App() {
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const tags = [...new Set(SAMPLE_POSTS.map((p) => p.tag))]
  const filtered = selectedTag ? SAMPLE_POSTS.filter((p) => p.tag === selectedTag) : SAMPLE_POSTS

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
          <h1 className="text-title font-bold text-foreground">My Blog</h1>
          <nav className="flex items-center gap-4">
            <a href="#" className="text-body text-muted-foreground hover:text-foreground">关于</a>
            <a href="#" className="text-body text-muted-foreground hover:text-foreground">归档</a>
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <h2 className="text-heading font-bold text-foreground">最近文章</h2>
          <p className="mt-2 text-body text-muted-foreground">
            替换这些示例文章，开始书写你的内容
          </p>
        </div>

        {/* Tags */}
        <div className="mb-8 flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedTag(null)}
            className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
              !selectedTag ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            全部
          </button>
          {tags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(tag === selectedTag ? null : tag)}
              className={`rounded-full border px-3 py-1 text-caption font-medium transition-colors ${
                selectedTag === tag ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>

        {/* Posts */}
        <div className="space-y-8">
          {filtered.map((post) => (
            <article key={post.id} className="group cursor-pointer border-b border-border pb-8 last:border-0">
              <div className="flex items-center gap-3 text-caption text-muted-foreground">
                <time>{post.date}</time>
                <span>·</span>
                <span>{post.readTime}</span>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-caption font-medium text-primary">
                  {post.tag}
                </span>
              </div>
              <h3 className="mt-3 text-subtitle font-semibold text-foreground group-hover:text-primary transition-colors">
                {post.title}
              </h3>
              <p className="mt-2 text-body text-muted-foreground leading-relaxed">
                {post.excerpt}
              </p>
              <span className="mt-3 inline-block text-body font-medium text-primary">
                阅读全文 →
              </span>
            </article>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <p className="text-center text-caption text-muted-foreground">
            Powered by TabTin · React + Vite + Tailwind CSS
          </p>
        </div>
      </footer>
    </div>
  )
}
