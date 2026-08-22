export default function App() {
  return (
    <div className="min-h-screen bg-background">
      {/* Hero */}
      <header className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-white to-purple-50" />
        <nav className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <span className="text-title font-bold text-foreground">YourBrand</span>
          <div className="flex items-center gap-6">
            <a href="#features" className="text-body text-muted-foreground hover:text-foreground">功能</a>
            <a href="#pricing" className="text-body text-muted-foreground hover:text-foreground">定价</a>
            <button className="rounded-lg bg-primary px-4 py-2 text-body font-medium text-primary-foreground shadow-sm hover:opacity-90">
              立即开始
            </button>
          </div>
        </nav>

        <div className="relative mx-auto max-w-4xl px-6 pb-24 pt-20 text-center">
          <div className="inline-block rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-caption font-medium text-primary">
            新品上线 🎉
          </div>
          <h1 className="mt-6 text-display font-bold tracking-tight text-foreground md:text-[48px] md:leading-[56px]">
            用更聪明的方式
            <br />
            <span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
              构建你的产品
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-subtitle text-muted-foreground">
            这是你的产品落地页模板。替换文案和图片，快速打造专业的品牌展示页面。
            支持响应式布局，开箱即用。
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <button className="rounded-lg bg-primary px-6 py-3 text-body font-medium text-primary-foreground shadow-lg shadow-primary/25 hover:opacity-90">
              免费试用
            </button>
            <button className="rounded-lg border border-border px-6 py-3 text-body font-medium text-foreground hover:bg-muted">
              了解更多 →
            </button>
          </div>
        </div>
      </header>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-24">
        <div className="text-center">
          <h2 className="text-heading font-bold text-foreground">核心功能</h2>
          <p className="mt-3 text-subtitle text-muted-foreground">
            为你的用户提供最佳体验
          </p>
        </div>
        <div className="mt-16 grid gap-8 md:grid-cols-3">
          {[
            { icon: '⚡', title: '极速性能', desc: '毫秒级响应，让用户感受丝滑体验' },
            { icon: '🎨', title: '精美设计', desc: '现代化 UI 设计，支持深色模式' },
            { icon: '🔒', title: '安全可靠', desc: '企业级安全保障，数据加密传输' },
          ].map((f) => (
            <div key={f.title} className="rounded-2xl border border-border bg-card p-8 shadow-sm">
              <div className="text-heading">{f.icon}</div>
              <h3 className="mt-4 text-subtitle font-semibold text-foreground">{f.title}</h3>
              <p className="mt-2 text-body text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-4xl px-6 py-24 text-center">
        <div className="rounded-3xl bg-gradient-to-br from-indigo-600 to-purple-600 px-8 py-16 text-white shadow-2xl shadow-indigo-200">
          <h2 className="text-heading font-bold">准备好开始了吗？</h2>
          <p className="mt-3 text-subtitle opacity-80">
            免费注册，无需信用卡，随时取消
          </p>
          <button className="mt-8 rounded-lg bg-white px-8 py-3 text-body font-semibold text-indigo-600 shadow-lg hover:opacity-90">
            立即注册
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <p className="text-center text-caption text-muted-foreground">
            © 2026 YourBrand. Powered by TabTin.
          </p>
        </div>
      </footer>
    </div>
  )
}
