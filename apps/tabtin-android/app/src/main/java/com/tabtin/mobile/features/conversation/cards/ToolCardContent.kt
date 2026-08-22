package com.tabtin.mobile.features.conversation.cards

import androidx.compose.runtime.Composable
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType

private val TERMINAL_TOOLS = setOf(
    "bash", "terminal_execute", "execute_command", "shell", "run_command",
)
private val SSH_TOOLS = setOf("ssh", "ssh_execute", "remote_execute")
private val DIFF_TOOLS = setOf(
    "file_edit", "apply_diff", "edit_file", "str_replace_editor", "patch",
)
private val FILE_READ_TOOLS = setOf("file_read", "read_file", "cat_file", "view_file")
private val FILE_WRITE_TOOLS = setOf("file_write", "write_file", "create_file")
private val SQL_TOOLS = setOf("execute_sql", "sql_execute", "query_sql", "run_sql")
private val WEB_SEARCH_TOOLS = setOf("web_search", "search_web", "google_search")
private val CODE_SEARCH_TOOLS = setOf(
    "code_search", "grep", "ripgrep", "search_code", "find_code",
    "semantic_search", "glob",
)
private val RECORD_TOOLS = setOf(
    "create_record", "update_record", "delete_record",
    "batch_create_records", "batch_update_records", "batch_delete_records",
)

@Composable
internal fun ToolCardContent(step: AgentStep) {
    if (step.type != StepType.TOOL_CALL) return
    if (step.status == StepStatus.RUNNING && step.input.isNullOrBlank() && step.output.isNullOrBlank()) {
        LoadingPlaceholderView(lines = 2)
        return
    }

    // **W2 L10**：FAILED 状态优先走 file pipeline 13 类 i18n 渲染——把
    // envelope JSON 里的 error_kind 解析后查 strings_chat.xml 中文短文案，
    // 命中显示中文、未命中降级到 GenericToolCardView 走原 KeyValuePairs 渲染
    // （兜底 LLM 转述路径）。
    if (step.status == StepStatus.FAILED && !step.output.isNullOrBlank()) {
        val rendered = ToolErrorOverlayView(step)
        if (rendered) return
    }

    val name = step.name.lowercase()
    when {
        name in TERMINAL_TOOLS || name in SSH_TOOLS -> TerminalCardView(step, isSsh = name in SSH_TOOLS)
        name in DIFF_TOOLS -> DiffCardView(step)
        name in FILE_READ_TOOLS -> FileReadCardView(step)
        name in FILE_WRITE_TOOLS -> FileWriteCardView(step)
        name in SQL_TOOLS -> SqlResultCardView(step)
        name in WEB_SEARCH_TOOLS -> WebSearchCardView(step)
        name in CODE_SEARCH_TOOLS -> CodeSearchCardView(step)
        name in RECORD_TOOLS -> RecordOpCardView(step)
        else -> GenericToolCardView(step)
    }
}

internal fun parseJson(raw: String?): org.json.JSONObject? = try {
    raw?.trim()?.takeIf { it.startsWith("{") }?.let { org.json.JSONObject(it) }
} catch (_: Exception) { null }
