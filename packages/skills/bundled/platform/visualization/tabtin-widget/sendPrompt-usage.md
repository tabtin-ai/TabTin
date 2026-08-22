# sendPrompt 交互规范

`sendPrompt(text, meta?)` 把用户点击 widget 的位置转换成新一轮对话。它不是 widget 内部状态机，也不是自动事件 API。

## 运行限制

- 只能由真实用户手势触发。wrapper 会记录 click / pointerup / keydown 的 trusted gesture，普通自动调用会被丢弃。
- 单个 session + widget 1 分钟最多 5 次，超出会被限流。
- `text` 必须是非空字符串，硬上限 1000 字；建议 ≤200 字。
- `meta` 必须能 JSON 序列化，硬上限 4KB；只放节点 id、数据键、方案名等小上下文。
- 父页面会再校验 widget/session/text/meta；不要依赖 widget 自己做安全判断。

## 什么时候该加

适合：架构节点下钻、失败 stage 排障、图表柱子明细、方案选择、流程某一步追问。

不适合：标题、背景、装饰线、纯说明文字、每个元素都可点但问题相同、只想在 widget 内切换 tab。

## 视觉规范

- 可点击元素必须有 `cursor:pointer`，并且有 hover/focus 反馈。
- 不可点击元素禁止 pointer 和 hover。
- 文案写成用户会说的话：`展开 Q3 华东销售增长的明细和原因`，不要写 `more` / `node detail`。
- 点击后 chat 流会显示用户点击发送的文本，所以文本必须对用户透明。

## SVG 示例

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 260" width="100%" role="img">
  <title>K8s 三层架构</title>
  <desc>Ingress、Service、Pod 三层，Ingress 节点可点击下钻。</desc>
  <style>
    .node { cursor: pointer; outline: none; }
    .node rect { transition: stroke .12s ease, transform .12s ease; }
    .node:hover rect, .node:focus rect { stroke: hsl(var(--primary)); transform: translateY(-2px); }
    .label { font: 14px -apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif; fill: hsl(var(--foreground)); pointer-events: none; }
  </style>
  <a class="node" href="#ingress" aria-label="详细解释 Ingress 控制器" onclick="sendPrompt('详细解释 Ingress 控制器如何把外部流量路由到服务', { node:'ingress', layer:'edge' })">
    <rect x="60" y="80" width="160" height="72" rx="12" fill="hsl(var(--background))" stroke="hsl(var(--border))"/>
    <text class="label" x="112" y="122">Ingress</text>
  </a>
</svg>
```

## HTML 示例

```html
<style>
  .choice {
    display: block;
    width: 100%;
    border: 1px solid hsl(var(--border));
    border-radius: 12px;
    padding: 14px;
    cursor: pointer;
    color: hsl(var(--foreground));
    background: hsl(var(--card));
    transition: border-color .12s ease, background .12s ease, transform .12s ease;
  }
  .choice:hover, .choice:focus {
    border-color: hsl(var(--primary));
    background: hsl(var(--primary) / 0.08);
    transform: translateY(-1px);
  }
</style>
<button type="button" class="choice" onclick="sendPrompt('我选择方案 A，请展开实施步骤和风险', { option:'A' })">
  <strong>方案 A：低风险渐进迁移</strong>
  <p>先复制读路径，再灰度写路径。</p>
</button>
```

## 反例

```html
<!-- BAD: 文案不清楚，用户看不到自己到底发了什么 -->
<div style="cursor:pointer" onclick="sendPrompt('more')">数据库</div>

<!-- BAD: 自动触发；sendPrompt 必须来自用户手势 -->
<script>setInterval(() => sendPrompt('继续'), 1000)</script>
```
