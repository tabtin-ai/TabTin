# HTML Stepper Example

用 `format: "html"` 画静态 stepper / 设置向导。不要加脚本或提交动作；只有确实要继续追问的步骤才加 `sendPrompt`。

```text
show_widget({
  summary: "三步设置页 mockup：账号、权限、完成，每步用卡片展示当前状态。",
  format: "html",
  loading_message: "正在生成设置页 mockup…",
  code: `
<style>
  .wrap{display:grid;gap:12px;color:hsl(var(--foreground));font-family:-apple-system,BlinkMacSystemFont,system-ui,'PingFang SC',sans-serif}
  .card{border:1px solid hsl(var(--border));border-radius:12px;padding:14px;background:hsl(var(--background))}
  .choice{display:block;width:100%;text-align:left;font:inherit;cursor:pointer;transition:border-color .12s ease,background .12s ease}
  .choice:hover,.choice:focus{border-color:hsl(var(--primary));background:hsl(var(--primary) / .08)}
</style>
<section class="wrap">
  <h2 style="margin:0;font-size:18px">团队设置向导</h2>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
    <article class="card">
      <strong>1. 账号</strong><p style="margin:8px 0 0;color:hsl(var(--muted-foreground))">填写团队名称和负责人。</p>
    </article>
    <button type="button" class="card choice" onclick="sendPrompt('展开权限步骤里成员默认角色和审批策略的设计理由', { step:'permissions' })">
      <strong>2. 权限</strong><p style="margin:8px 0 0;color:hsl(var(--muted-foreground))">选择成员默认角色。</p>
    </button>
    <article class="card">
      <strong>3. 完成</strong><p style="margin:8px 0 0;color:hsl(var(--muted-foreground))">确认配置并创建 Space。</p>
    </article>
  </div>
</section>`
})
```
