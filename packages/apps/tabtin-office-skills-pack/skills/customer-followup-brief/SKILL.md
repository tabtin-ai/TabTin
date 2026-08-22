---
name: customer-followup-brief
description: >
  客户跟进简报——整合沟通记录、TabDoc、TabData 的客户信息，
  生成客户简报，写入下一步动作。用户提到客户、商机、
  续约、回访、客户会议、下一步推进时使用。
metadata:
  version: "0.1.0"
  tabtin:
    category: sales_crm
    displayName: "客户跟进简报"
    tags:
      - customer
      - sales
      - follow-up
      - crm
      - tabdoc
      - tabdata
    tools:
      - run_terminal_command
---

# 客户跟进简报

把客户上下文整理成一页可行动 brief，帮助销售、BD、客户成功或项目经理快速进入下一次沟通。重点是事实、风险、承诺和下一步。

## 先读

- `references/workflow.md`：客户材料收集、简报生成、跟进写入、邮件草稿分支。
- `references/tooling.md`：沟通来源、TabDoc、TabData、Tracker 的使用边界。
- `references/templates.md`：客户 brief、跟进表字段、邮件草稿模板。

## 适用场景

- 用户要求整理某个客户、商机、续约、回访或客户会议上下文。
- 用户要会前 brief、续约风险、下一步推进建议。
- 用户希望把客户邮件、会议纪要和表格记录合并成可执行计划。

## 必须遵守

- 客户数据可能包含合同、报价、隐私和商业敏感信息，持久化前必须确认范围。
- 没有明确客户表或字段时先问用户，不猜 CRM schema。
- 邮件只起草，不默认发送。
- 建议和风险必须标明依据；没有依据时写“待确认”。

## 主流程

1. 确认客户名、目标受众、沟通场景和可读取来源。
2. 汇总最近沟通、当前诉求、我方承诺、风险与下一步。
3. 给用户预览 brief 和邮件草稿。
4. 用户确认后写入 TabDoc，并按需更新客户跟进表或 Tracker。

## 输出承诺

完成后回复应包含：客户 brief 链接或草稿、下一步动作、主要风险、来源覆盖情况和待确认缺口。
