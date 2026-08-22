package com.tabtin.mobile.features.workbench

import com.tabtin.mobile.data.model.MessageBlock
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow

public data class ResourceReference(
    val id: String,
    val resourceId: String,
    val normalizedType: String,
    val resourceType: String,
    val title: String,
    val emoji: String,
    /**
     * Wave 6 跨端协议验证：所属 space 信息，发送时通过 `MessageBlock` 透传给后端，
     * 让 `context_resolver.py` + 持久化的 blocks_json 在跨 space 引用时能溯源。
     * 与 iOS `MentionContextRef.spaceId` / `spaceName` 同口径。
     */
    val spaceId: String? = null,
    val spaceName: String? = null,
    /**
     * Wave 6 跨端协议验证：field 类引用必填——field 资源所属 owner table 的 ID。
     * `toMessageBlock()` 在 field 分支用它做 `tableId`，把 fieldId 放进 `fieldIds` 数组。
     * 非 field 类型保持 null。
     */
    val ownerTableId: String? = null,
    /**
     * @row 类引用：table_selection block 的指定行 ID 列表（与 iOS `MentionContextRef.rowIds` /
     * Electron `row_ids` 对齐）。当前 Android 资源列表暂不下发行级子项，保持 null；
     * `toMessageBlock()` 已支持透传，供后续接入行级引用时直接复用。
     */
    val rowIds: List<String>? = null,
    /**
     * TabFiles 附件块可选 MIME / size；仅 `normalizedType == tabfiles` 使用。
     * [resourceId] 对 TabFiles 必须是 FileRecordID（不是 ContextItemID）。
     */
    val mimeType: String? = null,
    val fileSize: Long? = null,
) {
    /** 文件夹永远不可发送到对话；其它类型以 [toMessageBlock] 能否生成 payload 为准。 */
    public val canSendToConversation: Boolean
        get() = normalizedType != "folder" && toMessageBlock() != null

    public companion object {
        public fun from(resource: SpaceResource): ResourceReference = ResourceReference(
            id = resource.id,
            resourceId = resource.resourceId,
            normalizedType = resource.normalizedType,
            resourceType = resource.typeLabel,
            title = resource.displayTitle,
            emoji = resource.emoji,
            spaceId = resource.spaceId?.takeIf { it.isNotBlank() },
            spaceName = resource.spaceName?.takeIf { it.isNotBlank() },
            ownerTableId = resource.ownerTableId?.takeIf { it.isNotBlank() },
            mimeType = null,
            fileSize = null,
        )

        /**
         * 云盘行 → 对话引用。TabFiles 的 [CloudDriveResourceRow.fileRecordId] /
         * [CloudDriveResourceRow.resourceId] 才是 FileRecordID。
         */
        public fun fromCloudDriveRow(row: CloudDriveResourceRow): ResourceReference? {
            val type = row.normalizedType
            if (type == "folder") return null
            val fileRecordId = row.fileRecordId?.takeIf { it.isNotBlank() }
                ?: row.resourceId.takeIf { type == "tabfiles" && it.isNotBlank() }
            val resourceId = when (type) {
                "tabfiles" -> fileRecordId ?: return null
                else -> row.resourceId.takeIf { it.isNotBlank() } ?: return null
            }
            return ResourceReference(
                id = row.contextItemId,
                resourceId = resourceId,
                normalizedType = type,
                resourceType = when (type) {
                    "tabdoc" -> "TabDoc"
                    "tabdata" -> "TabData"
                    "tabfiles" -> "TabFiles"
                    else -> row.itemType
                },
                title = row.displayTitle,
                emoji = when (type) {
                    "tabdoc" -> "📄"
                    "tabdata" -> "📊"
                    "tabfiles" -> "📎"
                    else -> "📁"
                },
                spaceId = row.spaceId?.takeIf { it.isNotBlank() },
                spaceName = row.spaceName?.takeIf { it.isNotBlank() },
                mimeType = row.mimeType,
                fileSize = row.fileSizeBytes,
            )
        }
    }

    /**
     * 把资源引用转为后端消息 block（发送时与文本正文一起上行）。
     *
     * Wave 6 跨端协议验证 P1-Q1 / 顺手修对齐：
     *  - **block type 命名**：与 iOS / Electron 统一为 `"table_selection"` /
     *    `"doc_selection"`（Electron `useContextInjection.ts::contextRefsToBlocks` 同名）。
     *    后端 Django `apps/chat/conversation/services/context_resolver.py` 同时接受
     *    `table` / `table_selection` 两种命名，本轮切到 `_selection` 后缀以避免日志/分析
     *    侧的 client 分裂识别问题。
     *  - **资源类型映射对齐 iOS** (`MentionContextRef.blockPayload`)：tabdata/tabdoc/
     *    tabslide/tabdesign/tabvideo/tabsite/folder/tabmemo/tabtracker/tabwhiteboard/tabcode。
     *  - **field 分支**：type=table_selection + tableId=ownerTableId + fieldIds=[resourceId]，
     *    与 Electron 行 137-141 等价。当前 Android 列表接口暂不下发 field 子项
     *    （UI 入口归 Wave 7+），但 `toMessageBlock()` 必须能生成正确 payload，
     *    供后续接入 field 列表时直接复用。
     *  - **spaceId / spaceName 透传**：所有非附件 block 都透传，让后端持久化
     *    `blocks_json` 在跨 space 引用时能保留来源信息（与 iOS 同步）。
     */
    public fun toMessageBlock(): MessageBlock? = when (normalizedType) {
        "tabdata" -> MessageBlock(
            type = "table_selection",
            tableId = resourceId,
            rowIds = rowIds,
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        "tabdoc" -> MessageBlock(
            type = "doc_selection",
            docId = resourceId,
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        "tabslide" -> MessageBlock(
            type = "slide",
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        "tabdesign" -> MessageBlock(
            type = "design",
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        "tabvideo" -> MessageBlock(
            type = "video",
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        "tabsite" -> MessageBlock(
            type = "site",
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        //  / Task 9：TabFiles 必须编码为 type=file + file_id=FileRecordID，
        // 绝不能退化成 folder（否则 Agent 拿不到可解析的文件身份）。
        "tabfiles" -> {
            val fileId = resourceId.takeIf { it.isNotBlank() } ?: return null
            MessageBlock(
                type = "file",
                fileId = fileId,
                filename = title,
                mimeType = mimeType,
                size = fileSize,
                preview = title,
                spaceId = spaceId,
                spaceName = spaceName,
            )
        }
        // 文件夹永远不可发送到对话（plan §6.1）。
        "folder" -> null
        "tabmemo" -> MessageBlock(
            type = "memo",
            memoId = resourceId,
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        "tabtracker" -> MessageBlock(
            type = "goal",
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        "tabwhiteboard" -> MessageBlock(
            type = "canvas",
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        "tabcode" -> MessageBlock(
            type = "code",
            preview = title,
            spaceId = spaceId,
            spaceName = spaceName,
        )
        // field 分支：用 table_selection 包住一个 field id；ownerTableId 为空时退回 null
        // 让发送端 mapNotNull 过滤掉，避免传一个无效 block 给后端。
        "field" -> ownerTableId?.let { tableId ->
            MessageBlock(
                type = "table_selection",
                tableId = tableId,
                fieldIds = listOf(resourceId),
                rowIds = rowIds,
                preview = title,
                spaceId = spaceId,
                spaceName = spaceName,
            )
        }
        else -> null
    }

    val label: String get() = "$emoji$title（$resourceType）"
}
