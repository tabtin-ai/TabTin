package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest

/**
 * 用户消息里的上下文引用。对齐 iOS `ContextRefBlock` / `ContextRefBlockCard`：
 * 发送后画卡片，不把 composer chip 直接贴进气泡。
 */
internal enum class ContextRefKind {
    WEB,
    TABLE,
    DOC,
    SLIDE,
    DESIGN,
    VIDEO,
    SITE,
    FOLDER,
    CODE,
    MEMO,
    GOAL,
    CANVAS,
    FILE,
    GENERIC,
}

internal data class ContextRefPresentation(
    val kind: ContextRefKind,
    val title: String,
    val preview: String?,
    val explicitLocationHint: String?,
    val rowIds: List<String>,
    val fieldIds: List<String>,
    val iconType: String,
    val resourceType: String,
    val resourceId: String?,
    val externalUrl: String?,
) {
    val canNavigate: Boolean
        get() = !resourceId.isNullOrBlank() || !externalUrl.isNullOrBlank()

    fun displayPreview(): String? {
        val extra = preview?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return extra.takeIf { it != title }
    }

    fun openRequest(locationHint: String?): WorkbenchResourceOpenRequest? {
        val id = resourceId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return WorkbenchResourceOpenRequest(
            resourceType = resourceType,
            resourceId = id,
            title = title,
            locationHint = locationHint,
        )
    }
}

internal object ContextRefBlockPolicy {
    private val CONTEXT_REF_TYPES = setOf(
        "tabtin_source_ref",
        "doc_selection",
        "document",
        "doc",
        "table_selection",
        "table",
        "slide",
        "tabslide",
        "design",
        "tabdesign",
        "video",
        "tabvideo",
        "site",
        "tabsite",
        "folder",
        "code_file",
        "code",
        "tabcode",
        "memo",
        "tabmemo",
        "goal",
        "tracker",
        "tabtracker",
        "tabgoal",
        "canvas",
        "whiteboard",
        "tabwhiteboard",
        "web",
        "webpage",
        "search_result",
    )

    fun isContextRef(block: BlockItem): Boolean {
        val type = block.type?.trim().orEmpty()
        if (type in CONTEXT_REF_TYPES) return true
        return type == "file" &&
            block.url.isNullOrBlank() &&
            !block.fileId.isNullOrBlank()
    }

    fun extract(blocks: List<BlockItem>?): List<BlockItem> =
        blocks.orEmpty().filter(::isContextRef)

    fun present(block: BlockItem): ContextRefPresentation {
        val type = block.type?.trim().orEmpty()
        val kind = kindFor(type)
        val title = firstNonEmpty(
            block.label,
            block.title,
            block.resourceName,
            block.filename,
            block.preview,
        ).orEmpty()
        val resourceType = navigationResourceType(type)
        return ContextRefPresentation(
            kind = kind,
            title = title,
            preview = block.preview,
            explicitLocationHint = block.locationHint?.trim()?.takeIf { it.isNotEmpty() },
            rowIds = block.rowIds.orEmpty(),
            fieldIds = block.fieldIds.orEmpty(),
            iconType = SpaceResource.normalizedType(resourceType),
            resourceType = resourceType,
            resourceId = resourceId(block),
            externalUrl = block.url?.trim()?.takeIf { it.isNotEmpty() },
        )
    }

    fun kindFor(type: String): ContextRefKind = when (type) {
        "web", "webpage", "search_result" -> ContextRefKind.WEB
        "table_selection", "table" -> ContextRefKind.TABLE
        "doc_selection", "document", "doc" -> ContextRefKind.DOC
        "slide", "tabslide" -> ContextRefKind.SLIDE
        "design", "tabdesign" -> ContextRefKind.DESIGN
        "video", "tabvideo" -> ContextRefKind.VIDEO
        "site", "tabsite" -> ContextRefKind.SITE
        "folder" -> ContextRefKind.FOLDER
        "code_file", "code", "tabcode" -> ContextRefKind.CODE
        "memo", "tabmemo" -> ContextRefKind.MEMO
        "goal", "tracker", "tabtracker", "tabgoal" -> ContextRefKind.GOAL
        "canvas", "whiteboard", "tabwhiteboard" -> ContextRefKind.CANVAS
        "file" -> ContextRefKind.FILE
        else -> ContextRefKind.GENERIC
    }

    fun navigationResourceType(blockType: String): String = when (blockType) {
        "table", "table_selection" -> "tabdata"
        "document", "doc", "doc_selection" -> "tabdoc"
        "slide", "tabslide" -> "tabslide"
        "site", "tabsite" -> "tabsite"
        "video", "tabvideo" -> "tabvideo"
        "design", "tabdesign" -> "tabdesign"
        "canvas", "whiteboard", "tabwhiteboard" -> "tabwhiteboard"
        "memo", "tabmemo" -> "tabmemo"
        "goal", "tracker", "tabtracker", "tabgoal" -> "tabtracker"
        "code", "code_file", "tabcode" -> "tabcode"
        "file" -> "tabfiles"
        else -> blockType
    }

    private fun resourceId(block: BlockItem): String? = firstNonEmpty(
        block.resourceId,
        block.docId,
        block.tableId,
        block.memoId,
        block.fileId,
    )

    private fun firstNonEmpty(vararg values: String?): String? =
        values.firstOrNull { !it.isNullOrBlank() }?.trim()
}
