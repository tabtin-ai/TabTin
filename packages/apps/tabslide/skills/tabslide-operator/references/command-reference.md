# TabSlide Operator · 命令参考

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

### render - HTML 直出本地 PPTX（当前版本主命令）

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide render --html "@./deck.html" --save-to ./季度汇报.pptx
tabtin slide render --html "@./季度汇报.html" -o 汇报.pptx
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--html` | string | 是 | — | HTML 内容（支持 `@file` 或 `-` 从 stdin 读取） |
| `--save-to` / `-o` | string | 是 | — | 输出 PPTX 文件路径（推荐 workspace 相对路径） |
| `--name` | string | 否 | 取 `--save-to` 文件名 | 演示名称（写入 PPTX 元数据） |
| `--canvas-width` | int | 否 | `1280` | 画布宽度（与 html-spec `.ppt-slide` 一致，勿随意改） |
| `--canvas-height` | int | 否 | `720` | 画布高度（同上；HTML→JSON→PPT 全程 1:1 坐标） |
| `--allow-html-overflow` | bool | 否 | `false` | 允许 HTML 撑破画布仍导出（**交付勿用**；仅调试） |

一步完成：创建临时渲染项目 → HTML 布局 lint + structural lint → 导出 PPTX → 下载落盘 →
**删除临时项目**。全程不产生用户可见的云演示文稿。输出字段：

| 字段 | 说明 |
|------|------|
| `path` / `page_count` / `size_bytes` | 产物信息 |
| `lint_summary` / `lint_problems` | 质量检查；**`html_overflow` = HTML 撑破 1280×720（默认阻断导出）**；`out_of_canvas` = 抽取后元素越界 |
| `next_step` | 现成的 `present_to_user({summary:"...", items:[{kind:"local_file", relative_path:"..."}]})` 发布提示 |

生成 ≠ 发布：文件落地后必须再调 `present_to_user` 才会在聊天里出现卡片。

### create - 创建演示文稿（云项目；当前版本不要为新需求使用）

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide create --name '<名称>' [--preset ppt] [--canvas-width 1920] [--canvas-height 1080]
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--name` | string | 否 | — | 演示文稿名称 |
| `--preset` | string | 否 | `ppt` | 预设类型 |
| `--canvas-width` | int | 否 | `1920` | 画布宽度 |
| `--canvas-height` | int | 否 | `1080` | 画布高度 |

返回 `project_id`，后续命令均需此 ID。

### list - 列出演示文稿

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide list
```

列出当前 Agent 可见的所有演示文稿。

### outline - 查看大纲

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide outline --project-id <project_id>
```

返回所有页面列表及元素摘要，用于了解整体结构。

### page - 查看单页详情

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide page --project-id <project_id> --page-id <page_id>
```

返回指定页面的完整内容，包括所有元素及其属性。

### grep - 全文本搜索

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide grep --project-id <project_id> --query '<子串>' [--page-id <id>] [--element-types <types>] [--max-results 50]
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--project-id` | string | 是 | — | 项目 ID |
| `--query` | string | 是 | — | 要搜的子串（**大小写不敏感**，不需正则） |
| `--page-id` | string | 否 | — | 限制搜索单页 |
| `--element-types` | string | 否 | `text,shape` | 元素类型，逗号分隔或 JSON 数组 |
| `--max-results` | int | 否 | `50` | 最多返回多少条匹配（达上限即停） |

**搜索范围**：text 元素的 `props.content`（HTML 剥标签后）+ shape 元素的 `props.text.content`。

**返回**：每条 match 含 `page_id` + `element_id` + `content_excerpt`（匹配处前后各 40 字符，带 `…`），让 Agent **直接 `slide update` 改**，不用再 outline / page 翻找。

#### 用例

```bash
# 找特定文字在哪页/哪个元素
tabtin slide grep --project-id $PID --query "季度营收"

# 限制单页（已知大概在哪页时更快）
tabtin slide grep --project-id $PID --query "Primary" --page-id page-3

# 只搜 text 元素（跳过 shape 的内嵌文字）
tabtin slide grep --project-id $PID --query "总结" --element-types text
```

### generate - 从 HTML 覆盖整份演示文稿

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide generate --project-id <project_id> --replace --html '<html_content>'
tabtin slide generate --project-id <project_id> --replace --html "@./deck.html"
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--project-id` | string | 是 | — | 项目 ID |
| `--html` | string | 否 | — | HTML 内容（也支持 stdin 管道） |
| `--title` | string | 否 | — | 标题 |
| `--mode` | string | 否 | `direct` | 生成模式 |
| `--replace` | bool | 非空项目必填 | `false` | 明确允许覆盖项目全部页面 |

`generate` 是覆盖语义，不用于给已有演示文稿插页。插入新页请用 `tabtin slide add-page --project-id <id> --html "@./slide.html"`。

HTML 始终先写入工作目录文件，再通过 `--html "@./slide.html"` 读取；文件内容不会占用命令行参数长度，也能避免 shell 管道转换文本编码。

### update - 更新单个元素

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide update --project-id <id> --page-id <id> --element-id <id> --patch '<json>'
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--project-id` | string | 是 | 项目 ID |
| `--page-id` | string | 是 | 页面 ID |
| `--element-id` | string | 是 | 元素 ID |
| `--patch` | string | 是 | 更新数据 JSON（schema 见下） |
| `--base-version` | int | 否 | 基础版本（CAS 乐观锁） |

#### Patch schema（**必读**——写错会被 400 拒绝）

**顶层只允许 PPTElement 结构字段 + `props`**：

| 类别 | 允许的顶层字段 |
|------|--------------|
| 必填 | `id`、`type` |
| 几何 | `x`、`y`、`width`、`height`、`rotate` |
| 视觉 | `opacity`、`flipH`、`flipV` |
| 交互 | `locked`、`visible`、`zIndex`、`link` |
| 组合 | `groupId`、`groupName`、`name` |
| 内容 | **`props`**（所有"内容"字段必须嵌入 props 内） |

**所有内容字段（content/src/fill/gradient/outline/shadow/color/fontSize/...）必须放 `props` 里**——这是平台通用规则，对全部 10 种元素类型（text/image/shape/line/chart/table/...）都成立。

| ❌ 错误（顶层写内容字段，会被 400 拒绝） | ✅ 正确（嵌入 props） |
|------|------|
| `{"content":"<p>x</p>"}` | `{"props":{"content":"<p>x</p>"}}` |
| `{"src":"https://x/y.png"}` | `{"props":{"src":"https://x/y.png"}}` |
| `{"fill":"#FF0000"}` | `{"props":{"fill":"#FF0000"}}` |
| `{"color":"#FF0000"}` | `{"props":{"defaultColor":"#FF0000"}}` |
| `{"text":"Hi"}` | `{"props":{"content":"<p>Hi</p>"}}` |

#### 示例

```bash
# 改文字内容（text 元素的 content 是 HTML 富文本字符串）
tabtin slide update --project-id $PID --page-id $PG --element-id $EID \
  --patch '{"props":{"content":"<p><span style=\"color:#FFF;font-size:48pt\">新标题</span></p>"}}'

# 改位置和尺寸（直接顶层）
tabtin slide update --project-id $PID --page-id $PG --element-id $EID \
  --patch '{"x":100,"y":200,"width":800,"height":450}'

# 改图片源
tabtin slide update --project-id $PID --page-id $PG --element-id $EID \
  --patch '{"props":{"src":"https://example.com/new.png"}}'

# 改形状填充色 + 透明度（混合）
tabtin slide update --project-id $PID --page-id $PG --element-id $EID \
  --patch '{"opacity":0.8,"props":{"fill":"#2563EB"}}'
```

#### 错误响应（patch schema 不合法时）

```json
{
  "success": false,
  "code": "PATCH_SCHEMA_INVALID",
  "message": "patch schema invalid: content: ... Did you mean 'props.content'?",
  "data": {
    "validation_errors": [
      {"field": "content", "hint": "unknown top-level key; element content fields belong inside `props`. Did you mean 'props.content'?"}
    ]
  }
}
```

按 `hint` 指引把字段嵌入 `props` 重试即可。

### batch-update - 批量修改元素

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide batch-update --project-id <id> --updates '<json_array>'
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--project-id` | string | 是 | 项目 ID |
| `--updates` | string | 是 | 更新数组 JSON：`[{page_id, element_id, patch}, ...]` |
| `--base-version` | int | 否 | 基线版本号（CAS 乐观锁） |

每条 `patch` 用跟 `update` 命令相同的 schema（内容字段必须嵌入 `props`）。任何一条 patch schema 不合法 → 整批拒绝并返回每条错误清单，**不会部分成功**。

```bash
tabtin slide batch-update --project-id $PID --updates '[
  {"page_id":"pg_001","element_id":"el_001","patch":{"props":{"content":"<p>新标题</p>"}}},
  {"page_id":"pg_001","element_id":"el_002","patch":{"x":100,"y":200,"width":800}},
  {"page_id":"pg_001","element_id":"el_003","patch":{"props":{"fill":"#FF0000"}}}
]'
```

一次修改多个元素时优先使用此命令，减少请求次数。

### add-page - 添加页面

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide add-page --project-id <project_id>
tabtin slide add-page --project-id <project_id> --after-page page-3
tabtin slide add-page --project-id <project_id> --html "@./slide.html"
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--project-id` | string | 是 | 项目 ID |
| `--page-id` | string | 否 | 页面 ID（默认自动生成） |
| `--html` | string | 否 | HTML 内容；支持 `@file` 或 `-` 从 stdin 读取 |
| `--file` | file | 否 | HTML 文件路径；与 `--html` 互斥 |
| `--title` | string | 否 | HTML 生成页标题 |
| `--mode` | string | 否 | HTML 生成模式，默认 `direct` |
| `--background` | string | 否 | 背景样式 |
| `--after-page` | string | 否 | 插入到该 page-id 之后；不传则末尾新增 |
| `--page-order` | string | 否 | 高级用法：完整页面顺序 JSON 数组 |

`--html` / `--file` 会把 HTML 转为新页面并追加到现有演示文稿，不会删除旧页面。显式传入的 `--page-id` 如果已存在会报错；不要依赖自动改名。

### delete-page - 删除页面

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide delete-page --project-id <project_id> --page-id <page_id>
```

高风险操作，不可撤销。

### reorder - 页面排序

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide reorder --project-id <project_id> --page-order '["id1","id2","id3"]'
tabtin slide reorder --project-id <project_id> id1 id2 id3
```

支持 `--page-order` JSON 数组或位置参数两种传参方式。

### preview - 预览截图

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide preview --project-id <project_id> [--page-id <page_id>] [--response-format url]
```

不指定 `--page-id` 时预览全部页面。默认返回截图 URL。

### lint - 质量检查

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide lint --project-id <project_id> [--page-id <page_id>] [--problems-only]
tabtin slide lint --project-id <id> --skip-visual --min-severity warning  # 高频自检模式（毫秒级）
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `--page-id` | string | 只检查单页 |
| `--problems-only` | bool | 仅显示 error / warning（过滤 info） |
| `--min-severity` | string | 最低严重级别：`error` / `warning` / `info` |
| `--skip-visual` | bool | 跳过 Playwright 视觉 lint，只跑 structural（**毫秒级**，适合 Agent 频繁自检） |

**两类检查**：

| 类别 | 包含规则 | 耗时 |
|------|---------|------|
| **structural**（毫秒级） | 重复 id、内容字段错位、shape 无视觉、image src 无效、负宽高、未注册字体、image 占比过高、text 内容空/超长 | 单页 < 10ms |
| **visual**（秒级，可 `--skip-visual` 跳过） | 元素出画、文字溢出、字号过小、零尺寸、重叠 > 50%、稀疏布局、对比度不足（WCAG） | 单页 ~ 1-2s |

返回 `summary: {errors, warnings, infos}` 让 Agent 一眼看到优先级；每个 problem 含 `page_id` / `element_id` 方便 update 精准定位。

**典型用法**：
- 改完元素后立刻自检：`tabtin slide lint --project-id X --skip-visual --min-severity warning` (< 100ms)
- 导出前完整检查：`tabtin slide lint --project-id X --problems-only`

### export - 导出

**运行时**：桌面端 / Daemon（命令需要本地 cli-server 路由）

```bash
tabtin slide export --project-id <project_id> [--format pptx]
```

| 格式 | 说明 |
|------|------|
| `pptx` | PowerPoint（默认） |
| `pdf` | PDF 文档 |
| `png` | PNG 图片（逐页） |
| `jpg` | JPEG 图片（逐页） |
