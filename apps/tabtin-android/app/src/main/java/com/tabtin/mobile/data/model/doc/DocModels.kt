package com.tabtin.mobile.data.model.doc

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
public data class Doc(
    val id: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("parent_id") val parentId: String? = null,
    val title: String,
    val status: String? = null,
    @SerialName("latest_version") val latestVersion: Int? = null,
    val icon: String? = null,
    @SerialName("cover_image") val coverImage: String? = null,
    @SerialName("created_by") val createdBy: String? = null,
    @SerialName("updated_by") val updatedBy: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("current_user_role") val currentUserRole: String? = null,
) {
    val displayTime: String? get() = updatedAt ?: createdAt
    val sortTimestamp: String get() = updatedAt ?: createdAt ?: ""
    val trimmedTitle: String get() = title.trim()
    val canEdit: Boolean get() = currentUserRole == null ||
        currentUserRole.lowercase() in setOf("owner", "admin", "editor")
}

@Serializable
public data class DocContent(
    @SerialName("description_json") val descriptionJson: JsonObject = JsonObject(emptyMap()),
    @SerialName("description_markdown") val descriptionMarkdown: String = "",
    @SerialName("description_plaintext") val descriptionPlaintext: String = "",
) {
    val previewText: String
        get() {
            val pt = descriptionPlaintext.trim()
            if (pt.isNotEmpty()) return pt
            return descriptionMarkdown.replace("#", "").replace(Regex("\\s+"), " ").trim()
        }
}

@Serializable
public data class DocRevision(
    val id: String,
    @SerialName("document_id") val documentId: String,
    val version: Int? = null,
    @SerialName("content_pm_json") val contentPmJson: JsonObject = JsonObject(emptyMap()),
    @SerialName("content_markdown") val contentMarkdown: String = "",
    @SerialName("content_plaintext") val contentPlaintext: String = "",
    @SerialName("editor_id") val editorId: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
public data class DocHistoryEntry(
    val id: String,
    @SerialName("document_id") val documentId: String? = null,
    @SerialName("is_snapshot") val isSnapshot: Boolean = false,
    @SerialName("editor_type") val editorType: String? = null,
    @SerialName("editor_id") val editorId: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("is_named") val isNamed: Boolean = false,
    val name: String = "",
    val pinned: Boolean = false,
)

// --- API Responses ---

@Serializable
public data class DocListResponse(val documents: List<Doc>)

@Serializable
public data class DocSingleResponse(val document: Doc)

@Serializable
public data class DocDetailResponse(
    val document: Doc,
    val content: DocContent = DocContent(),
    @SerialName("latest_revision") val latestRevision: DocRevision? = null,
)

@Serializable
public data class DocHistoryListResponse(val histories: List<DocHistoryEntry>)

@Serializable
public data class SaveContentResponse(
    val document: Doc,
    /** 后端写响应默认只回 document 元数据；兼容历史/其他部署可选回显的正文。 */
    val content: DocContent? = null,
)

// --- API Requests ---

@Serializable
public data class CreateDocRequest(
    @SerialName("organization_id") val organizationId: String,
    val title: String,
    @SerialName("parent_id") val parentId: String? = null,
    /** 云盘文件夹 ID；直接创建到当前 collection，无需先建再移动。 */
    @SerialName("collection_id") val collectionId: String? = null,
    @SerialName("initial_content_pm_json") val initialContentPmJson: JsonObject = JsonObject(emptyMap()),
    @SerialName("initial_content_markdown") val initialContentMarkdown: String = "",
    @SerialName("initial_content_plaintext") val initialContentPlaintext: String = "",
)

@Serializable
public data class UpdateDocRequest(
    val title: String? = null,
    @SerialName("base_version") val baseVersion: Int? = null,
    @SerialName("base_updated_at") val baseUpdatedAt: String? = null,
)

@Serializable
public data class SaveContentRequest(
    @SerialName("content_pm_json") val contentPmJson: JsonObject,
    @SerialName("content_markdown") val contentMarkdown: String,
    @SerialName("content_plaintext") val contentPlaintext: String = "",
    @SerialName("base_version") val baseVersion: Int? = null,
    @SerialName("base_updated_at") val baseUpdatedAt: String? = null,
    val title: String? = null,
    @OptIn(ExperimentalSerializationApi::class)
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    @SerialName("write_intent") val writeIntent: String = "replace",
)

@Serializable
public data class RestoreHistoryRequest(
    @SerialName("version_id") val versionId: String,
)
