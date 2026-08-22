package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 时间线工具行：动词 + Lucide 图标 + `标签 · 对象` 口径。
 * 不依赖 Compose / Context，动词用资源 id 或测试注入的中文短语断言。
 */
class ToolRowPresentationTest {

    @Test
    fun `mapped families return expected label and lucide icon`() {
        assertFamily("execute_command", R.string.chat_tool_verb_terminal, "Terminal")
        assertFamily("BASH", R.string.chat_tool_verb_terminal, "Terminal")
        assertFamily("ssh_execute", R.string.chat_tool_verb_ssh, "Server")
        assertFamily("Write", R.string.chat_tool_verb_write_file, "FileText")
        assertFamily("apply_patch", R.string.chat_tool_verb_edit_file, "FilePenLine")
        assertFamily("delete_file", R.string.chat_tool_verb_delete_file, "FileX2")
        assertFamily("sql_query", R.string.chat_tool_verb_sql, "Database")
        assertFamily("web_fetch", R.string.chat_tool_verb_web_fetch, "Globe")
        assertFamily("Task", R.string.chat_tool_verb_subagent, "Bot")
        assertFamily("ask_user", R.string.chat_tool_verb_ask_user, "HelpCircle")
        assertFamily("todo_write", R.string.chat_tool_verb_todo, "CheckCircle2")
        assertFamily("memory_write", R.string.chat_tool_verb_memory_write, "NotebookPen")
        assertFamily("screen_capture", R.string.chat_tool_verb_screen_capture, "ScanLine")
        assertFamily("screen_type_secret", R.string.chat_tool_verb_type_secret, "Lock")
        assertFamily("tabmemo_create_memo", R.string.chat_tool_verb_tab_create, "PlusCircle")
        assertFamily("tabsite_publish_site", R.string.chat_tool_verb_tab_publish, "Sparkles")
        assertFamily("tabdoc_update_block", R.string.chat_tool_verb_tab_update, "FilePenLine")
        assertFamily("tabdoc_list_documents", R.string.chat_tool_verb_tab_search, "Search")
    }

    @Test
    fun `web_search and code_search use distinct verb keys`() {
        assertEquals(
            R.string.chat_tool_verb_web_search,
            ToolRowPresentation.of("web_search").labelResId,
        )
        assertEquals(
            R.string.chat_tool_verb_code_search,
            ToolRowPresentation.of("code_search").labelResId,
        )
        assertEquals("Search", ToolRowPresentation.of("web_search").lucideIcon)
        assertEquals("Search", ToolRowPresentation.of("code_search").lucideIcon)
    }

    @Test
    fun `write_file path becomes basename after verb`() {
        val input = """{"path":"/Users/me/report.docx"}"""
        val presentation = ToolRowPresentation.of("write_file")
        assertEquals(R.string.chat_tool_verb_write_file, presentation.labelResId)
        assertEquals("report.docx", presentation.timelineDetail(input, "write_file"))

        val label = ToolRowPresentation.timelineLabel("write_file", input, "写入文件")
        assertTrue(label.contains("写入文件"))
        assertTrue(label.contains("report.docx"))
        assertTrue(label.contains(" · "))
    }

    @Test
    fun `model description wins and does not append path`() {
        val input = """{"path":"/Users/me/report.docx","description":"写一份周报"}"""
        val label = ToolRowPresentation.timelineLabel("write_file", input, "写入文件")
        assertEquals("写一份周报", label)
        assertFalse(label.contains("report.docx"))
        assertFalse(label.contains(" · "))
    }

    @Test
    fun `command strips cd prefix and keeps first segment`() {
        val detail = ToolRowPresentation.timelineDetail(
            "execute_command",
            """{"command":"cd /tmp && ls -la"}""",
        )
        assertTrue(detail!!.startsWith("ls"))
    }

    @Test
    fun `unknown mcp tool uses generic verb and server detail`() {
        val name = "mcp__linear__create_issue"
        val presentation = ToolRowPresentation.of(name)
        assertEquals(R.string.chat_tool_verb_generic, presentation.labelResId)
        assertEquals("linear", presentation.timelineDetail(null, name))

        val label = ToolRowPresentation.timelineLabel(name, null, "工具调用")
        assertTrue(label.contains("工具调用"))
        assertTrue(label.contains("linear"))
        assertFalse(label.contains("_"))
    }

    @Test
    fun `empty or unknown name never equals a toolu id`() {
        val orphanId = "toolu_01AbcDefGhI"
        assertEquals(R.string.chat_tool_verb_generic, ToolRowPresentation.of("").labelResId)
        assertEquals(R.string.chat_tool_verb_generic, ToolRowPresentation.of(orphanId).labelResId)

        val emptyLabel = ToolRowPresentation.timelineLabel("", null, "工具调用")
        val orphanLabel = ToolRowPresentation.timelineLabel(orphanId, null, "工具调用")
        assertEquals("工具调用", emptyLabel)
        assertEquals("工具调用", orphanLabel)
        assertNotEquals(orphanId, orphanLabel)
        assertFalse(orphanLabel.contains("toolu_"))
    }

    @Test
    fun `unknown tools never fall back to raw name via ToolVerbs`() {
        assertEquals(R.string.chat_tool_verb_generic, ToolVerbs.resIdFor("some_custom_mcp_tool"))
        assertEquals(R.string.chat_tool_verb_generic, ToolVerbs.resIdFor(orphanId()))
    }

    private fun orphanId(): String = "toolu_01Orphan"

    private fun assertFamily(name: String, @androidx.annotation.StringRes labelResId: Int, icon: String) {
        val presentation = ToolRowPresentation.of(name)
        assertEquals("label for $name", labelResId, presentation.labelResId)
        assertEquals("icon for $name", icon, presentation.lucideIcon)
    }
}
