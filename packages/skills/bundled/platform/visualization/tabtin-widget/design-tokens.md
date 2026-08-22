# Design Tokens

widget iframe 会注入与 chat 同源的 light/dark CSS 变量。写 widget 时只引用变量，不硬编码品牌色、黑字白底或固定阴影色。

## 写法

CSS 变量值是 HSL 三元组，必须包一层 `hsl(var(--token))`：

```css
.card {
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  border: 1px solid hsl(var(--border));
}
.hint { color: hsl(var(--muted-foreground)); }
.cta { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
```

透明度写在 HSL 后面：

```css
.soft-primary { background: hsl(var(--primary) / 0.10); }
.soft-warning { fill: hsl(var(--warning) / 0.14); }
```

## 可用 token

| token | 用途 |
|---|---|
| `--background` / `--foreground` | 页面底色、主文字 |
| `--card` / `--card-foreground` | 卡片底色、卡片文字 |
| `--secondary` / `--secondary-foreground` | 次级块、弱按钮 |
| `--muted` / `--muted-foreground` | 注释、辅助线、弱文案 |
| `--primary` / `--primary-foreground` | 主行动、重点节点、选中态 |
| `--accent` / `--accent-foreground` | 高亮、辅助强调 |
| `--success` / `--warning` / `--destructive` / `--info` | 状态色 |
| `--border` / `--input` / `--ring` | 边框、输入外观、focus ring |
| `--radius` | 基础圆角，可用 `calc(var(--radius) * 2)` |

## light/dark 真实值

这些值来自 `@tabtin/widget-tokens` 的 `theme-bundle.ts`，运行时由 wrapper 注入：

| token | light | dark |
|---|---|---|
| `--background` | `40 25% 99%` | `30 6% 12%` |
| `--foreground` | `30 10% 15%` | `36 14% 90%` |
| `--primary` | `215 65% 52%` | `215 65% 62%` |
| `--muted-foreground` | `30 6% 50%` | `30 6% 55%` |
| `--border` | `34 10% 89%` | `30 6% 20%` |
| `--success` | `152 45% 42%` | `152 45% 55%` |
| `--warning` | `38 70% 50%` | `38 60% 55%` |
| `--destructive` | `0 55% 52%` | `0 55% 60%` |

不要复制这些数值到 widget。复制后主题更新不会同步。

## SVG 建议

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 360" width="100%" role="img">
  <title>Q3 区域销售对比</title>
  <desc>华东最高，华南第二，西部最低。</desc>
  <style>
    .label { font: 14px -apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif; fill: hsl(var(--foreground)); }
    .axis { stroke: hsl(var(--border)); }
    .bar { fill: hsl(var(--primary)); }
  </style>
  <line class="axis" x1="56" y1="300" x2="620" y2="300"/>
  <rect class="bar" x="96" y="108" width="64" height="192" rx="8"/>
  <text class="label" x="96" y="328">华东</text>
</svg>
```

要写 `<title>` 和 `<desc>`，它们能补足 `summary` 之外的 SVG 内部语义。

## HTML 建议

```html
<style>
  .panel {
    display: grid;
    gap: 12px;
    color: hsl(var(--foreground));
    font-family: -apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
  }
  .card {
    border: 1px solid hsl(var(--border));
    border-radius: 12px;
    background: hsl(var(--card));
    padding: 14px;
  }
</style>
<section class="panel">
  <article class="card">静态 UI mockup 内容</article>
</section>
```

## 间距 / 字号 / 形状

| 项 | 推荐 |
|---|---|
| 外层 padding | 12 / 16 / 24 |
| 网格 gap | 8 / 12 / 16 / 24 |
| 圆角 | 4 / 8 / 12 |
| stroke | 1 / 1.5 / 2 |
| 主标题 | 18-20 |
| 小标题 | 14-16 |
| 正文/标签 | 12-14 |
| 注释 | 11-12 |

## 不要做

- 不要写死 `#000`、`#fff`、`black`、`white`、`rgb(...)` 当主要颜色。
- 不要用外链字体或 `@font-face` URL；CSP 会拦。
- 不要把 chat 卡片外框、阴影、角标画进 widget，容器层已经负责。
- 不要靠颜色单独表达状态；加文字、图标或 pattern，让色弱用户也能理解。
