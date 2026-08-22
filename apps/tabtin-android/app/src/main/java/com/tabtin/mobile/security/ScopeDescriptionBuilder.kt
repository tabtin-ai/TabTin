package com.tabtin.mobile.security

/**
 * 生成"已记忆授权"展示用的人话描述。
 *
 * 跨端 SSoT 来自 `packages/security-policy/src/scope-descriptions.ts`（中文 hardcode 模板）。
 * Android 端本期与 TS 端**完全等价**：均只输出中文，多语言留 L-W6-31 后续 wave。
 *
 * 用法：always-allow 路径写 memo entry 时，在 `decisions[]` 上行字段里附带本函数生成
 * 的 `scope_description` —— 后端 `approval_memo_service.upsert_entry` 收存进 PG，
 * 设置页"已记忆的授权"列表直接展示，避免显示
 * `execute_command::rm:workspace-internal` 这种技术 key（L-W6-30 P0 修复点）。
 *
 * **设计取舍**：移动端不实现 `exact:hash16` 模板分支——always-allow UI 只暴露 scoped
 * 粒度（"模式记忆"），不暴露"精确粒度"，所以 scope 入参只可能是
 * `workspace-internal` / `workspace-external` / `*`。
 */
internal object ScopeDescriptionBuilder {

    /**
     * 按 toolName + scope 渲染人话描述。
     *
     * @param toolName 工具注册名（如 `execute_command` / `read_file` / `mcp_call_tool`）
     * @param subcmd 子命令；shell 类为命令首 token，其他类型可空字符串或 `_`
     * @param scope pattern_key 中的 scope 段
     *   （`workspace-internal` / `workspace-external` / `*` / `exact`；`exact` 走非通配分支）
     */
    internal fun build(toolName: String, subcmd: String, scope: String): String {
        val s = subcmd.trim()
        val effectiveSubcmd = if (s.isEmpty() || s == "_") "" else s

        return when (toolName) {
            "execute_command" -> when {
                scope == "*" -> "执行任意 shell 命令"
                effectiveSubcmd.isEmpty() -> "执行 shell 命令"
                else -> "执行 shell 命令 $effectiveSubcmd"
            }
            "read_file" -> if (scope == "*") "读取任意文件" else "读取文件"
            "write_file" -> if (scope == "*") "写入任意文件" else "写入文件"
            "list_directory" -> "列出目录内容"
            "mcp_call_tool" -> if (effectiveSubcmd.isEmpty()) "调用 MCP 工具" else "调用 MCP 工具 $effectiveSubcmd"
            "tabdoc_read" -> "读取文档"
            "tabdoc_write" -> "编辑文档"
            "tabdoc_create" -> "创建文档"
            "tabdoc_delete" -> "删除文档"
            "tabdata_read" -> "读取表格数据"
            "tabdata_write" -> "写入表格数据"
            "tabdata_create" -> "创建数据表"
            "tabdata_delete" -> "删除数据表"
            "memory_read" -> "读取记忆"
            "memory_write" -> "写入记忆"
            "memory_delete" -> "删除记忆"
            "device_action" -> if (effectiveSubcmd.isEmpty()) "执行设备操作" else "设备操作 $effectiveSubcmd"
            "search_files" -> "搜索文件"
            "apply_patch" -> "应用代码补丁"
            "str_replace" -> "编辑文件内容"
            else -> {
                val display = toolName.replace('_', ' ')
                if (effectiveSubcmd.isEmpty()) display else "$display $effectiveSubcmd"
            }
        }
    }
}
