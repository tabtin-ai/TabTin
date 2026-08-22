# K8s Architecture SVG

## 为什么用 widget

Kubernetes 三层架构的核心是空间关系：外部流量从 Ingress 进入，经 Service 分发到 Pod。`present_to_user` 没有自由绘图 schema；这是 `show_widget(format: "svg")` 的典型场景。Ingress / Service 是高价值下钻点，适合 `sendPrompt`。

## show_widget input

```ts
show_widget({
  title: "K8s 三层架构",
  summary: "K8s 三层架构图：外部流量经 Ingress 进入，Service 做负载均衡，分发到三个 Pod；Ingress 和 Service 节点可点击继续解释。",
  format: "svg",
  loading_message: "正在生成 K8s 架构图...",
  code: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 360" width="100%" role="img">
  <title>K8s 三层架构</title>
  <desc>外部用户流量进入 Ingress，经 Service 分发到三个 Pod。</desc>
  <style>
    .txt{font-family:-apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;fill:hsl(var(--foreground))}
    .muted{fill:hsl(var(--muted-foreground))}
    .card{fill:hsl(var(--background));stroke:hsl(var(--border));stroke-width:1.5}
    .click{cursor:pointer;outline:none}
    .click .card{transition:stroke .12s ease,filter .12s ease,transform .12s ease}
    .click:hover .card,.click:focus .card{stroke:hsl(var(--primary));filter:drop-shadow(0 6px 14px hsl(var(--primary) / .18));transform:translateY(-2px)}
    .arrow{stroke:hsl(var(--muted-foreground));stroke-width:1.7;fill:none;marker-end:url(#arrow)}
  </style>
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="hsl(var(--muted-foreground))"/></marker></defs>
  <text class="txt" x="40" y="36" font-size="20" font-weight="700">Kubernetes 请求路径</text>
  <text class="txt muted" x="40" y="60" font-size="13">点击 Ingress 或 Service 继续下钻</text>

  <rect class="card" x="42" y="118" width="120" height="64" rx="14"/>
  <text class="txt" x="70" y="155" font-size="14">User</text>

  <a class="click" href="#ingress" aria-label="详细解释 Ingress 控制器" onclick="sendPrompt('详细解释 Ingress 控制器如何接收外部流量并路由到 Service', { node:'ingress', layer:'edge' })">
    <rect class="card" x="230" y="96" width="150" height="90" rx="16"/>
    <text class="txt" x="274" y="135" font-size="16" font-weight="700">Ingress</text>
    <text class="txt muted" x="258" y="160" font-size="12">TLS / host / path</text>
  </a>

  <a class="click" href="#service" aria-label="展开 Service 负载均衡" onclick="sendPrompt('展开 Service 如何在 Pod 副本之间做负载均衡', { node:'service', layer:'routing' })">
    <rect class="card" x="468" y="96" width="150" height="90" rx="16"/>
    <text class="txt" x="516" y="135" font-size="16" font-weight="700">Service</text>
    <text class="txt muted" x="500" y="160" font-size="12">ClusterIP / LB</text>
  </a>

  <path class="arrow" d="M162 150 H222"/>
  <path class="arrow" d="M380 141 H460"/>

  <g>
    <rect class="card" x="448" y="246" width="74" height="54" rx="12"/>
    <rect class="card" x="530" y="246" width="74" height="54" rx="12"/>
    <rect class="card" x="489" y="306" width="74" height="36" rx="10"/>
    <text class="txt" x="471" y="279" font-size="13">Pod A</text>
    <text class="txt" x="553" y="279" font-size="13">Pod B</text>
    <text class="txt" x="512" y="330" font-size="13">Pod C</text>
    <path class="arrow" d="M544 186 V236"/>
  </g>
</svg>`
})
```

## 注意点

可点击元素都有 `cursor:pointer`、hover/focus 反馈和明确文案；装饰箭头、标题和 Pod 仅展示，不伪装成交互。颜色全部使用 `hsl(var(--foreground))`、`--background`、`--border`、`--primary`。
