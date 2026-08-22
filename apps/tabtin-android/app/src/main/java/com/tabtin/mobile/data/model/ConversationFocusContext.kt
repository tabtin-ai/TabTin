package com.tabtin.mobile.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Wire-neutral 不可变 Focus 快照。入队时冻结，重试只读本对象，不读此刻 Workbench。
 *
 * 字段对齐 `@tabtin/contracts` FocusSnapshot（camelCase）。revision 只能是可空 hint。
 */
@Serializable
public data class ConversationFocusContext(
    val appType: String? = null,
    val appMeta: JsonObject? = null,
    val openTabs: List<FocusTabSnapshot>? = null,
    val spaceId: String? = null,
    val userTimeZone: String? = null,
    val workspaceMode: String? = null,
)

@Serializable
public data class FocusTabSnapshot(
    val type: String,
    val id: String? = null,
    val title: String? = null,
    val active: Boolean? = null,
    val group_id: String? = null,
    val app_key: String? = null,
    val display_name: String? = null,
    val is_home: Boolean? = null,
    val app_home: String? = null,
    val path: String? = null,
    val kind: String? = null,
    val url: String? = null,
    val session_id: String? = null,
    /** 可空修订 hint；不得伪造版本号。 */
    val revision: String? = null,
)
