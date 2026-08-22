# Failure Patterns

这些反例来自 Wave 2-7 dogfood 中最容易踩的坑。每个 BAD 都是“别这么写”，GOOD 是可交付写法。

## 1. present_to_user 能表达却硬画 widget

BAD：二维数据表用 SVG 画格子。

```ts
show_widget({ summary: "销售表", format: "svg", code: "<svg>...</svg>" })
```

GOOD：原始表格走 `present_to_user.table_preview`。只有“从表格得出的趋势/对比”才画 widget。

## 2. summary 复读图内文字或太空

BAD：

```ts
show_widget({ summary: "K8s 架构图", format: "svg", code: "<svg>...</svg>" })
```

GOOD：

```ts
show_widget({
  summary: "K8s 三层架构：外部请求经 Ingress 进入，Service 做负载均衡，流量落到三组 Pod；Ingress 节点可点击继续解释。",
  format: "svg",
  code: "<svg>...</svg>"
})
```

## 3. cursor:pointer 但没 sendPrompt / hover

BAD：看起来可点，点了没反应。

```svg
<rect style="cursor:pointer" x="40" y="40" width="120" height="56"/>
```

GOOD：只有真实下钻才加 pointer，并提供 hover/focus。

```svg
<style>.node{cursor:pointer}.node:hover rect,.node:focus rect{stroke:hsl(var(--primary));}</style>
<g class="node" tabindex="0" onclick="sendPrompt('解释 Ingress 节点的职责', {node:'ingress'})">
  <rect x="40" y="40" width="120" height="56" rx="10" fill="hsl(var(--background))" stroke="hsl(var(--border))"/>
</g>
```

## 4. 所有元素都可点击

BAD：标题、背景、装饰线、每个小 label 都 `sendPrompt("more")`。

```svg
<text onclick="sendPrompt('more')" style="cursor:pointer">K8s</text>
<line onclick="sendPrompt('more')" style="cursor:pointer" x1="0" y1="0" x2="100" y2="0"/>
```

GOOD：只给用户会自然追问的节点加交互，文案具体。

```svg
<g onclick="sendPrompt('展开 Service 如何做负载均衡', {node:'service'})" style="cursor:pointer">
  <rect x="240" y="120" width="160" height="70" rx="12"/>
  <text x="292" y="162">Service</text>
</g>
```

## 5. 外链脚本/CDN/iframe/form

BAD：下面这些会被工具或 CSP 拒绝。示例故意保留危险写法，只能作为反例。

```html
<!-- BAD: external CDN script -->
<script src="https://cdn.example.com/chart.js"></script>
<!-- BAD: nested iframe -->
<iframe src="https://example.com"></iframe>
<!-- BAD: form submit -->
<form action="/submit"><input name="q"></form>
```

GOOD：用 SVG/HTML 静态画出来；需要点击时只用 `onclick="sendPrompt(...)"`。

## 6. HTML 写复杂滚动页面 / nested scrolling

BAD：widget 里做一个 1200px 高的设置后台，内部再滚动。

```html
<section style="height:1200px;overflow:auto">
  <div style="height:900px;overflow:auto">很多表格...</div>
</section>
```

GOOD：只画首屏关键状态。需要完整页面就做 TabDoc/TabSlide/真正 App。

```html
<section style="display:grid;gap:12px;max-height:420px;overflow:hidden">
  <article>账号</article><article>权限</article><article>完成</article>
</section>
```

## 7. Mermaid runtime script

BAD：把 Mermaid CDN 塞进 HTML。示例故意保留危险写法，只能作为反例。

```html
<!-- BAD: Mermaid must not run in widget iframe -->
<script src="https://cdn.example.com/mermaid.min.js"></script>
<div class="mermaid">flowchart TD; A-->B;</div>
```

GOOD：直接用 `format: "mermaid"`。

```ts
show_widget({
  summary: "登录流程：用户提交凭证，服务端校验后返回 session。",
  format: "mermaid",
  code: "flowchart TD\n  A[输入账号] --> B[服务端校验]\n  B --> C[返回 session]"
})
```

## 8. 改 sandbox 隔离策略

BAD：教用户给 iframe 加同源权限。示例故意保留危险写法，只能作为反例。

```html
<!-- BAD: allow-same-origin breaks the intended isolation model -->
<iframe sandbox="allow-scripts allow-same-origin"></iframe>
```

GOOD：不要在 skill/example 里教用户改 sandbox。renderer 统一使用 `sandbox="allow-scripts"`，widget 作者只写 SVG/HTML/Mermaid 内容。

## 9. 暗色模式硬编码黑字白底

BAD：

```svg
<rect fill="#fff" stroke="#ddd"/>
<text fill="#000">标题</text>
```

GOOD：

```svg
<rect fill="hsl(var(--background))" stroke="hsl(var(--border))"/>
<text fill="hsl(var(--foreground))">标题</text>
```

## 10. sendPrompt 文案不清楚 / meta 太大

BAD：

```html
<div onclick="sendPrompt('more', { allRows: '...整张大表...' })">Q3</div>
```

GOOD：

```html
<div onclick="sendPrompt('展开 Q3 华东销售增长的明细和原因', { quarter:'Q3', region:'east' })">Q3 华东</div>
```

`text` 建议像用户自然说话；`meta` 只放 id、类型、筛选键，别放整张图/大表。
