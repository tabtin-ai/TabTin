package com.tabtin.mobile.features.conversation

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * `RichTablePreview` 用到的 schema 桥接 helper —— 从 `RichContentSection.kt`
 * 抽离的纯数据转换工具，不依赖 `androidx.compose`。
 *
 * **抽离动机**：`RichContentSection.kt` 同时含 `@Composable` 函数和纯数据
 * 转换 helper，把 helper 抽到独立文件后可被纯 JUnit 测试覆盖（无需 Compose
 * 运行时），同时承担"双端 (iOS/Android) schema 解析行为对齐"的单一职责。
 *
 * **服务端真实 schema**（`present_to_user.py`）：
 *   columns: `[{"key": "region", "label": "地区"}, ...]`
 *   rows:    `[{"region": "华东", "sales": "1234"}, ...]`
 *
 * 同时保留对老式 `[String]` / `[[String]]` schema 的向后兼容（防御性兜底，
 * 服务端从未推过此格式）。
 *
 * ---
 *
 * **如何复跑 RichTablePreviewSchemaTest 全部测试**：
 *
 * Wave A0（2026-05-03）已退役 `schema-bridge-test.gradle.kts` 旁路。
 * main set 0 错 + test set 已能编译，标准 `:app:testDebugUnitTest` 即可：
 *
 * ```bash
 * cd apps/tabtin-android
 * ./gradlew :app:testDebugUnitTest --tests \
 *     'com.tabtin.mobile.features.conversation.RichTablePreviewSchemaTest'
 * ```
 *
 * 测试结果产出在 `app/build/test-results/testDebugUnitTest/TEST-*.xml`。
 */

/**
 * 列表头取值。
 * - JsonObject（服务端真实 schema）：先取 "label"，fallback "key"，再 fallback 整体 toString
 *   * `takeIf { isNotEmpty() }`：空字符串 label / key 视同缺失，避免表头空白让用户看不出列。
 *     这是与 iOS `TableSchemaBridge.headerLabel` 用 `!isEmpty` 行为对齐的关键防线——
 *     服务端推 `{"label":"","key":"region"}` 时双端都应该显示 "region" 而不是空表头。
 * - JsonPrimitive（老式 [String]）：直接取 content
 * - 其他（嵌套数组/null）：toString 兜底，绝不返回 "…"
 */
internal fun columnLabel(column: JsonElement): String = when (column) {
    is JsonObject -> column.primitiveString("label")?.takeIf { it.isNotEmpty() }
        ?: column.primitiveString("key")?.takeIf { it.isNotEmpty() }
        ?: truncate(column.toString())
    is JsonPrimitive -> if (column is JsonNull) "" else column.content
    is JsonArray -> truncate(column.toString())
}

/**
 * 列 key 取值。
 * - JsonObject：取 "key"；没有就 null（让 row 取值落回 index 模式）
 * - JsonPrimitive（老式）：取 content（columns=[String] 时 key 就是 label 本身）
 * - 其他：null
 */
internal fun columnKey(column: JsonElement): String? = when (column) {
    is JsonObject -> column.primitiveString("key")
    is JsonPrimitive -> if (column is JsonNull) null else column.content
    else -> null
}

/**
 * row cell 取值，支持两种 row 形态：
 * - JsonObject（服务端真实）：根据 columnKey 取 row[col_key]
 * - JsonArray（老式）：用 columnIndex 取
 * - JsonPrimitive：仅 column 0 返回内容（bool 走 primitiveCellContent → ✓/✗，与 iOS 一致）
 * - JsonNull / 其他：空
 */
internal fun rowCellAt(row: JsonElement, columnIndex: Int, columnKey: String?): String = when (row) {
    is JsonObject -> if (columnKey != null) row[columnKey].cellString() else ""
    is JsonArray -> row.getOrNull(columnIndex).cellString()
    is JsonPrimitive -> if (columnIndex == 0 && row !is JsonNull) row.primitiveCellContent() else ""
}

internal fun JsonElement?.cellString(): String = when (this) {
    null -> ""
    is JsonNull -> ""
    is JsonPrimitive -> primitiveCellContent()
    is JsonObject -> primitiveString("label")
        ?: primitiveString("value")
        ?: truncate(this.toString())
    is JsonArray -> joinToString(", ") { it.cellString() }
}

/**
 * JsonPrimitive → cell 显示。
 * - bool 显示 ✓ / ✗，与 iOS TableSchemaBridge 行为对齐
 * - 其他原始值直接走 content
 */
internal fun JsonPrimitive.primitiveCellContent(): String {
    if (!isString) {
        when (content) {
            "true" -> return "✓"
            "false" -> return "✗"
        }
    }
    return content
}

internal fun JsonObject.primitiveString(key: String): String? {
    val el = this[key] ?: return null
    if (el is JsonNull) return null
    val prim = el as? JsonPrimitive ?: return null
    return prim.primitiveCellContent()
}

/**
 * 长字符串截断到 80 字符避免撑爆 markdown 表格列宽。
 */
internal fun truncate(s: String, max: Int = 80): String =
    if (s.length > max) s.substring(0, max) + "…" else s

/**
 * 把 cell 内容里的 `|` / 换行字符 escape 掉，避免破坏 markdown 表格语法导致整行错位。
 * 这是 markdown table 渲染的 ABC——cell 含管道符 / 换行 一定要 escape，不然整张表错位。
 */
internal fun String.markdownCellSafe(): String =
    replace("|", "\\|").replace('\n', ' ').replace('\r', ' ')

/**
 * 把 BlockItem 中 columns + rows 拼成 markdown 表格字符串。
 * 抽离原因：这段拼接逻辑原本在 `RichTablePreview` Composable 里 `remember` 块内，
 * helper 单测无法守住"helper 单独正确 ≠ 拼出来的 markdown 正确"——任何对
 * separator 行格式 / joinToString 分隔符 / header-separator-rows 顺序的误改
 * 都会让用户看到错位的表格而 helper 测试照样全 PASS（典型 silent corruption）。
 *
 * 抽出后可端到端断言：
 *   buildTableMarkdown([{key:"region", label:"地区"}, ...], [{region:"华东"}, ...])
 *     == "| 地区 | 销量 |\n| --- | --- |\n| 华东 | 1234 |\n..."
 */
/**
 * 服务端推 `total_rows`（截断前的全表行数）大于实际渲染行数时返回 true，让 caller
 * 在表格下方渲染"显示 X / Y 行"截断提示。
 *
 * 严格 `>` 判定与桌面 `RichContentRenderer.tsx:267` `totalRows > visibleRows.length`
 * 字面一致——相等时不显示 footer（用户实际看到的就是全表，不需要提示）。
 *
 * 边界 case：
 *   - total == null（旧服务端 / 旧 payload）→ false
 *   - total <= rendered（含 0、负数、相等）→ false
 *   - total > rendered（服务端真在截断）→ true
 */
internal fun shouldShowTruncation(rendered: Int, total: Int?): Boolean =
    total != null && total > rendered

internal fun buildTableMarkdown(
    columns: List<JsonElement>,
    rows: List<JsonElement>?,
): String {
    val headerLabels = columns.map { columnLabel(it).markdownCellSafe() }
    val columnKeys = columns.map { columnKey(it) }
    return buildString {
        appendLine("| ${headerLabels.joinToString(" | ")} |")
        appendLine("| ${headerLabels.joinToString(" | ") { "---" }} |")
        rows?.forEach { row ->
            val cells = columnKeys.mapIndexed { index, key ->
                rowCellAt(row, index, key).markdownCellSafe()
            }
            appendLine("| ${cells.joinToString(" | ")} |")
        }
    }
}

/**
 * `RichTablePreview` 的渲染计划——把"哪些 segment 视觉可见 / a11y 朗读什么"的
 * 决策从 Composable 抽出来变成纯函数，方便单测断言"视觉层不渲染 summary"，
 * 防止未来 silent regression（有人把 summary Text 加回 Composable）。
 *
 * **桌面对齐基线**（`apps/tabtin-electron/.../RichContentRenderer.tsx` 的 RichTablePreview）：
 * - 视觉只渲染：`title`（如有） + 表格本体 + 截断 footer（如有）
 * - **不渲染** `summary`——summary 在 `present_to_user.py` spec 里定位为「移动端 fallback +
 *   无障碍」，本质是兜底文案不是主 UI 文案。Wave 0.5 加 title 后「summary + title」两段
 *   文字意义重复。
 *
 * **a11y 兜底**：summary 仍保留在 BlockItem 字段中，渲染层把 `summary + title` 合并成
 * 父容器的 `contentDescription`，让 TalkBack / VoiceOver 朗读完整兜底文案——视障用户
 * 不会因为视觉层不渲染就听不到 summary。这是 summary 真正应该承担的角色。
 *
 * 返回 null 表示 columns 缺失/空 → caller 走 `RichFallback`（与原有 `if columns.isNullOrEmpty()`
 * 行为一致）。
 */
internal data class TablePreviewRenderPlan(
    /** 视觉层显示的 title 文本（空字符串视同缺失，与原 `takeIf { isNotEmpty() }` 行为一致）。 */
    val visibleTitle: String?,
    /** 视觉层渲染的 markdown 表格字符串。 */
    val markdownTable: String,
    /** 截断 footer：null 表示不显示；非 null 时含 rendered / total 给 stringResource 格式化。 */
    val truncationFooter: TruncationFooter?,
    /**
     * 父容器 `contentDescription`：把 summary（兜底文案）+ visible title（视觉文本）
     * 合并成一段朗读文本。两个都空时返回 null（让 TalkBack 走 children 默认朗读）。
     */
    val accessibilityLabel: String?,
) {
    /// 截断 footer 数据结构——具名字段而非 `Pair<Int, Int>`，与 iOS
    /// `TableSchemaBridge.TablePreviewRenderPlan.TruncationFooter` 字段名对齐。
    /// 用 Pair 时双端类型不对称，未来对其中一端改 footer 语义另一端可能漏改（review 反馈）。
    internal data class TruncationFooter(val rendered: Int, val total: Int)
}

internal fun planTablePreviewRender(
    title: String?,
    summary: String?,
    columns: List<JsonElement>?,
    rows: List<JsonElement>?,
    totalRows: Int?,
): TablePreviewRenderPlan? {
    if (columns.isNullOrEmpty()) return null
    val visibleTitle = title?.takeIf { it.isNotEmpty() }
    val markdown = buildTableMarkdown(columns, rows)
    val rendered = rows?.size ?: 0
    val footer = if (shouldShowTruncation(rendered, totalRows) && totalRows != null) {
        TablePreviewRenderPlan.TruncationFooter(rendered = rendered, total = totalRows)
    } else {
        null
    }
    val cleanSummary = summary?.takeIf { it.isNotEmpty() }
    val a11yLabel = listOfNotNull(cleanSummary, visibleTitle)
        .takeIf { it.isNotEmpty() }
        ?.joinToString(separator = " — ")
    return TablePreviewRenderPlan(
        visibleTitle = visibleTitle,
        markdownTable = markdown,
        truncationFooter = footer,
        accessibilityLabel = a11yLabel,
    )
}

// MARK: - Widget Render Plan (Wave 4)

/**
 * Widget 渲染计划——把 RichWidget Composable 的"哪些 UI 路径走 / a11y 朗读什么"决策
 * 抽出来变成纯函数，方便 JVM 单测断言（与 schema-bridge-test pipeline 对齐）。
 *
 * 三种渲染路径（按 `imageUrl` 状态分流）：
 *   1. **imageUrl 非空**：内联显示烤图 + 点击全屏 ImagePreviewDialog
 *   2. **imageUrl 空字符串 / 缺失**：A 子 Agent 烤图失败兜底信号——显示 widget 容器
 *      + summary + 明显的"在桌面端查看"按钮
 *   3. **imageUrl 网络错误**：caller (RichWidget) 用 AsyncImage onState Error 兜底
 *
 * **跨端字面对齐**（与 iOS `WidgetRenderBridge.WidgetRenderPlan` 字面对齐）：
 * 相同 BlockItem 输入双端 plan 字段值字面相等（imageUrl / shouldShowBakeFailedFallback /
 * accessibilityLabel）。任何修改双端必须同步——包括 a11y 分隔符（` — `）/ 空字段处理 /
 * image_url 空字符串判定逻辑。
 */
internal data class WidgetRenderPlan(
    /**
     * 烤图 URL 字符串（非空非空字符串才返回；空字符串 / null 都视同"烤图失败"）。
     *
     * null 信号：image_url 字段缺失 / 空字符串。**RichWidget 走烤图失败兜底分支**——
     * 显示 summary + "在桌面端查看"明显按钮。
     *
     * Android 不像 iOS 用 `URL(string:)` 构造——Compose AsyncImage 直接接 String，
     * 无效 URL 走 painter Error 状态。所以 plan 字段保留 String? 而不是 Uri?——
     * 跟双端字面对齐用 String? 反而更自然（Android Uri 双端不对称）。
     */
    val imageUrl: String?,
    /** 视觉 title（block.title 非空字符串才返回；fallback / image 路径都用同一个）。 */
    val visibleTitle: String?,
    /** 视觉 summary（block.summary 非空字符串才返回；image 路径下做图片下方 caption）。 */
    val visibleSummary: String?,
    /**
     * 父容器 contentDescription：把 widgetBadge（"图示"）+ visibleTitle + visibleSummary
     * 合并成 TalkBack 朗读文本，让视障用户在视觉退化时仍能听到完整上下文。
     *
     * 与桌面端 `RichWidget` aria-label 模式（`${widgetTypeLabel}${statePrefix}：${summaryLabel}`）
     * 字面对齐——移动端不显示 statePrefix（Wave 7 才接 streaming/interrupted 状态）。
     */
    val accessibilityLabel: String,
    /**
     * Mermaid fallback 源码——**仅在烤图失败 fallback 分支 + format == "mermaid"
     * + mermaid_source/source_code 字段非空**时返回。非 null 时 RichWidget 在
     * "在桌面端查看"按钮旁加一个折叠面板，展开后显示等宽字体 mermaid 源码，
     * 用户至少能拷贝源码到桌面端复现。
     *
     * **为什么仅限 Mermaid**：SVG widget 源码对用户不可读（一大串 path / 坐标），
     * 展开让用户看 SVG 源码反而增加认知负担。Mermaid 源码是 DSL（"graph TD;
     * A-->B"）用户能读能改，是合理的降级入口。HTML widget 本轮不开（Wave 6 才
     * 开，且 HTML 源码对非技术用户也不友好）。
     *
     * **取值顺序**：优先 `mermaid_source` 后 `source_code`——Wave 6 服务端 Python
     * mirror 暂不编译 Mermaid 只保留 `source_code`（harness §3 #13 已登记），
     * 移动端需要兜住两种字段都可能承载原始源码的场景。
     *
     * **跨端字面对齐**（与 iOS `WidgetRenderPlan.mermaidFallbackSource`）：相同
     * block 输入双端字段值字面相等；任何修改双端必须同步——包括 format 小写化
     * 匹配、mermaid_source 优先于 source_code 的取值顺序。
     */
    val mermaidFallbackSource: String?,
) {
    /** 是否走烤图失败兜底分支（== `imageUrl == null`，提供显式字段方便测试断言意图）。 */
    val shouldShowBakeFailedFallback: Boolean get() = imageUrl == null
}

/**
 * 决策 plan：RichWidget 完全走这套规则——image_url 非空 + 有 http(s) scheme → 走 image
 * 路径，否则走烤图失败 fallback。caller（RichWidget Composable）只负责 Compose 视图实例化。
 *
 * **注意**：image_url == "" 和 image_url 缺失等价（都 → null）。这是 A 子 Agent 烤图
 * 失败的契约——不是抛工具 fail，而是 emit RICH_CONTENT 但 image_url 缺/空。
 *
 * **URL 严格校验**（与 iOS `WidgetRenderBridge.planRender` URL scheme 校验对齐）：
 * 仅接受以 `http://` 或 `https://`（大小写不敏感）开头的字符串当作有效 URL。OSS 烤图
 * URL 总是 https，这条假设安全。这道防线让"服务端推一段非 URL 的脏数据"被拦在 plan
 * 层走 fallback，渲染层不至于把脏数据塞给 AsyncImage 让网络层报错（用户看到的体验
 * 仍然是"能看到 widget 兜底信息"，不是空白崩溃）。
 */
internal fun planWidgetRender(
    widgetBadgeLabel: String,
    title: String?,
    summary: String?,
    imageUrl: String?,
    format: String? = null,
    mermaidSource: String? = null,
    sourceCode: String? = null,
): WidgetRenderPlan {
    val cleanedURL = imageUrl
        ?.takeIf { it.isNotEmpty() }
        ?.takeIf { it.startsWith("http://", ignoreCase = true) || it.startsWith("https://", ignoreCase = true) }
    val visibleTitle = title?.takeIf { it.isNotEmpty() }
    val visibleSummary = summary?.takeIf { it.isNotEmpty() }
    val a11yLabel = listOfNotNull(widgetBadgeLabel, visibleTitle, visibleSummary)
        .joinToString(separator = " — ")
    // Mermaid fallback 门槛（与 iOS `WidgetRenderBridge.planRender` 字面对齐）：
    //   1. 走 fallback 分支（cleanedURL == null）——有图时不挂源码抢焦点
    //   2. format 明确是 mermaid（case-insensitive，防服务端推 "Mermaid" 大小写漂移
    //      让源码入口失踪）
    //   3. mermaid_source 或 source_code 字段真有内容
    val mermaidFallback: String? = when {
        cleanedURL != null -> null
        format?.lowercase() != "mermaid" -> null
        !mermaidSource.isNullOrEmpty() -> mermaidSource
        !sourceCode.isNullOrEmpty() -> sourceCode
        else -> null
    }
    return WidgetRenderPlan(
        imageUrl = cleanedURL,
        visibleTitle = visibleTitle,
        visibleSummary = visibleSummary,
        accessibilityLabel = a11yLabel,
        mermaidFallbackSource = mermaidFallback,
    )
}
