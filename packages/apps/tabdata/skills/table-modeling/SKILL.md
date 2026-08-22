---
name: table-modeling
description: >
  多维表建模——设计表结构、决策单表或双表 link、规划字段并创建关联表。
  用户已有字段清单，或提到关联表格、一对多、主表+明细、电影+演员、
  商品+SKU、订单+明细时调用。网页采集并落表的整链改走
  app:tabdata/collect-to-table，本 skill 只负责数据形态。
metadata:
  version: 0.3.0
  tabtin:
    category: data
    displayName: "Table Modeling"
    autoActivateFor:
      - tabdata
    tools:
      - run_terminal_command
---

# Table Modeling

这份 SKILL 只回答两个问题：**该建一张表还是两张表？字段怎么挑？**
所有执行统一走 `tabtin table` CLI。

## 一、先确认交付范围

| 交付范围 | 完成标准 |
|---|---|
| 只创建结构 | 真正建表并拿到 `table_id`；明确本次写入 0 条业务数据 |
| 创建结构并写入数据 | 建表后写入；以回执里的成功 / 失败条数为准 |

字段值只允许来自可靠来源或确定性换算。来源没有的字段留空、设为可选，或不创建；
不要为了表格看起来完整而估算或编造。

## 二、两种产品形态

| 形态 | 适合场景 | 不适合 |
|---|---|---|
| **单表** | 一条记录的内容主要是标量；相关清单只需当文本展示 | 子项要独立查询、去重、复用或反向查 |
| **双表 + link** | 子项是独立实体，需要跨主记录复用、单独查询或反向查 | 用户只要临时扫一眼的简单清单 |

同表内的任务/子任务、部门层级等树形关系走 `tabtin table sub-record *`，不要拆成跨表关联。

### 人话解释

- link：「在这一格挂上另一张表的一行或多行，点一下能跳过去看。」
- 双向 link：「电影挂了演员后，演员那边也会出现『参演电影』，两边都能反查。」

## 三、决策规则

1. 用户明确要简单、扁平、临时使用，或字段都是单实体标量：建单表。
2. 同一个子项会出现在多条主记录里，或用户需要从子项反查主项：建双表 + link。
3. 子项只是附属明细、不需要独立查询：把摘要放在 `long_text`，或按业务需要拆成双表；不要创建已下线字段。
4. 需求含糊且两种形态会明显改变使用方式时，只问一次：更在意一张表快速浏览，还是两张表互相跳转和反查？

## 四、执行顺序

双表形态固定按以下顺序：

1. 先建被关联的表。
2. 再建主表。
3. 用 `tabtin table link create` 创建关联字段。
4. 子表按业务键 `record upsert` 去重。
5. 重拉子表，建立「业务键 → record_id」映射。
6. 主表写 link 值：`[{"id":"<目标 record UUID>"}]`。
7. 用 `link list` 或记录详情读回核对。

具体命令

- `references/form-recipes.md`：单表、双表 link 和同表树形配方
- `examples/form-c-douban-walkthrough.md`：电影 + 演员双表完整示例
- `scripts/build-record-index.sh`：建立业务键到 record_id 的索引
- `skills_read("app:tabdata/table-association")`：挂、解绑、查询关联边
- `skills_read("app:tabdata/table-import-export")`：批量写入和导入导出

## 五、完成后的复述

双表完成后，用产品语言告诉用户：

- 两张表分别叫什么、各有多少条记录；
- 哪一列可以点开跳转；
- 反向关联列在哪里；
- 哪些字段因没有可靠来源而留空。

## 六、常见反模式

| 反模式 | 正确做法 |
|---|---|
| 用 select 保存会变化的外部实体 | 改成双表 + link |
| link 值写显示名 | 先取得目标 record_id，再写 `[{"id":"..."}]` |
| 先建主表，导致目标表 id 不存在 | 先建被关联表，再建主表和 link |
| 为去重先 DELETE 再 INSERT | 用 `record upsert --upsert-on` |
| 建完双表只说“完成了” | 说明两张表如何跳转和反查 |

## 七、原则

- TabData 建模、建表、写入和查询全程走 CLI。
- 形态决策完成后再执行，不把已下线字段写进 schema。
- 没有读回证据，不宣称创建或写入成功。
