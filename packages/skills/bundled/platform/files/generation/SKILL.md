---
name: file-generation
description: >
  生成办公文件——在当前工作目录生成 Office / PDF
  文件（xlsx / docx / pptx / pdf；用户说 ppt 时按
  pptx 处理）并发布成聊天卡片。用户要"导出 / 生成
  Excel 表格、Word 文档、PPT 演示、PDF 报告""做一份报表
  / 合同 / 周报文件""把这些数据存成 xlsx"时激活。
metadata:
  version: 0.1.0
  tabtin:
    category: productivity
    autoActivateFor: []
    tags:
      - file
      - xlsx
      - docx
      - ppt
      - pptx
      - pdf
      - office
      - export
    tools:
      - run_terminal_command
      - present_to_user
---

# 文件生成与读取（Office / PDF）

围绕 **xlsx / docx / pptx / pdf** 的两类能力，都由随 CLI 分发的 `tabtin file` 完成
（客户端无需 Python）：
- **生成** `tabtin file create`：从 JSON spec 生成文件，再用 `present_to_user` 的 `local_file` item 发布成卡片。
- **读取** `tabtin file read`：抽取已有 office/pdf 文件的内容（输出 JSON）。

## 首要原则：优先 `tabtin file`

处理这四类文件**必须首选 `tabtin file`**——生成用 `create`、读取用 `read`。它随 CLI
分发、客户端无需任何运行时、中文不乱码，是默认且推荐路径。

用户说“PPT / 幻灯片 / 演示文稿”时，默认生成现代 Office 格式 **`.pptx`**；不要生成旧
`.ppt` 二进制格式。

> **PPT 分流边界（重要）**：需要**设计感 / 复杂版式 / 精美封面**的演示，优先用
> `tabslide-operator` skill 的 HTML 渲染引擎生成并 `export --output` 落地本地 `.pptx`
> （质量更高）。本 skill 的 `tabtin file create -t pptx` 适合**简单数据罗列型**
> deck（标题 + 要点 + 表格），或 `tabslide-operator` 不可用时的稳定兜底。两条路
> 交付物都是工作目录内的本地 `.pptx`，都不打开应用内编辑器。

**只有当 `tabtin file` 确实无法满足需求时**（如：所需类型不在 `tabtin file list-types`
里、spec 表达不了要的版式、或读取需要 `read` 输出之外的结构），才考虑其他方式；
改用前先确认 `tabtin file` 真覆盖不了（`list-types` / `schema --type <t>` 核对），
并在回复里说明为什么退而求其次。

**读这四类二进制文件别用 `read_file`**（会得到乱码）——一律走 `tabtin file read`。

## 边界（先读）

- **spec 由你（Agent）直接生成，禁止用 Python / Node 等脚本去拼 JSON 或生成文件**。
  `tabtin file` 的全部意义就是让你**不依赖任何运行时（Python/Node）**也能产出 office/pdf——
  你是 LLM，JSON spec 直接写出来即可。**绝不**为了拼 spec 或生成文件去 `write_file` 一个
  `.py`/`.js` 再 `run_terminal_command` 跑它（那等于把 Python 依赖请回来，违背初衷）。
- **只产出最终文件，不要落任何中间文件**：spec 经 **stdin** 直接喂进命令——
  `echo '<json>' | tabtin file create … --spec -`（推荐），或字面量 `--spec '<json>'`。
  **不要**先 `write_file` 写一个 `spec.json` 再 `--spec @spec.json`——那会在工作目录留下
  多余文件。工作目录里应当只多出你要交付的那个 office/pdf。
- **生成走 `tabtin file create`（终端命令），不要用 `write_file` 写二进制 office/pdf**——
  手写的 .xlsx/.docx/.pptx/.pdf 会损坏打不开。
- **生成 ≠ 发布**：`tabtin file create` 只把文件写到工作目录；要在聊天里出现卡片，
  必须再调 `present_to_user` 的 `local_file` item（传相对工作目录根的路径，如 `artifacts/report.xlsx`；不要加 `workspace/` 前缀）。
- **发布卡片 ≠ 保存到云盘**：`present_to_user` 的 `local_file` item 只发本地产物卡片，**不会**写入 Space 云盘。
  用户要「保存/归档到云盘」时，必须再调 `tabtin drive upload <path>` 或
  `tabtin drive upload-folder <dir>`（见 `platform:files/cloud-drive` /
  `tabfiles-operator`）。只 present_to_user local_file 会导致画布打开空白或「文件不存在」。
- 路径用工作目录内的相对路径（如 `artifacts/report.xlsx`），不要用绝对路径。
- 每种类型的 spec 字段不同——动手前先 `tabtin file schema --type <t>` 看结构，别猜。

## 标准流程

1. 发现能力（可选）：

```bash
tabtin file list-types                 # 支持哪些类型（JSON 数组）
tabtin file schema --type xlsx         # 某类型的 JSON spec 结构
```

2. 生成文件（spec 经 stdin `-` 直接喂入，不落中间文件）：

```bash
echo '{"sheets":[{"name":"销售","header":["名称","数量"],"rows":[["苹果",3]]}]}' \
  | tabtin file create --type xlsx --save-to artifacts/report.xlsx --spec -
```

`--type` 省略时按 `--save-to` 扩展名推断（短参 `-o` 等价）。成功输出 envelope，`data` 含
`path` / `file_type` / `file_size` / **`next_step`**（机器可读：应调用的
`present_to_user({summary:"...", items:[{kind:"local_file", relative_path:"..."}]})`）；非 JSON 格式还会多一行 `NEXT_STEP: ...`。
失败时 stderr 是 `{"error":{"code","message"}}` 且退出码非零（`spec_error` /
`unsupported_type` → 校验类错误，先用 `tabtin file schema` 核对 spec）。

3. **立刻**发布成卡片（不要等用户追问）：

```python
present_to_user({
  "summary": "生成的报表文件",
  "items": [{"kind": "local_file", "relative_path": "artifacts/report.xlsx"}],
})
```

`next_step` / `NEXT_STEP` 里的路径就是 `--save-to` 相对路径，直接照抄即可。

## 读取已有文件

读懂用户已有的 office/pdf（**不要对这些二进制用 `read_file`**），用 `tabtin file read`，
输出 JSON 到 stdout：

```bash
tabtin file read --type xlsx --input data.xlsx   # --type 省略时按扩展名推断
tabtin file read -i report.pdf
```

各类型 read 输出形状：
- xlsx：`{"file_type":"xlsx","sheets":[{"name","rows":[[...]]}]}`
- docx：`{"file_type":"docx","paragraphs":[...],"tables":[{"rows":[[...]]}],"text":"…"}`
- pptx：`{"file_type":"pptx","slides":[{"text":"…"}],"text":"…"}`
- pdf：`{"file_type":"pdf","pages":[{"text":"…"}],"text":"…"}`

支持读哪些类型看 `tabtin file list-types`（每项带 `can_read`）。

## 各类型 spec（以 `tabtin file schema --type <t>` 为准）

### xlsx — 表格

```json
{
  "sheets": [
    {
      "name": "Sheet1",
      "columns": [{"width": 20}],
      "header": ["列A", "列B"],
      "rows": [["甲", 1], ["乙", 2]]
    }
  ]
}
```

数字/布尔在 `rows` 里保留原类型（Excel 存为真实数值）；`header` 加粗，`columns.width`
可选。

### docx / pdf — 文档（共用 block 模型）

```json
{
  "title": "文档标题",
  "blocks": [
    {"type": "heading", "level": 1, "text": "第一章"},
    {"type": "paragraph", "text": "正文段落，支持中文。"},
    {"type": "list", "ordered": false, "items": ["项目一", "项目二"]},
    {"type": "table", "header": ["列A", "列B"], "rows": [["甲", "乙"]]}
  ]
}
```

pdf 自动折行/分页，中文用内置 CID 字体渲染（不乱码）。

### pptx — 演示

```json
{
  "slides": [
    {"title": "标题页", "subtitle": "副标题"},
    {"title": "要点", "bullets": ["一", "二", "三"]},
    {"title": "数据", "table": {"header": ["名", "值"], "rows": [["甲", 1]]}}
  ]
}
```

一页只用 `bullets`、`table`、`subtitle` 之一即可（按优先级 table > bullets > 标题页）。

## 失败时怎么办

- `spec_error`：spec 字段或 JSON 格式不对——`tabtin file schema --type <t>` 对照修正。
- `unsupported_type`：类型不支持——`tabtin file list-types` 看清单。
- 找不到 `tabtin file` / 生成器不可用：环境未装好该能力，告诉用户"当前环境暂不支持
  本地文件生成"，不要静默改用 `write_file` 写二进制。
