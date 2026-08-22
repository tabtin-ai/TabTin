# Purchase Journey with sendPrompt

## 为什么用 widget

购买流程是用户旅程，阶段、掉点和转化关系比列表更适合可视化。关键掉点可点击，让用户把“视觉位置”转成追问。

## show_widget input

```ts
show_widget({
  title: "购买旅程",
  summary: "用户购买旅程图：访问商品页、加入购物车、结账、支付成功四步；结账阶段流失最高，可点击追问原因。",
  format: "svg",
  loading_message: "正在生成购买旅程图...",
  code: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 340" width="100%" role="img">
  <title>购买旅程</title>
  <desc>四步购买流程，结账阶段流失最高并可点击下钻。</desc>
  <style>
    .txt{font-family:-apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;fill:hsl(var(--foreground))}
    .muted{fill:hsl(var(--muted-foreground))}
    .step{fill:hsl(var(--card));stroke:hsl(var(--border));stroke-width:1.5}
    .risk{fill:hsl(var(--warning) / .16);stroke:hsl(var(--warning));stroke-width:1.5}
    .click{cursor:pointer;outline:none}
    .click .risk{transition:filter .12s ease,transform .12s ease}
    .click:hover .risk,.click:focus .risk{filter:drop-shadow(0 6px 14px hsl(var(--warning) / .22));transform:translateY(-2px)}
    .arrow{stroke:hsl(var(--muted-foreground));stroke-width:1.6;fill:none;marker-end:url(#arrow)}
  </style>
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="hsl(var(--muted-foreground))"/></marker></defs>
  <text class="txt" x="38" y="40" font-size="20" font-weight="700">购买旅程</text>
  <text class="txt muted" x="38" y="64" font-size="13">点击结账阶段，继续分析流失原因</text>

  <rect class="step" x="38" y="130" width="126" height="86" rx="16"/>
  <text class="txt" x="66" y="164" font-size="15" font-weight="700">访问商品页</text>
  <text class="txt muted" x="76" y="190" font-size="12">100%</text>

  <rect class="step" x="202" y="130" width="126" height="86" rx="16"/>
  <text class="txt" x="232" y="164" font-size="15" font-weight="700">加入购物车</text>
  <text class="txt muted" x="246" y="190" font-size="12">62%</text>

  <a class="click" href="#checkout" aria-label="分析结账阶段流失原因" onclick="sendPrompt('分析购买旅程里结账阶段流失最高的原因，并给出三个优化实验', { stage:'checkout', dropoff:0.27 })">
    <rect class="risk" x="366" y="130" width="126" height="86" rx="16"/>
    <text class="txt" x="414" y="164" font-size="15" font-weight="700">结账</text>
    <text class="txt muted" x="404" y="190" font-size="12">35% 留存</text>
  </a>

  <rect class="step" x="530" y="130" width="112" height="86" rx="16"/>
  <text class="txt" x="558" y="164" font-size="15" font-weight="700">支付成功</text>
  <text class="txt muted" x="572" y="190" font-size="12">28%</text>

  <path class="arrow" d="M164 173 H194"/>
  <path class="arrow" d="M328 173 H358"/>
  <path class="arrow" d="M492 173 H522"/>
  <text class="txt muted" x="382" y="246" font-size="12">最高流失：-27pp</text>
</svg>`
})
```

## 注意点

不要让每个阶段都可点击。这里用户真正需要的是最高流失点，所以只给“结账”一个交互入口，并把 `text` 写成用户能理解的新问题。
