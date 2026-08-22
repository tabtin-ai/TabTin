# Settings Page HTML

## 为什么用 widget

用户让 Agent 设计一个设置页时，HTML(no-script) 比 SVG 更适合表达布局、卡片、开关外观和响应式栅格。它仍然只是静态 mockup，不提交表单、不执行脚本。

## show_widget input

```ts
show_widget({
  title: "团队设置页 mockup",
  summary: "团队设置页静态 mockup：左侧是账号与安全状态，右侧是成员默认角色和通知策略；权限卡片可点击让 Agent 展开设计理由。",
  format: "html",
  loading_message: "正在生成设置页 mockup...",
  code: `
<style>
  .wrap{display:grid;gap:14px;color:hsl(var(--foreground));font-family:-apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .card{border:1px solid hsl(var(--border));border-radius:14px;background:hsl(var(--card));padding:16px}
  .title{font-size:16px;font-weight:700;margin:0 0 8px}
  .muted{color:hsl(var(--muted-foreground));font-size:12px;margin:0}
  .row{display:flex;justify-content:space-between;align-items:center;border-top:1px solid hsl(var(--border));padding-top:12px;margin-top:12px}
  .pill{border-radius:999px;background:hsl(var(--success) / .14);color:hsl(var(--success));padding:4px 9px;font-size:12px}
  .choice{display:block;width:100%;text-align:left;font:inherit;cursor:pointer;outline:none;transition:border-color .12s ease,background .12s ease,transform .12s ease}
  .choice:hover,.choice:focus{border-color:hsl(var(--primary));background:hsl(var(--primary) / .08);transform:translateY(-1px)}
</style>
<section class="wrap">
  <div>
    <h2 class="title">团队设置</h2>
    <p class="muted">静态 HTML mockup：没有脚本、没有提交动作。</p>
  </div>
  <div class="grid">
    <article class="card">
      <h3 class="title">账号与安全</h3>
      <p class="muted">强制双因素认证，保留 90 天审计记录。</p>
      <div class="row"><span>2FA</span><span class="pill">已启用</span></div>
    </article>
    <button type="button" class="card choice" onclick="sendPrompt('解释为什么成员默认角色建议设为 editor，而不是 admin', { section:'permissions', defaultRole:'editor' })">
      <h3 class="title">默认权限</h3>
      <p class="muted">新成员默认 editor；高风险操作仍需 owner 确认。</p>
      <div class="row"><span>默认角色</span><strong>editor</strong></div>
    </button>
    <article class="card">
      <h3 class="title">通知策略</h3>
      <p class="muted">只推送失败、审批和用户点名。</p>
    </article>
    <article class="card">
      <h3 class="title">设备访问</h3>
      <p class="muted">Agent 绑定设备后才能调用本机能力。</p>
    </article>
  </div>
</section>`
})
```

## 注意点

HTML widget 不要写复杂滚动后台，也不要出现真实输入提交。需要下一步讨论时，用 `sendPrompt` 让 Agent 在 chat 里继续。
