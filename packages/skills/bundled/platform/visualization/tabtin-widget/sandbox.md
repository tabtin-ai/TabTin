# Widget 沙箱与视觉规范

widget 跑在一个 **sandbox iframe** 里，用 `srcdoc` 注入。CSP 严格，不是浏览器 / TabSlide 那种全自由环境。下面这些规则**不是建议是硬规则**——破了的话 widget 渲染失败 / 显示异常 / 暗色模式崩坏，用户会以为 Agent 出 bug。

## 一、CSP（Content Security Policy）

实际生效的 CSP（与 RFC §4.4 对齐）：

```text
default-src 'none';
style-src   'unsafe-inline';
script-src  'unsafe-inline';   # 仅用于 wrapper 注入 sendPrompt bootstrap
img-src     https: data:;
font-src    'self' data:;
```

含义：

- **允许 inline `style="..."` 属性 / `<style>` 块**——SVG 内的所有样式都得 inline，没有外链 CSS
- **不允许外链 `<script src="...">`**——只允许 wrapper 注入的 `sendPrompt` 和元素上的点击调用；不要自己写 runtime script
- **`<img>` 仅允许 `https://` 和 `data:` URL**——但**强烈不推荐**在 widget 里嵌图片：跨域图会因 canvas tainted 让烤图失败，移动端 fallback 拿不到
- **字体不能外链**——只能用 system font

## 二、绝对不要做的事

| ❌ 反模式 | 后果 |
|---|---|
| `<script>` / `<script src="">` | HTML(no-script) 禁止；Mermaid 也会在工具侧编译，不需要 runtime |
| 非 sendPrompt 的 `onclick` / `onmouseover` 内联事件 | 只有用户点击触发新对话这一类交互被允许 |
| `<iframe>` / `<object>` / `<embed>` | 嵌套外部内容，扩大沙箱风险 |
| `<form>` / form submit | widget 是静态展示，不处理提交 |
| `position: fixed` / `position: sticky` | 元素脱出 chat 容器，覆盖到别的消息上 |
| `display: none` 的关键内容 | 隐藏后用户白等，看不到任何内容 |
| `width: 100vw` / `height: 100vh` | iframe 不是 viewport，会算成 0 |
| 外链 `<image href="https://example.com/foo.png">` | 跨域 → 烤图 canvas tainted → 移动端图片 fallback 整张丢 |
| 外链 `@font-face url(https://...)` | CSP 拒绝 |
| 写死 `#1a73e8` / `#fff` / `rgb(...)` 颜色 | 暗色模式下硬编码白底 + 黑字会瞎眼 |

## 三、HTML(no-script) 约束

适合：设置页 mockup、stepper、card/grid layout、静态表单外观。`code` 可以是 HTML fragment 或完整 document；wrapper 会提取 body 内容并保留 style。

禁止：JS、外链 script、`javascript:` URL、iframe/object/embed、form submit、弹窗、依赖点击切换状态。唯一交互例外是用户点击元素调用 `sendPrompt(text, meta?)`，详见 `sendPrompt-usage.md`。

## 四、Mermaid 约束

适合：flowchart、sequence、ER、Gantt。直接把 Mermaid source 传给 `show_widget(format: "mermaid")`；工具 execute 会编译成 SVG 并烤图，最终 iframe 不加载 Mermaid CDN/runtime。不要在 HTML 里写 `<script src="https://cdn.../mermaid">`。

禁止 `click` directive、外链、`javascript:`。Mermaid 本期不负责生成 sendPrompt 交互；需要可点击下钻时用 SVG/HTML。编译失败时工具会返回错误，不 emit 半截 widget。

## 五、SVG 尺寸约定

chat 消息容器宽度 **680px**（design-system.md 规定），所以：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 H" width="100%">
  <!-- 内容 -->
</svg>
```

- `viewBox` 第三位**写 680**，不要写其他值——错了会让烤图比例崩
- `viewBox` 第四位 `H` 自定，**推荐 ≤480**——太高用户要滚 chat
- 用 `width="100%"`，不要写绝对 px——iframe 在不同窗宽下会缩放
- 不要 `<svg width="1280" height="720">`——那是 TabSlide 不是 widget

## 六、视觉规范

### 6.1 颜色

只用 design tokens（见 SKILL.md 速查表），写法 `hsl(var(--xxx))`。这样暗色模式自动反色。

### 6.2 字体

只用 system font，**必须用完整 stack，最末必须有 `sans-serif` / `serif` 兜底**。禁止单一字体名（如 `Helvetica Neue` / `Arial`）——跨平台 fallback 不一致 + 中文渲染会崩。

```text
-apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif
```

字号建议（与 design-system.md 对齐）：

| 用途 | size |
|---|---|
| 主标题 | 16-20px |
| 次标题 | 14px |
| 正文 / label | 12-14px |
| 注释 | 11-12px |

### 6.3 留白与对齐

- 元素之间 **8 / 16 / 24px** 间距，不要随手 `5px` `7px`
- 圆角统一 **4 / 8 / 12px**
- stroke-width 用 **1 / 1.5 / 2**——大于 2 看着像玩具

### 6.4 暗色模式

不用单独写。chat 容器的 wrapper HTML 会把和父页面同步的 light/dark CSS 变量注入 iframe，所以颜色用 `hsl(var(--background))` / `hsl(var(--foreground))` 这套 token，light/dark 切换会自动生效。

### 6.5 不要画 chat 容器装饰

widget 只画**内容本身**——不要在 SVG 里画 chat 卡片的外框、阴影、左上角角标 / 小图示——容器装饰（含"图示"角标）由 chat 层负责，重画会和容器层重叠。

### 6.6 可点击视觉必须真实

只有会调用 `sendPrompt(text, meta?)` 的元素才能写 `cursor: pointer` / hover 反馈。不可点击元素禁止 cursor:pointer，避免用户点了没反应。

## 七、运行环境前置：必须有 UI session

`show_widget` 需要一个能渲染的会话——chat 内有 RichWidget 容器接收 RICH_CONTENT 事件。**Daemon / headless / 无连接 UI 的会话调用工具会直接报错拒绝执行**（"show_widget requires a connected UI session"），不要在这种环境下尝试。判断：当前 Space 的 device_runtime 是 Electron 桌面端 / 移动端拉流时可用；纯 Daemon 自动化脚本 / 隔离子任务跑时不可用——退化到文字回答或 `present_to_user.image` / `resource_ref`。

## 八、流式渲染行为

LLM 流式吐 token 时前端**逐 token 把累积的 code 注入 iframe srcdoc**，按 rAF 节流（Wave 3 加）。这意味着：

- SVG/HTML 不闭合时浏览器会尽力渲染；Mermaid 不逐 token 渲染，编译完一次性出图
- 同一张图一次写完整；多张独立图可以多次调用并用同一个 `group_id` 分组
- `loading_message` 仅在 widget code 还**完全空**时显示（一旦 token 开始流就消失）

## 九、检查清单（写完 widget 自己过一遍）

- [ ] viewBox 第三位 = 680
- [ ] 所有颜色用 `hsl(var(--xxx))`，没硬编码 hex
- [ ] 字体只用 system font
- [ ] 没外链 `<script>` / 非 sendPrompt `onclick` / `position: fixed` / `display: none`
- [ ] HTML 没 `javascript:` / iframe / object / embed / form
- [ ] Mermaid 没 click directive；没有引 runtime script
- [ ] 可点击元素有 cursor:pointer + hover；不可点击元素没有 cursor:pointer
- [ ] 没外链 image / font / script
- [ ] `summary` 字段写了一句话讲清画了什么（移动端 fallback）
- [ ] 一次写完整，不分步调用
