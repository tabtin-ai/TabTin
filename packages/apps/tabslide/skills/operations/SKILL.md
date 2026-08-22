---
name: operations
description: >
  TabSlide 命令操作——创建、编辑、预览、导出演示文稿的完整
  CLI 命令参考。
metadata:
  version: 0.2.0
  tabtin:
    category: doc
    displayName: "TabSlide CLI 操作手册"
    autoActivateFor: [tabslide]
    tools:
      - run_terminal_command
---

# TabSlide CLI 操作手册

所有命令通过 `run_terminal_command` 执行 `tabtin slide` CLI。

## 操作流程

0. **创建项目** → `tabtin slide create --name '<名称>'` 创建新演示文稿（返回 project_id）
1. **查看大纲** → `tabtin slide outline --project-id <project_id>` 获取页面列表和元素摘要
2. **查看单页** → `tabtin slide page --project-id <project_id> --page-id <page_id>` 查看完整页面内容
3. **编辑元素** → `tabtin slide update --project-id <id> --page-id <id> --element-id <id> --patch '<json>'` 修改属性
4. **从 HTML 覆盖生成** → `tabtin slide generate --project-id <project_id> --replace --html "@./deck.html"` 用 HTML 重新生成整份演示文稿（会替换全部旧页面）
5. **新增页面** → `tabtin slide add-page --project-id <project_id>` 新建空白页；`tabtin slide add-page --project-id <project_id> --html "@./slide.html"` 从 HTML 追加新页
6. **删除页面** → `tabtin slide delete-page --project-id <project_id> --page-id <page_id>`
7. **页面排序** → `tabtin slide reorder --project-id <project_id> id1 id2 id3`
8. **预览截图** → `tabtin slide preview --project-id <project_id> [--page-id <page_id>]`
9. **质量检查** → `tabtin slide lint --project-id <project_id> [--page-id <page_id>]`
10. **导出** → `tabtin slide export --project-id <project_id>`

## 生成策略

- **已有演示文稿**（上下文中有 slide_id）→ 用 `tabtin slide add-page --project-id <slide_id> --html "@./slide.html"` 追加新页面
- **没有演示文稿**（上下文中 slide_id 为空）→ 用 `tabtin slide create --name '<名称>' --html "@./slide.html"` 创建新演示文稿
- **覆盖整份演示文稿** → 只有用户明确要求重生成/替换全部页面时，才使用 `tabtin slide generate --project-id <slide_id> --replace`
- HTML 始终先写入工作目录文件，再用 `--html "@./file.html"` 传入，避免命令行参数超限和 shell 文本编码转换
- 生成或追加后用 `tabtin slide preview` 截图检查效果，发现问题用 `tabtin slide lint` 诊断
- 生成 HTML 前，先用 `skills_read("app:tabslide/html-spec")` 加载 HTML 规范
- **长 HTML / 解析慢时**：同时加 `wait_ms: 0` 立刻返回 `session_id` + `pid` + `output_file`；进度用 `read_file(path=output_file)`（path 取 envelope 返回值，不要假设路径），想中途取消用 `run_terminal_command` 跑 `kill <pid>`；任务完成时会收到 push 通知激活下一轮 turn。

## 批量操作

- 修改多页内容前先 `tabtin slide outline` 了解全部页面结构
- 一次性规划所有修改再逐页执行，避免反复查询
- 新建演示文稿时按 封面 → 目录 → 内容 → 总结 的结构生成

## 效率规则

- 上下文已注入当前演示文稿信息（slide_id、title）→ 不要重复查询
- 修改前先确认目标幻灯片 ID，不要盲猜
