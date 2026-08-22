package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.R
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * 与 `mobile-contract/tool-row/vocabulary.json` 对齐：每个 family 工具名都映射到
 * 同一 labelKey / Lucide 图标。夹具由另一条流水线维护，本文件只读。
 */
class ToolRowPresentationContractTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `every fixture family name maps to labelKey and icon`() {
        val root = loadVocabulary()
        val families = root["families"] as JsonArray
        for (element in families) {
            val family = element.jsonObject
            val labelKey = family["labelKey"]!!.jsonPrimitive.content
            val icon = family["icon"]!!.jsonPrimitive.content
            val expectedRes = LABEL_RES[labelKey]
            assertNotNull("unknown fixture labelKey: $labelKey", expectedRes)
            val names = family["names"]!!.jsonArray.map { it.jsonPrimitive.content }
            for (name in names) {
                val presentation = ToolRowPresentation.of(name)
                assertEquals("labelResId for $name ($labelKey)", expectedRes, presentation.labelResId)
                assertEquals("lucideIcon for $name", icon, presentation.lucideIcon)
            }
        }
    }

    @Test
    fun `tab prefix rules match fixture examples`() {
        assertEquals(R.string.chat_tool_verb_tab_search, ToolRowPresentation.of("tabdoc_list_documents").labelResId)
        assertEquals("Search", ToolRowPresentation.of("tabdoc_list_documents").lucideIcon)
        assertEquals(R.string.chat_tool_verb_tab_create, ToolRowPresentation.of("tabmemo_create_memo").labelResId)
        assertEquals("PlusCircle", ToolRowPresentation.of("tabmemo_create_memo").lucideIcon)
        assertEquals(R.string.chat_tool_verb_tab_publish, ToolRowPresentation.of("tabsite_publish_site").labelResId)
        assertEquals("Sparkles", ToolRowPresentation.of("tabsite_publish_site").lucideIcon)
        assertEquals(R.string.chat_tool_verb_tab_update, ToolRowPresentation.of("tabdoc_update_block").labelResId)
        assertEquals("FilePenLine", ToolRowPresentation.of("tabdoc_update_block").lucideIcon)
        assertEquals(R.string.chat_tool_verb_generic, ToolRowPresentation.of("tabcustom_foo").labelResId)
        assertEquals("Wrench", ToolRowPresentation.of("tabcustom_foo").lucideIcon)
    }

    private fun loadVocabulary(): JsonObject {
        val stream = javaClass.classLoader?.getResourceAsStream("mobile-contract/tool-row/vocabulary.json")
        requireNotNull(stream) { "缺少 mobile-contract/tool-row/vocabulary.json" }
        return json.parseToJsonElement(stream.bufferedReader().readText()).jsonObject
    }

    companion object {
        private val LABEL_RES = mapOf(
            "terminal" to R.string.chat_tool_verb_terminal,
            "ssh" to R.string.chat_tool_verb_ssh,
            "read_file" to R.string.chat_tool_verb_read_file,
            "write_file" to R.string.chat_tool_verb_write_file,
            "edit_file" to R.string.chat_tool_verb_edit_file,
            "delete_file" to R.string.chat_tool_verb_delete_file,
            "sql" to R.string.chat_tool_verb_sql,
            "web_search" to R.string.chat_tool_verb_web_search,
            "web_fetch" to R.string.chat_tool_verb_web_fetch,
            "code_search" to R.string.chat_tool_verb_code_search,
            "git_status" to R.string.chat_tool_verb_git_status,
            "git_diff" to R.string.chat_tool_verb_git_diff,
            "todo" to R.string.chat_tool_verb_todo,
            "subagent" to R.string.chat_tool_verb_subagent,
            "ask_user" to R.string.chat_tool_verb_ask_user,
            "memory_write" to R.string.chat_tool_verb_memory_write,
            "memory_delete" to R.string.chat_tool_verb_memory_delete,
            "show_widget" to R.string.chat_tool_verb_show_widget,
            "present_to_user" to R.string.chat_tool_verb_present,
            "generic_tool" to R.string.chat_tool_verb_generic,
            "device_info" to R.string.chat_tool_verb_device_info,
            "battery_info" to R.string.chat_tool_verb_battery,
            "network_info" to R.string.chat_tool_verb_network,
            "contacts" to R.string.chat_tool_verb_contacts,
            "sms_read" to R.string.chat_tool_verb_read_sms,
            "sms_send" to R.string.chat_tool_verb_send_sms,
            "call_log" to R.string.chat_tool_verb_call_log,
            "make_call" to R.string.chat_tool_verb_make_call,
            "calendar" to R.string.chat_tool_verb_calendar,
            "notifications" to R.string.chat_tool_verb_notifications,
            "installed_apps" to R.string.chat_tool_verb_app_list,
            "media" to R.string.chat_tool_verb_media,
            "location" to R.string.chat_tool_verb_location,
            "screen_capture" to R.string.chat_tool_verb_screen_capture,
            "screen_snapshot" to R.string.chat_tool_verb_screen_snapshot,
            "screen_ui_tree" to R.string.chat_tool_verb_ui_tree,
            "screen_tap" to R.string.chat_tool_verb_screen_tap,
            "screen_swipe" to R.string.chat_tool_verb_screen_swipe,
            "screen_long_press" to R.string.chat_tool_verb_screen_long_press,
            "screen_find" to R.string.chat_tool_verb_find_element,
            "screen_type" to R.string.chat_tool_verb_type_text,
            "screen_type_secret" to R.string.chat_tool_verb_type_secret,
            "screen_key" to R.string.chat_tool_verb_key_event,
            "screen_wait" to R.string.chat_tool_verb_wait_ui,
            "screen_open_app" to R.string.chat_tool_verb_open_app,
            "screen_force_stop" to R.string.chat_tool_verb_stop_app,
            "system_setting" to R.string.chat_tool_verb_system_setting,
            "stealth_mode" to R.string.chat_tool_verb_stealth,
            "launch_intent" to R.string.chat_tool_verb_launch_intent,
            "save_to_device" to R.string.chat_tool_verb_save_device,
            "automation_status" to R.string.chat_tool_verb_automation,
            "tab_search" to R.string.chat_tool_verb_tab_search,
            "tab_remove" to R.string.chat_tool_verb_tab_remove,
            "tab_restore" to R.string.chat_tool_verb_tab_restore,
            "tab_create" to R.string.chat_tool_verb_tab_create,
            "tab_update" to R.string.chat_tool_verb_tab_update,
            "tab_publish" to R.string.chat_tool_verb_tab_publish,
            "tab_doc" to R.string.chat_tool_verb_tab_doc,
            "tab_memo" to R.string.chat_tool_verb_tab_memo,
            "tab_site" to R.string.chat_tool_verb_tab_site,
            "tab_data" to R.string.chat_tool_verb_tab_data,
        )
    }
}
