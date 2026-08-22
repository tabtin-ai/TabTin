# widget vs present_to_user vs TabData/TabDoc 决策树

`show_widget`、`present_to_user` 和 TabData / TabDoc / TabSlide 三者覆盖**完全不同的需求**。先按下面的判定走，再决定调哪个工具。

## 一、互补关系总览

| 维度 | `present_to_user` | `show_widget` | TabData / TabDoc / TabSlide |
|---|---|---|---|
| 内容形式 | 4 类预定义结构化 kind | 自由 SVG / HTML(no-script) / Mermaid | 持久化 App 资源 |
| 表达力 | 受 schema 约束 | 几乎无限 | 取决于 App 的能力 |
| 持久化 | 卡片可点开、可下载 | 一次性视觉（不跳转 App） | 长期可编辑的资源 |
| 移动端 | 各 kind 各自实现 | 走预渲染图片 fallback | 各 App 自己处理 |
| 适合 | 表格 / 图片 / 文件引用 | 示意图 / 流程图 / 数据图 / Mockup | 长期协作产物 |

## 二、判定步骤（按顺序问自己）

### 1. 用户最后是要"长期编辑 / 复用 / 共享"吗？

→ **是**：用 TabData（数据表）/ TabDoc（文档）。这些是**有 App 承载**的产物，能被检索、被多人编辑、跨 Space 引用。
→ **演示 / PPT / 幻灯片**：当前版本 TabSlide App UI 已隐藏，走 `tabslide-operator` skill 生成并 `export --output` 交付**本地 `.pptx` 文件**（不是应用内可编辑项目）。
→ **否**：进入第 2 步。

### 2. 内容是不是 4 类预定义 kind 之一？

| kind | 适合 |
|---|---|
| `image` | 已有 https URL 的图片 / 截图 / 海报 |
| `table_preview` | 列名固定、行数有限的二维表 |
| `resource_ref` | 引用一个已有 TabData 行 / TabDoc 段 / TabSlide 页 / Resource，让用户点开跳转 |
| `file` | 单个文件（PDF / 任意上传） |

→ **能落到任何一类**：用 `present_to_user`，把内容套进对应 schema。
→ **落不进**：进入第 3 步。

> **TabData 数据呈现的边界**：用户问"看下 Q3 销售表" → 数据**本身**展示用 `table_preview`；用户问"Q3 哪个区域增长最快 / Q3 vs Q2 趋势" → 要的是从数据**得出的洞察 / 对比 / 趋势** → 用 widget 画图。判断要点：用户要的是"原数据" 还是"分析结论"。

### 3. 内容是不是"自由示意图 / 状态图 / 流程图 / 数据图 / 几何图 / UI mockup"？

→ **是**：用 `show_widget`。流程/ER/时序优先 Mermaid；页面 mockup / stepper / card layout 可用 HTML(no-script)；像素级自定义图用 SVG。
→ **不是**：很可能你**不需要画图**——一两段文字回答就够了。

## 三、widget 适合的典型场景

| # | 场景 | 为什么 widget |
|---|---|---|
| 1 | 用户问 "Kubernetes 三层架构是怎样的" | 文字说不清空间关系 |
| 2 | 用户让对比 git rebase 和 merge | 两张分支演化图比文字清楚 10 倍 |
| 3 | 解释一个数学公式（正弦波 / 向量分解） | 几何示意必须是图 |
| 4 | 用户问 "用户购买流程是怎样的" | Mermaid flowchart token 成本低 |
| 5 | 用户让设计一个新页面 | HTML(no-script) UI mockup 比手写 SVG 快 |
| 6 | Agent 完成长任务后总结 "我做了什么" | 流程图比 list 直观 |
| 7 | TabData 里数据 + 用户问 "Q3 哪个区域增长最快" | 柱状对比图 |
| 8 | 给用户出方案 A/B/C 对比卡 | 三栏对比图 |

## 四、widget 不适合（反例）

| 场景 | 不适合的原因 | 该怎么做 |
|---|---|---|
| 已经有图片 URL 要给用户看 | 重画一张是浪费 | `present_to_user.image` |
| 二维表数据展示 | SVG 画表格 = 噩梦 | `present_to_user.table_preview` |
| 让用户点开看一个 TabDoc 段落 | widget 不能跳转 App | `present_to_user.resource_ref` |
| 上传一个 PDF 让用户下载 | 不是 widget 的事 | `present_to_user.file` |
| 装饰性图（"很厉害的封面"） | widget 是承载信息的 | 别画 |
| 一句话能讲清的简单事实（今天周几 / 天气 / 某变量值） | 多此一举，反而干扰 | 直接文字答 |
| 用户上传 PDF / 文档让总结 | LLM 容易冲动画"内容结构图"，但用户要的是文字总结 | 直接文字答；除非用户明确要"流程图 / 结构图"形式 |
| 数据量大（几百行）的可视化 | SVG token 爆炸 | TabData + 图表 / 桌面工具 |
| 想做"按月/按周切换"的动态图 | widget 不支持内部状态切换 | 不要用 sendPrompt 假装 tab；sendPrompt 只用于发起新一轮对话 |
| 想嵌入实时数据 | widget 是静态 SVG | TabData 的实时视图 |

## 五、组合用法

widget 经常和其他工具搭着用：

- **widget + present_to_user**：先画一张架构图（widget），再给一个跳转到 TabDoc 详细文档的 resource_ref（present_to_user）
- **widget + ask_user**：方案对比图（widget）+ 让用户在 2-4 个选项中选 A/B/C 的结构化问题（`ask_user` — W4 / 2026-05-11 单工具合一形态，多选问答 HITL）

### 多 widget 同组（`group_id` / `group_title`）

用同一 `group_id` 把多张图捆成一组（例：对比 v1 / v2 架构、git rebase vs merge 两张分支演化图）。UI 会把同组 widget 串起来显示。

判定一张 SVG 装下还是拆多张：

| 选 | 怎么判 |
|---|---|
| **一张 SVG 内分栏** | 同维度多列对比（≤ 3 列），同坐标系 / 同图例 / 视觉等价 |
| **多张 widget + 同 `group_id`** | 演化对比（v1 → v2）、对照实验（A/B 流程显著不同）、各自独立图例 / 坐标系 |

示例：

```text
// 第 1 张
show_widget({ summary: "git rebase: 把分支线性化...",
              format: "svg", code: "<svg ...>...</svg>",
              group_id: "rebase-vs-merge", group_title: "git rebase vs merge" })

// 第 2 张（同 group_id / 同 group_title）
show_widget({ summary: "git merge: 保留分叉历史...",
              format: "svg", code: "<svg ...>...</svg>",
              group_id: "rebase-vs-merge", group_title: "git rebase vs merge" })
```

`group_id` 任意稳定字符串（同一对话用同一值即可，不必 UUID）；`group_title` 在每张图都填同一值（容器层只显示一次）。

## 六、与 `ask_user` / TabSlide 的区分

- **`ask_user`**（W4 / 2026-05-11 单工具合一形态，多选问答 HITL）：你**主动暂停**等用户回答（HITL），是阻塞型决策入口。让用户在 2-4 个选项中选（每个选项需要 label + description），可同时问 1-4 个问题，自动注入 "Other" 让用户自由输入。widget 不是问问题。
- **演示 / PPT**：多页幻灯片。如果用户说"做一个产品介绍 PPT"——那是 `tabslide-operator` skill 生成的**本地 `.pptx` 文件**，不是 widget（widget 只是单张一次性图）。当前版本 TabSlide App UI 已隐藏，交付物是工作目录里的本地文件，不引导打开编辑器。

> 决定要画之后，CSP / iframe sandbox / 视觉规范 / 流式行为见 [`sandbox.md`](./sandbox.md)。
