/**
 * scope-descriptions.ts — 审批记忆 scope_description 模板库（F.4）
 *
 * SSoT：Electron 直接 import；iOS/Android W5 时 codegen 为 JSON。
 */

interface Template {
  /** 模板函数；scope 为 pattern_key 中的 scope 段 */
  render: (subcmd: string, scope: string) => string;
}

const TEMPLATES: Record<string, Template> = {
  run_terminal_command: {
    render: (subcmd, scope) =>
      scope === '*'
        ? `执行任意 shell 命令`
        : subcmd
          ? `执行 shell 命令 ${subcmd}`
          : `执行 shell 命令`,
  },
  read_file: {
    render: (_subcmd, scope) =>
      scope === '*' ? '读取任意文件' : '读取文件',
  },
  write_file: {
    render: (_subcmd, scope) =>
      scope === '*' ? '写入任意文件' : '写入文件',
  },
  mcp_call_tool: {
    render: (subcmd) =>
      subcmd ? `调用 MCP 工具 ${subcmd}` : '调用 MCP 工具',
  },
  tabdoc_read: { render: () => '读取文档' },
  tabdoc_write: { render: () => '编辑文档' },
  tabdoc_create: { render: () => '创建文档' },
  tabdoc_delete: { render: () => '删除文档' },
  tabdata_read: { render: () => '读取表格数据' },
  tabdata_write: { render: () => '写入表格数据' },
  tabdata_create: { render: () => '创建数据表' },
  tabdata_delete: { render: () => '删除数据表' },
  memory_read: { render: () => '读取记忆' },
  memory_write: { render: () => '写入记忆' },
  memory_delete: { render: () => '删除记忆' },
  device_action: {
    render: (subcmd) =>
      subcmd && subcmd !== '_'
        ? `设备操作 ${subcmd}`
        : '执行设备操作',
  },
  search_files: { render: () => '搜索文件' },
  apply_patch: { render: () => '应用代码补丁' },
  str_replace: { render: () => '编辑文件内容' },
};

/**
 * 生成人话 scope_description，用于审批记忆 UI 展示。
 *
 * @param toolName 工具注册名
 * @param subcmd 子命令（shell 类为首 token；其他可空串）
 * @param scope pattern_key 的 scope 段（exact:xxx / workspace-internal / *）
 * @param _locale 预留多语言（当前仅中文）
 */
export function buildScopeDescription(
  toolName: string,
  subcmd: string,
  scope: string,
  _locale?: string,
): string {
  const tpl = TEMPLATES[toolName];
  if (tpl) {
    return tpl.render(subcmd, scope);
  }
  const display = toolName.replace(/_/g, ' ');
  return subcmd && subcmd !== '_'
    ? `${display} ${subcmd}`
    : display;
}
