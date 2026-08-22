---
name: build-spreadsheet
description: >
  生成数据表文件——从对话或 TabData 生成带结构/公式的表格文件。用户要 Excel/CSV 交付件时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: analysis
    displayName: "生成数据表文件"
    tags:
      - xlsx
      - spreadsheet
      - analysis
      - tabdata
    tools:
      - run_terminal_command
---

# 生成数据表文件

把结构化数据变成可下载表格，公式与字段含义要可解释。

## 必须遵守

- 字段名与样例行先预览。
- 不捏造业务数字；缺失标待确认。
- 能落 TabData 时询问是否同时建表。
