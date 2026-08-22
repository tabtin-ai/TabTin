---
name: project-status-brief
description: >
  项目状态简报——收集 TabData 任务、TabDoc 文档、
  TabMemo 记录，整理风险与下一步，输出一页项目简报。
  用户要求"项目现在怎么样""给老板写进展""整理风险和下一步"时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: productivity
    displayName: "项目状态简报"
    tags:
      - project
      - status
      - risk
      - management
      - tabdata
      - tabdoc
      - tabmemo
    tools:
      - run_terminal_command
---

# 项目状态简报

生成给团队、老板或客户看的项目进展简报。重点是事实、风险、决策和下一步，不写流水账，也不替用户改任务状态。

## 先读

- `references/workflow.md`：项目范围确认、材料收集、健康度判断、写入分支。
- `references/tooling.md`：TabDoc、TabMemo、TabData、TabSlide 的使用边界。
- `references/templates.md`：状态 brief、健康度口径、输出回执模板。

## 适用场景

- 用户询问项目进展、风险、阻塞、需要决策的事项。
- 用户希望从任务表、项目文档或笔记整理管理层简报。
- 用户需要把项目状态转成 TabDoc 或后续演示材料。

## 必须遵守

- 没有明确项目、任务表、字段或周期时先问，不猜表结构。
- 健康度判断必须说明依据，不能只给红黄绿结论。
- 更新任务状态、负责人、截止日期前必须列出影响记录并等待确认。
- 需要生成幻灯片时，按 TabSlide builtin skill 读取规范，不能指导用户安装 Playwright/Chromium。

## 主流程

1. 确认项目范围、受众、周期、可读取来源和是否需要持久化。
2. 收集事实，按进度、时间、风险、决策四类信号判断健康度。
3. 输出 brief 草稿，并列出缺失信息和建议动作。
4. 用户确认后写入 TabDoc；表格更新和 slide 生成都作为独立确认分支。

## 输出承诺

完成后回复应包含：项目状态、判断依据、关键风险、需要决策、行动项、文档链接或草稿状态。
