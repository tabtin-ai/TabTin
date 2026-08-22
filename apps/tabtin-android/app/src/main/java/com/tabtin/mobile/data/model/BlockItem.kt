package com.tabtin.mobile.data.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * content_blocks_json 的 content 通常是文本，但 web_search_tool_result 合法地携带数组。
 * 保持 BlockItem 既有 String API，同时把结构化值保留为 JSON 字符串供工具卡解析。
 */
internal object NullableJsonStringSerializer : KSerializer<String?> {
    override val descriptor: SerialDescriptor = String.serializer().nullable.descriptor

    override fun deserialize(decoder: Decoder): String? {
        if (decoder !is JsonDecoder) return decoder.decodeSerializableValue(String.serializer().nullable)
        return when (val element = decoder.decodeJsonElement()) {
            is JsonNull -> null
            is JsonPrimitive -> element.content
            else -> element.toString()
        }
    }

    override fun serialize(encoder: Encoder, value: String?) {
        encoder.encodeSerializableValue(String.serializer().nullable, value)
    }
}

/**
 * 落库 / 流式 `tool_result.presentation`（嵌套 `{ kind, data }`）。
 * Django content_blocks_json 与 agent-wire ContentBlockToolResult 同形。
 */
@Serializable
public data class BlockPresentation(
    val kind: String? = null,
    val data: BlockPresentationData? = null,
)

@Serializable
public data class BlockPresentationData(
    val prompt: String? = null,
    val command: String? = null,
)

@Serializable
public data class BlockItem(
    val type: String? = null,
    val index: Int? = null,
    @Serializable(with = NullableJsonStringSerializer::class)
    val content: String? = null,
    val text: String? = null,
    val thinking: String? = null,
    val id: String? = null,
    val name: String? = null,
    val input: JsonElement? = null,
    @SerialName("input_json") val inputJson: String? = null,
    val output: String? = null,
    @SerialName("result_text") val resultText: String? = null,
    val citations: List<JsonElement>? = null,
    @SerialName("tool_use_id") val toolUseId: String? = null,
    @SerialName("source_tool_use_id") val sourceToolUseId: String? = null,
    @SerialName("is_error") val isError: Boolean? = null,
    val status: String? = null,
    @SerialName("file_id") val fileId: String? = null,
    @SerialName("artifact_kind") val artifactKind: String? = null,
    val filename: String? = null,
    @SerialName("relative_path") val relativePath: String? = null,
    @SerialName("mime_type") val mimeType: String? = null,
    val size: Long? = null,
    val url: String? = null,
    @SerialName("preview_url") val previewUrl: String? = null,
    @SerialName("table_id") val tableId: String? = null,
    @SerialName("doc_id") val docId: String? = null,
    @SerialName("memo_id") val memoId: String? = null,
    @SerialName("field_ids") val fieldIds: List<String>? = null,
    @SerialName("row_ids") val rowIds: List<String>? = null,
    val preview: String? = null,
    val label: String? = null,

    // rich_content fields
    val kind: String? = null,
    val summary: String? = null,
    /**
     * `tabtin_rich_content` 的标准历史协议把展示字段放在 `payload` 内。
     * 直播路径会在 StreamManager 中摊平；历史路径必须先保留原对象，再由
     * [normalizedRichContent] 统一摊平，否则 resource/image 等关键字段会被静默丢弃。
     */
    val payload: JsonObject? = null,
    val caption: String? = null,
    // 服务端 `present_to_user.py` table_preview 真实推送的可选字段（详见 spec
    // "Truncate and set total_rows for the full count"）：
    //   - `title`：表格标题，桌面端 `RichContentRenderer.tsx` 渲染为顶部 caption header
    //   - `total_rows`：截断前的全表行数；与实际渲染行数比较后渲染"显示 X / Y 行"截断提示
    // 桌面端从 day 1 就在用，移动端 BlockItem 之前缺这两个字段——服务端真在推但
    // kotlinx.serialization 解码时被静默丢弃，用户看不到表格标题和截断信息。
    val title: String? = null,
    // 服务端 table_preview schema：columns 是 [{key, label}]，rows 是 [{col_key: value}]。
    // 用 JsonElement 而不是 List<String>，避免 kotlinx.serialization 在收到对象数组时
    // 抛 MissingFieldException（Wave 0 子 Agent 漏掉的真实坑）。同时保留向后兼容：
    // 旧测试 / 旧 payload 用 [String] / [[String]] 也能解析进来。
    val columns: List<JsonElement>? = null,
    val rows: List<JsonElement>? = null,
    @SerialName("total_rows") val totalRows: Int? = null,
    @SerialName("resource_type") val resourceType: String? = null,
    @SerialName("resource_id") val resourceId: String? = null,
    @SerialName("resource_name") val resourceName: String? = null,
    @SerialName("location_hint") val locationHint: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("workspace_id") val workspaceId: String? = null,

    // Wave 3 协议对照 Review 补字段：与 packages/tabtin-chat-client RichContentBlock + iOS BlockItem 对齐。
    // 缺失这些字段 = 含这些字段的流式 block 在 strict JSON 解码下 throw → 落到 catch 块被 warning 静默
    // 跳过；改成 nullable + default null 后即便走 strict 解码也能解出真值。
    /** 图片无障碍替代文本（TalkBack 用），桌面 RichImage 也消费此字段。 */
    @SerialName("alt_text") val altText: String? = null,
    /**
     * file kind 的文件大小（字节）；与 attachment block 的 `size` 字段属于不同 schema：
     *  - attachment block（用户上传）→ `size`
     *  - rich_content file block（agent 产出）→ `file_size`
     * 两个字段都建模，渲染层按需取值。
     */
    @SerialName("file_size") val fileSize: Long? = null,
    /**
     * resource_ref kind 的所属 Space 名称，作为副标题展示（见 RichContentRenderer.tsx:304-306）。
     * 用户能识别资源属于哪个 Space —— 跨 Space 协作时尤其重要。
     */
    @SerialName("space_name") val spaceName: String? = null,

    // Widget Wave 2 占位字段（widget RFC §三 3.1 + 移动端范围保守化）：
    //
    // 移动端**不实现 widget UI 渲染**——图片 fallback 是 Wave 4 的事；本期只补
    // BlockItem 字段支持让 kotlinx.serialization 解码不爆栈。当服务端推
    // `kind:'widget'` 含 widget_id / code / format / image_url 字段时，解码到
    // BlockItem 后 RichContentSection 的 widget case 走"在桌面端查看 widget 内容
    // + summary"占位（与 Wave 4 烤图失败兜底体验一致）。
    //
    // 即使 `StreamManager.kt` 已改用 `ApiClient.json`（ignoreUnknownKeys=true），
    // 显式列字段仍然有价值——历史回放 / Room cache 经过 `MessageEntity.kt`
    // 走 ApiJson 解码，未声明字段会丢失，未来 Wave 4 / Wave 7 想用这些字段时
    // 旧 cache 拿不出来。
    @SerialName("widget_id") val widgetId: String? = null,
    val code: String? = null,
    val format: String? = null,
    @SerialName("image_url") val imageUrl: String? = null,
    @SerialName("loading_message") val loadingMessage: String? = null,

    // Mobile 对齐 Wave（widget RFC §三 3.1 + TS 真相源 `RichContentBlock`）：
    // 补齐此前 Android BlockItem 解码时静默丢弃的 widget / rich_content 字段。完整
    // 契约见 `packages/tabtin-chat-client/src/types/message.ts` 的 `RichContentBlock`。
    //
    // 本轮补字段的**严格边界**（与 iOS 对齐）：
    //   - 只做解码层字段就位，**不**在本轮上 UI（group_id 分组 / interrupted_status
    //     中断态在桌面端已实现，移动端 v2 再做——写 backlog）
    //   - 唯一例外：mermaid fallback 入口——Mermaid widget 烤图失败时 `imageUrl`
    //     缺失/空，移动端用户永远看不到用户画了啥。桌面端 Agent 吐的是 mermaid 源码，
    //     移动端至少能展示源码 + summary 让用户能手动在桌面端复现。这是最低劣的降级
    //     路径，视觉简单：折叠面板点开显示等宽字体 mermaid 源码
    //
    // 字段用途（与 TS 字面对齐）：
    //   - tool_call_id：前端按 tool_call_id 精确替换 placeholder；移动端实时流式 v2
    //     时也要（反思 10 多 turn 场景——同一 session 多个 widget 靠 tool_call_id
    //     精确寻址不会串台）
    //   - source_code / mermaid_source：Mermaid widget 移动端烤图失败 fallback 时
    //     展示原始源码。桌面端 Agent 写的是 mermaid 源码，编译后 `code` 变成编译
    //     后的 SVG，`source_code` / `mermaid_source` 保留原始 mermaid 文本；Wave 6
    //     Mermaid 编译后双端都能复制源码排错
    //   - rendered_code：Mermaid 编译产物（与 `code` 字面相同），未来移动端能原生
    //     渲染 SVG 时走这个
    //   - group_id / group_title：多 widget 分组展示，本轮**不做**群组 UI，仅解码
    //   - interrupted_at / interrupted_status：widget cancel 状态（毫秒时间戳 +
    //     cancelled/error/terminated/unknown）。本轮移动端**不做**中断 UI（移动端
    //     不实时同步流式 widget——决策 10），只保证字段解码不抛
    @SerialName("tool_call_id") val toolCallId: String? = null,
    @SerialName("source_code") val sourceCode: String? = null,
    @SerialName("mermaid_source") val mermaidSource: String? = null,
    @SerialName("rendered_code") val renderedCode: String? = null,
    @SerialName("group_id") val groupId: String? = null,
    @SerialName("group_title") val groupTitle: String? = null,
    /**
     * 毫秒时间戳。用 [Long] 承载——Kotlin `Instant.ofEpochMilli` 走 ms 转 Instant
     * 在 caller 侧做，BlockItem 不 eagerly 转 Instant 避免吞精度（2038 之后依然安全）。
     */
    @SerialName("interrupted_at") val interruptedAt: Long? = null,
    /**
     * 与 TS `'cancelled' | 'error' | 'terminated' | 'unknown'` 字面对齐的枚举值。
     * Android 用 [String] 承载而不是严格 enum——字段解码向后兼容（未来服务端加新值
     * 老 client 不抛），caller 按字符串匹配走分支。
     */
    @SerialName("interrupted_status") val interruptedStatus: String? = null,

    // W4 D1：CLI stdout 自动渲染占位字段（`cli_output_table` / `cli_output_record`）。
    // Android 本期**不渲染** CLI 表格 / 记录 UI——CLI 自动渲染主要服务桌面端
    // （用户在桌面端通过 CLI 自动化跑命令，移动端是观察 / 审阅场景）。
    //
    // 显式声明字段是为了让 kotlinx.serialization strict 解码下不丢字段，未来
    // Wave 更新时可以直接消费 cache 里已有的数据。
    /** CLI 命令字符串（如 `tabtin doc list --format json`），fallback 文案展示用。 */
    @SerialName("cli_command") val cliCommand: String? = null,
    /** 列定义（cli_output_table）。 */
    @SerialName("cli_columns") val cliColumns: List<JsonElement>? = null,
    /** 行数据（cli_output_table）。 */
    @SerialName("cli_rows") val cliRows: List<JsonElement>? = null,
    /** 单对象数据（cli_output_record）。 */
    @SerialName("cli_record") val cliRecord: JsonElement? = null,
    /** 行数（cli_output_table）。结构化字段，方便 i18n 拼"X 条"文案。 */
    @SerialName("cli_row_count") val cliRowCount: Int? = null,

    // W7 双层结果推广：search_results / memory_card / document_excerpt 占位字段。
    // Android 本期**不渲染**这三类卡片——桌面端是 W7 主战场。显式声明字段是为
    // 保证 kotlinx.serialization strict 解码下不丢字段，未来移动端 UI 接入时
    // 可以直接消费 cache 里已有的数据。
    /** 搜索查询字符串（search_results / memory_card 头部展示）。 */
    @SerialName("query") val query: String? = null,
    /** 搜索结果列表（search_results）。 */
    @SerialName("search_results") val searchResults: List<JsonElement>? = null,
    /** 记忆条目列表（memory_card）。 */
    @SerialName("memories") val memories: List<JsonElement>? = null,
    /** 文档解析状态（document_excerpt：success / parsing / pending / partial / failed）。 */
    @SerialName("parse_status") val parseStatus: String? = null,
    /** 已解析页数（document_excerpt：parsing / partial 状态时增量更新）。 */
    @SerialName("parsed_pages") val parsedPages: Int? = null,
    /** 文件总页数（document_excerpt）。 */
    @SerialName("total_pages") val totalPages: Int? = null,
    /** 文档分片预览（document_excerpt）。 */
    @SerialName("document_chunks") val documentChunks: List<JsonElement>? = null,
    /** 总命中数（search_results / memory_card；可能 > 数组长度，因为只展示 top N）。 */
    @SerialName("total_count") val totalCount: Int? = null,

    /**
     * `tool_result.presentation`：文生图等交付物识别（`kind == media_image_generation`）。
     * 历史 JSON 为嵌套对象；直播 upsert 时由 AgentStep 回填。
     */
    val presentation: BlockPresentation? = null,
) {
    /**
     * Wave 3 协议对照 Review 修正：原本 Android 这里多了 `&& !kind.isNullOrEmpty()`，
     * 与 iOS `BlockItem.isRichContent`（`apps/tabtin-ios/.../ChatMessage.swift:252`）的
     * 仅基于 `type` 不一致。
     *
     * 行为分叉后果：服务端推一个 `type=rich_content` 但缺 `kind` 的异常 block 时，
     *   - iOS：依然进入 `RichContentView`，落到 `default → RichFallbackView`，至少显示
     *     summary 或静默不渲染（不会丢整块上下文）
     *   - Android（修正前）：被 `richContentBlocks` filter 整段 reject，**整个 rich_content
     *     section 不出现**——若同一条消息只有这一个 block，用户看到 0 卡片
     *
     * 修正：与 iOS 同口径，仅基于 `type`；`kind` 缺失的兜底交给 RichContentSection 的
     * `else -> RichFallback(block)` 分支处理（行为与 iOS RichFallbackView 等价）。
     *
     * W4.5 第二波 P0-2 修复（2026-05-12）：兼容 Django reassembler 落库形态。
     *
     * daemon 端 RichContent block 流式 emit `ContentBlock.type='tabtin_rich_content'`（见
     * `packages/agent-wire/src/stream-content-block.ts::TabTinRichContentBlockSchema`），
     * Django `content_block_reassembler.py` 落库时 `block.type` 字段直传——保留 `'tabtin_rich_content'`。
     * 同时历史 / 兜底兼容路径仍可能携带 `'rich_content'`（旧持久化数据 / 前端 inline 构造）。
     *
     * 修复前 Android 仅认 `'rich_content'`，导致拉历史会话时 Django 已落库的
     * `'tabtin_rich_content'` block 在 `richContentBlocks` filter 处被静默过滤——
     * Android 用户打开任意历史会话所有富内容卡片 100% 不可见（B2 假登记暴露的当下生产故障）。
     *
     * 两个字面量都识别后，Android 历史回放与直播路径行为一致：富内容卡片正常显示。
     */
    val isRichContent: Boolean
        get() = type == "rich_content" || type == "tabtin_rich_content"

    /**
     * 把标准 `tabtin_rich_content.payload` 归一到 Android 既有扁平展示模型。
     * 顶层旧字段优先，payload 仅作 fallback，因此兼容既有直播块与旧历史数据。
     */
    public fun normalizedRichContent(): BlockItem {
        if (!isRichContent) return this
        val nested = payload ?: return this

        fun String?.orPayload(vararg keys: String): String? =
            this?.takeIf { it.isNotBlank() }
                ?: keys.firstNotNullOfOrNull { key -> nested.string(key) }

        val normalizedKind = kind.orPayload("kind", "type")
        val formalImage = formalOssImagePayload(normalizedKind, nested)

        return copy(
            kind = normalizedKind,
            summary = summary.orPayload("summary"),
            title = title.orPayload("title", "name", "filename"),
            caption = caption.orPayload("caption"),
            columns = columns ?: nested.array("columns"),
            rows = rows ?: nested.array("rows"),
            totalRows = totalRows ?: nested.int("total_rows") ?: nested.int("total"),
            resourceType = resourceType.orPayload("resource_type"),
            resourceId = resourceId.orPayload("resource_id", "id"),
            resourceName = resourceName.orPayload("resource_name", "name"),
            locationHint = locationHint.orPayload("location_hint"),
            spaceId = spaceId.orPayload("space_id"),
            organizationId = organizationId.orPayload("organization_id"),
            workspaceId = workspaceId.orPayload("workspace_id"),
            spaceName = spaceName.orPayload("space_name"),
            // 正式 OSS 图片的 payload.url 是资源身份 URI，不是图片下载地址。
            // file_id 保留给展示层刷新；这里只保留可直接预览的兼容地址。
            url = if (formalImage != null) {
                formalImage.fallbackUrl
            } else {
                url.orPayload("url", "image_url", "file_url", "remote_url")
            },
            fileId = formalImage?.fileId ?: fileId.orPayload("file_id", "fileId"),
            artifactKind = artifactKind.orPayload("artifact_kind"),
            relativePath = relativePath.orPayload("relative_path"),
            previewUrl = previewUrl.orPayload("preview_url"),
            filename = filename.orPayload("filename", "file_name"),
            mimeType = mimeType.orPayload("mime_type"),
            altText = altText.orPayload("alt_text"),
            fileSize = fileSize ?: nested.long("file_size") ?: nested.long("size"),
            widgetId = widgetId.orPayload("widget_id", "widgetId"),
            code = code.orPayload("code"),
            format = format.orPayload("format"),
            imageUrl = imageUrl.orPayload("image_url"),
            loadingMessage = loadingMessage.orPayload("loading_message"),
            toolCallId = toolCallId.orPayload("tool_call_id"),
            sourceToolUseId = sourceToolUseId.orPayload("source_tool_use_id"),
            sourceCode = sourceCode.orPayload("source_code", "sourceCode"),
            mermaidSource = mermaidSource.orPayload("mermaid_source", "mermaidSource"),
            renderedCode = renderedCode.orPayload("rendered_code"),
            groupId = groupId.orPayload("group_id"),
            groupTitle = groupTitle.orPayload("group_title"),
            interruptedAt = interruptedAt ?: nested.long("interrupted_at"),
            interruptedStatus = interruptedStatus.orPayload("interrupted_status"),
            cliCommand = cliCommand.orPayload("cli_command"),
            cliColumns = cliColumns ?: nested.array("cli_columns"),
            cliRows = cliRows ?: nested.array("cli_rows"),
            cliRecord = cliRecord ?: nested["cli_record"],
            cliRowCount = cliRowCount ?: nested.int("cli_row_count"),
            query = query.orPayload("query"),
            searchResults = searchResults ?: nested.array("search_results"),
            memories = memories ?: nested.array("memories"),
            parseStatus = parseStatus.orPayload("parse_status"),
            parsedPages = parsedPages ?: nested.int("parsed_pages"),
            totalPages = totalPages ?: nested.int("total_pages"),
            documentChunks = documentChunks ?: nested.array("document_chunks"),
            totalCount = totalCount ?: nested.int("total_count") ?: nested.int("total"),
        )
    }
}

internal data class FormalOssImagePayload(
    val fileId: String,
    val fallbackUrl: String?,
)

/**
 * 统一识别 Agent Host 的正式图片资产协议。
 * `tabtin://resource/file/...` 仅表达资源身份，永远不能进入 HTTP 图片加载器。
 */
internal fun formalOssImagePayload(kind: String?, payload: JsonObject?): FormalOssImagePayload? {
    if (kind != "image" || payload?.string("artifact_kind") != "oss_file") return null
    val fileId = payload.string("file_id") ?: payload.string("fileId") ?: return null
    val fallbackUrl = listOf(
        "resolved_url",
        "access_url",
        "cdn_url",
        "image_url",
        "file_url",
        "remote_url",
        "url",
    ).firstNotNullOfOrNull { key -> payload.string(key)?.takeIf(::isHttpImageUrl) }
    return FormalOssImagePayload(fileId = fileId, fallbackUrl = fallbackUrl)
}

internal fun isHttpImageUrl(value: String): Boolean =
    value.startsWith("https://", ignoreCase = true) ||
        value.startsWith("http://", ignoreCase = true)

/**
 * 把历史消息里的用户内容块完整转换回发送协议。
 *
 * 编辑重发和失败后的草稿恢复都必须复用这一个映射，尤其不能遗漏
 * field_ids / row_ids / memo_id / space 信息，否则精确引用会静默扩大或失真。
 */
public fun BlockItem.toOutboundMessageBlock(): MessageBlock? {
    val outboundType = type?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return MessageBlock(
        type = outboundType,
        content = content ?: text,
        fileId = fileId,
        filename = filename,
        mimeType = mimeType,
        size = size,
        url = url,
        tableId = tableId,
        docId = docId,
        memoId = memoId,
        fieldIds = fieldIds,
        rowIds = rowIds,
        preview = preview,
        spaceId = spaceId,
        spaceName = spaceName,
    )
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

private fun JsonObject.int(key: String): Int? =
    (this[key] as? JsonPrimitive)?.intOrNull

private fun JsonObject.long(key: String): Long? =
    (this[key] as? JsonPrimitive)?.longOrNull

private fun JsonObject.array(key: String): List<JsonElement>? =
    (this[key] as? JsonArray)?.toList()
