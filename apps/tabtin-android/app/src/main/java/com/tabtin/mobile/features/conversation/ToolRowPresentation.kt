package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import com.tabtin.mobile.R
import java.net.URI
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 时间线 / 审批标题共用的工具行呈现：本地化动词 + Lucide 图标名 + 摘要字段类型。
 *
 * 覆盖面与 iOS `ToolPresentation.of` 对齐（~120 显式名 + device + tab* 前缀规则），
 * 未知工具一律回落 [R.string.chat_tool_verb_generic]，永不把 raw 工具名、snake_case
 * 或 `toolu_…` 当作行标题。
 */
internal data class ToolRowPresentation(
    @StringRes val labelResId: Int,
    val lucideIcon: String,
    val summaryKind: SummaryKind,
) {
    enum class SummaryKind { COMMAND, PATH, QUERY, URL, SQL, GENERIC, NONE }

    /**
     * 从 input JSON 抽出「对象」：basename / 命令首段 / host / SQL 关键字等。
     * 模型 `description|summary|title` 不在这里处理——那是整行标题，由 [timelineLabel] 优先。
     */
    fun timelineDetail(inputJson: String?, toolName: String = ""): String? {
        val formatted = when (summaryKind) {
            SummaryKind.COMMAND -> firstString(inputJson, CMD_KEYS)?.let(::formatCommand)
            SummaryKind.PATH -> firstString(inputJson, PATH_KEYS)?.let(::basename)
            SummaryKind.QUERY -> firstString(inputJson, QUERY_KEYS + PATTERN_KEYS)?.let(::truncateQuery)
            SummaryKind.URL -> firstString(inputJson, URL_KEYS)?.let(::hostOnly)
            SummaryKind.SQL -> firstString(inputJson, SQL_KEYS)?.let(::formatSql)
            SummaryKind.GENERIC -> firstUsefulDetail(inputJson)
            SummaryKind.NONE -> null
        }
        if (!formatted.isNullOrBlank()) return formatted
        return mcpServerDetail(toolName)
    }

    companion object {
        private val PATH_KEYS = listOf("path", "file_path", "filePath", "filename", "file", "target_file")
        private val CMD_KEYS = listOf("command", "cmd", "script")
        private val QUERY_KEYS = listOf("query", "q", "search_term", "keyword")
        private val PATTERN_KEYS = listOf("pattern", "regex", "glob")
        private val URL_KEYS = listOf("url", "uri", "link")
        private val SQL_KEYS = listOf("sql", "statement")
        private val GENERIC_KEYS = listOf(
            "table", "table_id", "record_id", "title", "name", "id", "resource_id",
            "content", "text", "question", "prompt", "task", "memory_id",
        ) + PATH_KEYS + CMD_KEYS + QUERY_KEYS + PATTERN_KEYS + URL_KEYS + SQL_KEYS

        private val CD_PREFIX = Regex("""^(cd\s+\S+\s*&&\s*)+""", RegexOption.IGNORE_CASE)
        private val WS = Regex("""\s+""")

        private val parser = Json { ignoreUnknownKeys = true; isLenient = true }

        private val GENERIC = ToolRowPresentation(
            labelResId = R.string.chat_tool_verb_generic,
            lucideIcon = "Wrench",
            summaryKind = SummaryKind.GENERIC,
        )

        fun of(name: String): ToolRowPresentation {
            val normalized = name.trim().lowercase()
            if (normalized.isEmpty()) return GENERIC

            explicitPresentation(normalized)?.let { return it }
            devicePresentation(normalized)?.let { return it }
            tabAppPresentation(normalized)?.let { return it }
            if (normalized.contains("record") || normalized.contains("table")) {
                return ToolRowPresentation(
                    labelResId = R.string.chat_tool_verb_generic,
                    lucideIcon = "Database",
                    summaryKind = SummaryKind.GENERIC,
                )
            }
            return GENERIC
        }

        /**
         * 1. 模型 description/summary/title 原样胜出，不追加 ` · detail`
         * 2. 有对象则 `动词 · 对象`
         * 3. 否则只有动词
         * 4. 永不回落 raw 工具名
         */
        fun timelineLabel(name: String, inputJson: String?, verb: String): String {
            val description = ExecutionStepPresentation.toolDescription(inputJson)
            if (description != null) return description
            val detail = of(name).timelineDetail(inputJson, name)
            return if (!detail.isNullOrBlank()) "$verb · $detail" else verb
        }

        fun timelineLabel(name: String, inputJson: String?, resolveVerb: (Int) -> String): String =
            timelineLabel(name, inputJson, resolveVerb(of(name).labelResId))

        fun timelineDetail(name: String, inputJson: String?): String? =
            of(name).timelineDetail(inputJson, name)

        @StringRes
        fun cardFieldLabelResId(key: String): Int? = when (key) {
            "file_path", "path", "filePath", "filename", "file", "target_file" ->
                R.string.chat_card_field_file
            "command", "cmd", "script" -> R.string.chat_approval_field_command
            "query", "q", "search_term", "keyword" -> R.string.chat_approval_field_query
            "url", "uri", "link" -> R.string.chat_card_field_url
            "sql", "statement" -> R.string.chat_card_field_sql
            "pattern", "regex", "glob" -> R.string.chat_card_field_pattern
            else -> null
        }

        private fun explicitPresentation(name: String): ToolRowPresentation? = when (name) {
            "bash", "shell", "execute_command", "terminal_execute", "run_command",
            "run_terminal_command", "execute_in_terminal", "exec_command",
            "write_stdin", "read_thread_terminal", "terminal_open", "terminal_write",
            "terminal_read", "terminal_list",
            -> row(R.string.chat_tool_verb_terminal, "Terminal", SummaryKind.COMMAND)

            "ssh", "ssh_execute", "remote_execute" ->
                row(R.string.chat_tool_verb_ssh, "Server", SummaryKind.COMMAND)

            "file_read", "read_file", "read", "document_read", "parse_document",
            "cat_file", "view_file",
            -> row(R.string.chat_tool_verb_read_file, "FileText", SummaryKind.PATH)

            "file_write", "write_file", "create_file", "write" ->
                row(R.string.chat_tool_verb_write_file, "FileText", SummaryKind.PATH)

            "file_edit", "apply_diff", "edit_file", "edit", "multiedit",
            "apply_patch", "str_replace", "str_replace_editor", "patch",
            -> row(R.string.chat_tool_verb_edit_file, "FilePenLine", SummaryKind.PATH)

            "file_delete", "delete_file", "remove_file", "rm_file" ->
                row(R.string.chat_tool_verb_delete_file, "FileX2", SummaryKind.PATH)

            "execute_sql", "sql_execute", "sql_query", "table_query",
            "query_sql", "run_sql",
            -> row(R.string.chat_tool_verb_sql, "Database", SummaryKind.SQL)

            "web_search", "search", "websearch", "search_web", "google_search" ->
                row(R.string.chat_tool_verb_web_search, "Search", SummaryKind.QUERY)

            "web_fetch", "fetch_url", "webfetch", "browse_url", "tabs_info" ->
                row(R.string.chat_tool_verb_web_fetch, "Globe", SummaryKind.URL)

            "grep", "glob", "code_search", "semantic_search", "code_grep",
            "greptool", "globtool", "searchfiles", "code_glob",
            "code_semantic_search", "list_files", "skills_read", "skills_search",
            "rag_search", "memory_search", "ripgrep", "search_code", "find_code",
            -> row(R.string.chat_tool_verb_code_search, "Search", SummaryKind.GENERIC)

            "git_status" -> row(R.string.chat_tool_verb_git_status, "GitBranch", SummaryKind.PATH)
            "git_diff" -> row(R.string.chat_tool_verb_git_diff, "GitCompare", SummaryKind.PATH)

            "todo_read", "todo_write" ->
                row(R.string.chat_tool_verb_todo, "CheckCircle2", SummaryKind.NONE)

            "task", "dispatch", "dispatch_agent", "delegate_task", "subagent",
            "subagent_run", "agent",
            -> row(R.string.chat_tool_verb_subagent, "Bot", SummaryKind.GENERIC)

            "ask_user", "ask_form", "request_approval" ->
                row(R.string.chat_tool_verb_ask_user, "HelpCircle", SummaryKind.GENERIC)

            "memory_write" ->
                row(R.string.chat_tool_verb_memory_write, "NotebookPen", SummaryKind.GENERIC)
            "memory_delete" ->
                row(R.string.chat_tool_verb_memory_delete, "Trash2", SummaryKind.GENERIC)

            "show_widget" ->
                row(R.string.chat_tool_verb_show_widget, "LayoutTemplate", SummaryKind.GENERIC)
            "present_to_user" ->
                row(R.string.chat_tool_verb_present, "Sparkles", SummaryKind.GENERIC)

            else -> null
        }

        private fun devicePresentation(name: String): ToolRowPresentation? {
            val (resId, icon) = when (name) {
                "get_device_info" -> R.string.chat_tool_verb_device_info to "Smartphone"
                "get_battery_info" -> R.string.chat_tool_verb_battery to "Battery"
                "get_network_info" -> R.string.chat_tool_verb_network to "Wifi"
                "read_contacts", "search_contacts" -> R.string.chat_tool_verb_contacts to "ContactRound"
                "read_sms" -> R.string.chat_tool_verb_read_sms to "MessageSquare"
                "send_sms" -> R.string.chat_tool_verb_send_sms to "Send"
                "read_call_log" -> R.string.chat_tool_verb_call_log to "Phone"
                "make_call" -> R.string.chat_tool_verb_make_call to "PhoneCall"
                "read_calendar" -> R.string.chat_tool_verb_calendar to "Calendar"
                "read_notifications" -> R.string.chat_tool_verb_notifications to "Bell"
                "list_installed_apps" -> R.string.chat_tool_verb_app_list to "AppWindow"
                "read_media" -> R.string.chat_tool_verb_media to "Images"
                "get_location" -> R.string.chat_tool_verb_location to "MapPin"
                "screen_capture" -> R.string.chat_tool_verb_screen_capture to "ScanLine"
                "screen_snapshot" -> R.string.chat_tool_verb_screen_snapshot to "MonitorSmartphone"
                "screen_ui_tree" -> R.string.chat_tool_verb_ui_tree to "Network"
                "screen_tap", "screen_tap_area", "screen_tap_element" ->
                    R.string.chat_tool_verb_screen_tap to "MousePointerClick"
                "screen_swipe" -> R.string.chat_tool_verb_screen_swipe to "MoveHorizontal"
                "screen_long_press", "screen_long_press_element" ->
                    R.string.chat_tool_verb_screen_long_press to "Hand"
                "screen_find_element", "screen_get_context" ->
                    R.string.chat_tool_verb_find_element to "Search"
                "screen_type_in_element", "screen_type_text" ->
                    R.string.chat_tool_verb_type_text to "Keyboard"
                "screen_type_secret" -> R.string.chat_tool_verb_type_secret to "Lock"
                "screen_key_event" -> R.string.chat_tool_verb_key_event to "Command"
                "screen_wait_for_idle", "screen_wait_for_element" ->
                    R.string.chat_tool_verb_wait_ui to "Hourglass"
                "screen_open_app", "screen_launch_app" ->
                    R.string.chat_tool_verb_open_app to "AppWindow"
                "screen_force_stop" -> R.string.chat_tool_verb_stop_app to "Square"
                "set_system_setting", "get_system_setting" ->
                    R.string.chat_tool_verb_system_setting to "Settings"
                "set_stealth_mode" -> R.string.chat_tool_verb_stealth to "EyeOff"
                "launch_intent" -> R.string.chat_tool_verb_launch_intent to "ExternalLink"
                "save_to_device" -> R.string.chat_tool_verb_save_device to "HardDriveDownload"
                "get_automation_status" -> R.string.chat_tool_verb_automation to "Activity"
                else -> return null
            }
            return row(resId, icon, SummaryKind.GENERIC)
        }

        private fun tabAppPresentation(name: String): ToolRowPresentation? {
            if (!name.startsWith("tab")) return null
            return when {
                name.contains("search") || name.contains("_get_") || name.contains("_list_") ->
                    row(R.string.chat_tool_verb_tab_search, "Search", SummaryKind.GENERIC)
                name.contains("delete") || name.contains("archive") || name.contains("trash") ->
                    row(R.string.chat_tool_verb_tab_remove, "Trash2", SummaryKind.GENERIC)
                name.contains("restore") || name.contains("rollback") ->
                    row(R.string.chat_tool_verb_tab_restore, "RefreshCw", SummaryKind.GENERIC)
                name.contains("create") || name.contains("insert") || name.contains("add_") ->
                    row(R.string.chat_tool_verb_tab_create, "PlusCircle", SummaryKind.GENERIC)
                name.contains("update") || name.contains("edit") || name.contains("write") ->
                    row(R.string.chat_tool_verb_tab_update, "FilePenLine", SummaryKind.GENERIC)
                name.contains("publish") || name.contains("share") || name.contains("grant") ->
                    row(R.string.chat_tool_verb_tab_publish, "Sparkles", SummaryKind.GENERIC)
                name.startsWith("tabdoc_") ->
                    row(R.string.chat_tool_verb_tab_doc, "FileText", SummaryKind.GENERIC)
                name.startsWith("tabmemo_") ->
                    row(R.string.chat_tool_verb_tab_memo, "FileText", SummaryKind.GENERIC)
                name.startsWith("tabsite_") ->
                    row(R.string.chat_tool_verb_tab_site, "Globe", SummaryKind.GENERIC)
                name.startsWith("tabdata_") ->
                    row(R.string.chat_tool_verb_tab_data, "Database", SummaryKind.GENERIC)
                else -> GENERIC
            }
        }

        private fun row(
            @StringRes labelResId: Int,
            lucideIcon: String,
            summaryKind: SummaryKind,
        ) = ToolRowPresentation(labelResId, lucideIcon, summaryKind)

        private fun firstUsefulDetail(inputJson: String?): String? {
            val objects = inputObjects(inputJson) ?: return null
            for (obj in objects) {
                for (key in GENERIC_KEYS) {
                    val raw = stringValue(obj, key) ?: continue
                    val formatted = when (key) {
                        in PATH_KEYS -> basename(raw)
                        in CMD_KEYS -> formatCommand(raw)
                        in QUERY_KEYS, in PATTERN_KEYS -> truncateQuery(raw)
                        in URL_KEYS -> hostOnly(raw)
                        in SQL_KEYS -> formatSql(raw)
                        else -> raw.take(40).trim().takeIf { it.isNotEmpty() }
                    }
                    if (!formatted.isNullOrBlank()) return formatted
                }
            }
            return null
        }

        private fun firstString(inputJson: String?, keys: List<String>): String? {
            val objects = inputObjects(inputJson) ?: return null
            for (obj in objects) {
                for (key in keys) {
                    stringValue(obj, key)?.let { return it }
                }
            }
            return null
        }

        private fun stringValue(obj: JsonObject, key: String): String? {
            val primitive = obj[key] as? JsonPrimitive ?: return null
            val value = primitive.content.trim()
            return value.takeIf { it.isNotEmpty() && it != "null" }
        }

        private fun inputObjects(inputJson: String?): List<JsonObject>? {
            val raw = inputJson?.trim()?.takeIf { it.startsWith("{") } ?: return null
            val root = runCatching { parser.parseToJsonElement(raw) as? JsonObject }
                .getOrNull() ?: return null
            return buildList {
                add(root)
                for (nested in listOf("kwargs", "args", "input")) {
                    (root[nested] as? JsonObject)?.let { add(it) }
                }
            }
        }

        private fun formatCommand(raw: String): String? {
            val stripped = raw.trim().replace(CD_PREFIX, "").trim()
            val first = stripped.split(WS).firstOrNull()?.takeIf { it.isNotEmpty() } ?: return null
            return first.take(40)
        }

        private fun basename(path: String): String? {
            val trimmed = path.trim().trimEnd('/', '\\')
            if (trimmed.isEmpty()) return null
            val name = trimmed.substringAfterLast('/').substringAfterLast('\\')
            return name.ifEmpty { trimmed }.take(40)
        }

        private fun truncateQuery(raw: String): String? =
            raw.trim().takeIf { it.isNotEmpty() }?.take(30)

        private fun hostOnly(raw: String): String? {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return null
            return try {
                val scheme = trimmed.substringBefore(':', missingDelimiterValue = "")
                val withScheme = if (scheme.isNotEmpty() && scheme.all { it.isLetter() }) {
                    trimmed
                } else {
                    "https://$trimmed"
                }
                URI(withScheme).host?.takeIf { it.isNotBlank() } ?: trimmed.take(40)
            } catch (_: Exception) {
                trimmed.take(40)
            }
        }

        private fun formatSql(raw: String): String? {
            val tokens = raw.trim().split(WS).filter { it.isNotEmpty() }
            if (tokens.isEmpty()) return null
            val keyword = tokens.first().uppercase().trimEnd(';')
            val tableHint = setOf("FROM", "INTO", "UPDATE", "TABLE")
            val table = tokens.withIndex().firstOrNull { (_, token) ->
                token.uppercase().trimEnd(';') in tableHint
            }?.let { tokens.getOrNull(it.index + 1) }
                ?.trim(',', ';', '`', '"', '\'')
                ?.takeIf { it.isNotEmpty() }
            return if (table != null) "$keyword $table".take(40) else keyword.take(40)
        }

        private fun mcpServerDetail(toolName: String): String? {
            val parts = toolName.trim().split("__")
            if (parts.size >= 3 && parts[0].equals("mcp", ignoreCase = true)) {
                return parts[1].takeIf { it.isNotBlank() }
            }
            return null
        }
    }
}
