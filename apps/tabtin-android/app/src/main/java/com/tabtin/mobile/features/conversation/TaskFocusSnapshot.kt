package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.FocusTabSnapshot
import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchNavigationPane
import java.util.TimeZone
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 从工作台导航状态投影不可变 Focus。纯函数：不持有会话发送逻辑。
 *
 * appMeta 正典（对齐 Django / Electron）：
 * - `idField` / `titleField` 只放**字段名**（如 `current_doc_id`）
 * - 资源值写入对应键 + `openTabs[].id`
 * - App 首页只写 `current_app_home`，禁止把 appId 写成 `current_doc_id`
 */
public object TaskFocusSnapshot {
    public data class AppMetaFields(
        val idField: String,
        val titleField: String?,
    )

    public fun appMetaFieldsFor(appType: String?): AppMetaFields? {
        if (appType.isNullOrBlank()) return null
        return when (appType) {
            "tabdoc" -> AppMetaFields("current_doc_id", "current_doc_title")
            "tabdata" -> AppMetaFields("current_table_id", null)
            "tabslide" -> AppMetaFields("current_slide_id", "current_slide_title")
            "tabsite" -> AppMetaFields("current_site_id", "current_site_title")
            "tabtracker" -> AppMetaFields("current_tracker_id", "current_tracker_title")
            "tabmemo" -> AppMetaFields("current_memo_id", "current_memo_title")
            "tabfiles" -> AppMetaFields("current_file_id", "current_file_name")
            "tabvideo" -> AppMetaFields("current_video_id", "current_video_title")
            "tabwhiteboard" -> AppMetaFields("current_canvas_id", "current_canvas_title")
            "tabcode" -> AppMetaFields("current_code_project_path", null)
            "tabweb" -> AppMetaFields("current_browser_url", "current_browser_title")
            "tabfolder" -> AppMetaFields("current_folder_path", null)
            "tabphone" -> AppMetaFields("current_device_id", null)
            else -> {
                val key = appType.removePrefix("tab").ifBlank { "resource" }
                AppMetaFields("current_${key}_id", "current_${key}_title")
            }
        }
    }

    public fun buildAppMeta(
        appType: String?,
        resourceId: String?,
        title: String?,
        revision: String?,
        viewId: String? = null,
    ): JsonObject? {
        if (resourceId == null && title == null && revision == null) return null
        val fields = appMetaFieldsFor(appType) ?: return null
        return buildJsonObject {
            put("idField", fields.idField)
            resourceId?.let { put(fields.idField, it) }
            fields.titleField?.let { titleField ->
                put("titleField", titleField)
                title?.let { put(titleField, it) }
            }
            revision?.let { put("revision", it) }
            // TabData：有真实视图 UUID 时写入；空串不冒充。
            if (appType == "tabdata") {
                viewId?.takeIf { it.isNotBlank() }?.let { put("current_view_id", it) }
            }
        }
    }

    /** App 首页：对齐 Electron apphome handler，只注入 current_app_home。 */
    public fun buildAppHomeMeta(appType: String?): JsonObject? {
        val appId = appType?.takeIf { it.isNotBlank() } ?: return null
        return buildJsonObject {
            put("current_app_home", appId)
        }
    }

    /**
     * @param workspaceMode 资源/工作台面应为 `desktop`；纯对话面为 `conversation`。
     * 默认 null 时按 target.pane 推断（Detail/AppHome → desktop，Overview → conversation）。
     */
    public fun from(
        spaceId: String?,
        target: WorkbenchFocusTarget?,
        userTimeZone: String = TimeZone.getDefault().id,
        workspaceMode: String? = null,
    ): ConversationFocusContext {
        val resolvedMode = workspaceMode
            ?: workspaceModeFor(target)
        val isAppHome = target?.pane is WorkbenchNavigationPane.AppHome
        val appType = target?.appType
        val resourceId = target?.resourceId?.takeIf { it.isNotBlank() }
        val title = target?.title?.takeIf { it.isNotBlank() }
        val path = target?.path
        val revision = target?.revisionHint

        val viewId = target?.viewId?.takeIf { it.isNotBlank() }
        val appMeta = if (isAppHome) {
            buildAppHomeMeta(appType)
        } else {
            buildAppMeta(appType, resourceId, title, revision, viewId)
        }

        val openTabs = if (appType != null) {
            listOf(
                FocusTabSnapshot(
                    type = appType,
                    // 首页不得把 appId 塞进 id（污染 current_doc_id）。
                    id = if (isAppHome) null else resourceId,
                    title = title ?: if (isAppHome) appType else null,
                    active = true,
                    app_key = appType,
                    display_name = if (isAppHome) title else null,
                    is_home = if (isAppHome) true else null,
                    app_home = if (isAppHome) appType else null,
                    path = path,
                    revision = if (isAppHome) null else revision,
                ),
            )
        } else {
            null
        }

        return ConversationFocusContext(
            appType = appType,
            appMeta = appMeta,
            openTabs = openTabs,
            spaceId = spaceId?.takeIf { it.isNotBlank() },
            userTimeZone = userTimeZone.takeIf { it.isNotBlank() },
            workspaceMode = resolvedMode,
        )
    }

    public fun workspaceModeFor(target: WorkbenchFocusTarget?): String =
        when (target?.pane) {
            is WorkbenchNavigationPane.Detail,
            is WorkbenchNavigationPane.AppHome,
            -> "desktop"
            else -> "conversation"
        }
}
