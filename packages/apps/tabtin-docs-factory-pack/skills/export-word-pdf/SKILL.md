---
name: export-word-pdf
description: >
  导出 Word/PDF——把 Space 文档或草稿导出为可外发的 DOCX/PDF。用户说"导出 Word""生成 PDF""给客户发文档"时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: writing
    displayName: "导出 Word / PDF"
    tags:
      - export
      - docx
      - pdf
      - files
    tools:
      - run_terminal_command
---

# 导出 Word / PDF

优先复用平台文件生成能力与已有文档内容，不重新编造正文。

## 必须遵守

- 确认源文档、目标格式、是否含敏感信息。
- 导出失败时保留 Markdown 草稿并说明缺什么运行时。
- 不指导用户安装未批准的本机办公套件作为唯一路径。

## 主流程

1. 定位源内容 → 2. 确认版式要求 → 3. 调用生成/导出 → 4. 返回文件位置与注意事项。
