---
name: tabslide-operator
description: >
  演示文稿操作——创建、编辑、放映、导出可继续协作的
  PPT / 幻灯片 / 演示文稿。用户要做 / 改演示时使用；
  正文覆盖大纲生成、页面管理和 AI 辅助创建。
metadata:
  version: "0.1.0"
  tabtin:
    category: doc
    displayName: "TabSlide Operator"
    autoActivateFor:
      - tabslide
    tags:
      - slide
      - presentation
---

# TabSlide Operator

通过 `tabtin slide` CLI 生成演示文稿并**交付为工作目录内的本地 `.pptx` 文件**。

## 交付口径（必读）

当前版本 **TabSlide App UI 已对用户隐藏，也不要产生云演示文稿项目**：TabSlide 只作为
「隐形渲染引擎」把 HTML 排版成高质量幻灯片，最终产物是**工作目录里的本地 `.pptx` 文件
\+ 聊天文件卡片**。因此 **用户说「做 / 生成一份 PPT / 幻灯片 / 演示文稿」时，用一步命令
直出本地文件**：

1. 写好 HTML → `tabtin slide render --html "@./deck.html" --save-to <名称>.pptx`
   （内部自动 create → export → 下载 → **删除临时云项目**，全程不留用户可见的云演示文稿）
2. **立刻** `present_to_user({summary:"演示文稿", items:[{kind:"local_file", relative_path:"<名称>.pptx"}]})` 发布成聊天卡片（render 输出的
   `next_step` 里有现成提示）
3. **不要**走 `slide create` → `export` 的多步流程——那会留下用户不可见的云项目；要改内容
   就改 HTML 重新 `render`（产物就是本地文件，幂等覆盖）
4. **不要**引导用户「打开 TabSlide 编辑器 / 到应用里继续编辑」——该入口当前不存在

与 `file-generation` skill 的分工：做 **PPT / 幻灯片 / 演示文稿**（要设计感 / 复杂版式）用
本 skill 的 `slide render`；xlsx / docx / pdf 等其他 office 文件，或纯数据罗列的极简 pptx，
才走 `tabtin file create`。

## 运行时要求（必读）

**所有 `tabtin slide *` 命令都需要 TabTin 桌面端 _或_ tabtin-daemon 正在运行**（命令走本地 cli-server 路由）。直连 API 模式下会得到 `UNAVAILABLE: '<cmd>' 需要 TabTin 桌面端或 Daemon 运行`。

| 场景 | 怎么启动 |
|------|---------|
| 桌面用户 | 打开 TabTin Electron App（最常见，无需额外操作） |
| 无头服务器 | `npm i -g @tabtin/daemon && tabtin-daemon init --token <t> && tabtin-daemon start` |
| 本地开发 | `tabtin daemon start`（已桥接到 monorepo `apps/tabtin-daemon/dist/index.js`） |

每条命令章节顶部都会再标 `**运行时**：桌面端 / Daemon`——看到就提示自己确认 daemon 在跑。

## 命令参考

> 每个子命令的完整参数、返回与示例（create / list / outline / page / grep / generate / update / batch-update / add-page / delete-page / reorder / preview / lint / export）见 [`references/command-reference.md`](references/command-reference.md)。

## 方法路由

| 目标 | CLI 命令 |
|------|---------|
| 列出演示文稿 | `tabtin slide list` |
| 按关键词搜幻灯片内容 | `tabtin slide grep --project-id <id> --query "<关键词>"`（有搜索词时必须用它，别用 `outline` 逐页翻冒充 search；支持 `--page-id` 限定单页、`--element-types` 限定元素类型、`--max-results` 控制返回数） |
| 查看单页详情 | `tabtin slide page --project-id <id> --page-id <id>` |
| 查看大纲（页面结构） | `tabtin slide outline --project-id <id>` |

## 资源导航（按需读取）

- `references/command-reference.md`：当你需要查具体 flag、返回字段、命令差异（如 update vs batch-update）时读取；常见流程先按本文件「典型工作流」走。

## 生成 HTML 前必读

`tabtin slide create --html` / `tabtin slide add-page --html` 会把 HTML 转成可编辑的 PPTElement，但**不是所有 HTML 都能转**。生成前请记住这两条契约：

1. **白名单内的 HTML 模式** → 转成可编辑 PPTElement（用户能拖、能改文字、能改色）
   - 文字：`<p>` / `<h1-6>` / `<div>` / `<span>` / `<li>`
   - 形状：`<div>` 含 `background` / `border` / `box-shadow` / `border-radius`
   - 渐变：仅 `linear-gradient`（多 stop、含 alpha）
   - 图片：`<img>` 或 `background-image: url()`；**真实图片（截图/产品图/logo）先下载到本地再以 `data:image/*;base64` 内嵌**，图数据才会落到 slide 自己的存储、不掉图（别只贴第三方外链，别用文字/色块假装）
   - SVG：`<svg>` 整块 → image
   - 图表：ECharts / Chart.js / Plotly `<canvas>` → image；图表容器必须显式声明非零 `width` / `height`，初始化后在布局完成时调用 `chart.resize()`
   - 表格：`<table>` → 原生 table（不是图片）

2. **白名单外的视觉** → 必须用 `<div data-tabslide-rasterize>...</div>` 包起来，整块截图为 image
   - **Font Awesome 图标**（dom_extractor 会把 `<i class="fa-*">` 隐藏，直接写不会出现在 PPT 里）
   - 径向渐变、毛玻璃、`clip-path`、`mask`、`mix-blend-mode`
   - 复杂 SVG 装饰、含动画 / 滤镜的 SVG
   - 任何"拿不准能不能识别"的复杂视觉

详细规范、对照表、模板见 `skills_read("app:tabslide/html-spec")`，**生成 HTML 前必须先加载**。

## 典型工作流

### 生成 PPT（当前版本主流程：render 一步直出本地 pptx，不留云项目）

1. `skills_read("app:tabslide/html-spec")` 加载 HTML 规范，
   `skills_read("app:tabslide/design-guide")` 加载设计规范——**两个都必读**
2. **按 design-guide 的主题模板库写 HTML**（选一套主题，复制页型骨架只改内容；
   不要从零手写 CSS）。每页内容严格控制在 1280×720 内，宁可拆页也不要塞满。
   **容量预算**（超出必拆页）：单页卡片网格最多 2 行×3 列；每卡标题≤8 字、说明≤28 字；
   单页正文合计建议 ≤60 字；禁止靠缩小字号硬塞。
3. `tabtin slide render --html "@./deck.html" --save-to artifacts/<名称>.pptx`
   —— 一步完成渲染 → 导出 → 下载落地 → 删除临时云项目。
   **默认拦截 `html_overflow`（severity=error，越界 >24px）**：撑破时 render **拒绝导出**
   （exit≠0），必须改 HTML / 拆页后重跑。禁止用 `--allow-html-overflow` 交付（仅本地调试）。
4. **检查 render 输出的 `lint_problems` / 错误 detail**：
   - `html_overflow` error → **必须**精简 / 拆页后重新 render
   - `html_overflow` warning（微量越界）→ 建议修，不阻断导出
   - `html_clipped_text` → 有裁字样例时按页精简
   - `out_of_canvas`（抽取后元素越界）→ 精简文字 / 调整布局后重新 render
   - `sparse_page_bottom`（下半页大面积空白）→ 用主题骨架的 `*-body` flex 撑满版心
   - 其他 warning 酌情处理
5. `present_to_user({summary:"演示文稿", items:[{kind:"local_file", relative_path:"artifacts/<名称>.pptx"}]})` 发布成聊天文件卡片交付
6. 用户要改内容 → 改 HTML → 重新 `render` 覆盖同名文件 → 再用 `present_to_user` local_file 发布（**不要**引导打开编辑器）

### 编辑已有云演示文稿（仅当上下文已注入 slide_id / 历史项目时）

以下命令面向**已存在的云项目**。当前版本**不要**为新的 PPT 需求主动创建云项目——新需求走上面的 `render`。

0. **先确认元素类型**（用 `grep` / `page` 看返回的 `type`）——决定能不能 `update`：
   - `type: "text"` → 文字真存在结构里，用 `update --patch '{"props":{"content":"<p>...</p>"}}'` 改
   - `type: "image"` → ⚠️ 文字已被栅格化进 PNG，`update` 改 `props.content` 改不动（图里画的不是 DOM 文字）。要换文案就**重新生成整页 HTML**：写新 HTML → `tabtin slide delete-page` 旧页 → `tabtin slide add-page --html @./slide.html` 追加新页；只有明确要覆盖整份 deck 时才用 `tabtin slide generate --replace`
   - `type: "shape"` 含 `props.text` → 用 `update --patch '{"props":{"text":{"content":"<p>...</p>"}}}'` 改
1. **先定位**：知道要改什么文字时 → `tabtin slide grep --project-id <id> --query '<片段>'` 一次拿到 page_id + element_id + type；不知道目标时 → `tabtin slide outline --project-id <id>` 先看结构
2. `tabtin slide page --project-id <id> --page-id <id>` 查看目标页上下文（确认元素 props、相邻关系）
3. `tabtin slide update/batch-update ...` 修改元素（按第 0 步分流，别对 image 强行 update props.content）
4. `tabtin slide preview --project-id <id>` 验证效果
5. `tabtin slide export --project-id <id> --save-to artifacts/<名称>.pptx` 导出本地文件，再 `present_to_user` 的 `local_file` item 发布（用户侧交付物始终是本地 `.pptx`，不是应用内可编辑项目）

### 页面管理

- 新增: `tabtin slide add-page --project-id <id>`
- 删除: `tabtin slide delete-page --project-id <id> --page-id <id>`
- 排序: `tabtin slide reorder --project-id <id> id1 id2 id3`

## 设计与 HTML 规范

生成 HTML 前，必须加载 TabSlide App 级设计规范：

- `skills_read("app:tabslide/html-spec")` — HTML 容器结构、可用组件、配色变量、页面模板
- `skills_read("app:tabslide/design-guide")` — 视觉设计原则、布局策略、质量检查清单

## 效率规则

- **搜索走 `slide grep`，不要用 outline 逐页翻冒充**：用户说「找 / 搜 / 查一下 XX 文字/元素」时必须走 `tabtin slide grep --project-id <id> --query "<关键词>"`——它是专门的全文本搜索端点（`/slide/grep`，不区分大小写、不需正则），一次拿到 page_id + element_id + type + 匹配上下文。`outline` 只看页面标题结构、不搜元素正文内容，不要用它冒充搜索。需要限定范围时加 `--page-id`（单页）或 `--element-types`（元素类型），控制返回数加 `--max-results`。
- 上下文已注入 `slide_id` 和 `title` 时，直接使用，不要重复查询
- 修改多页内容前先 `outline` 了解全部页面，一次性规划再逐页执行
- 新建演示文稿按封面、目录、内容、总结结构生成
- HTML 始终先写入工作目录文件，再通过 `--html "@./deck.html"` 读取，避免 shell 管道在不同系统上转换文本编码
- 生成后先 `preview` 截图确认，再 `lint` 诊断问题
