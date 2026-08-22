package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ApprovalActionRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * 审批入参的展示投射层。与 iOS `ApprovalPresentation`（`HITL/HITLModels.swift`）同口径：
 * 同一份 fieldGroups、同一套分层规则、同一套风险显示门槛。
 *
 * 存在的理由：审批面板过去直接甩 `toolInputJson.take(600)` 的 raw JSON，用户读不出
 * 「到底要执行什么」。这里把任意 JSON 投射成稳定的「字段名 + 值」，已知字段用产品词汇，
 * 未知字段也逐项展开——不丢信息，但也不再让整段 JSON 占据决策视线。
 *
 * 文案一律走 string 资源 id 而不是字面量：iOS 侧硬编码中文可以接受（单语言包），
 * Android 有 values-en，硬编码会让英文环境露出中文。
 */
internal object ApprovalPresentation {

    private val LENIENT_JSON = Json { ignoreUnknownKeys = true; isLenient = true }

    /** 主区最多两条字段——再多就不是「一眼看懂」，而是又一屏小字。 */
    internal const val PRIMARY_ROW_LIMIT = 2

    private data class FieldGroup(
        val keys: List<String>,
        @StringRes val labelResId: Int,
        val style: ApprovalValueStyle,
    )

    /** 顺序即优先级，必须与 iOS `fieldGroups` 保持一致。 */
    private val fieldGroups: List<FieldGroup> = listOf(
        FieldGroup(
            keys = listOf("command", "cmd", "shell_command", "shell", "script"),
            labelResId = R.string.chat_approval_field_command,
            style = ApprovalValueStyle.CODE,
        ),
        FieldGroup(
            keys = listOf("path", "file_path", "filepath", "target_file", "file", "uri", "destination"),
            labelResId = R.string.chat_approval_field_path,
            style = ApprovalValueStyle.PATH,
        ),
        FieldGroup(
            keys = listOf("cwd", "working_dir", "workdir", "directory", "dir"),
            labelResId = R.string.chat_approval_field_directory,
            style = ApprovalValueStyle.PATH,
        ),
        FieldGroup(
            keys = listOf("url", "href"),
            labelResId = R.string.chat_approval_field_url,
            style = ApprovalValueStyle.CODE,
        ),
        FieldGroup(
            keys = listOf("query", "search_query", "search_term", "prompt", "question", "input"),
            labelResId = R.string.chat_approval_field_query,
            style = ApprovalValueStyle.TEXT,
        ),
        FieldGroup(
            keys = listOf("pattern", "regex", "glob", "include", "exclude"),
            labelResId = R.string.chat_approval_field_pattern,
            style = ApprovalValueStyle.CODE,
        ),
        FieldGroup(
            keys = listOf("skill"),
            labelResId = R.string.chat_approval_field_skill,
            style = ApprovalValueStyle.TEXT,
        ),
    )

    /** `explanation` 是模型给人看的说明，单独渲染成摘要，不混进参数行。 */
    internal fun explanation(
        toolInputJson: String?,
        valueLabels: ApprovalValueLabels = ApprovalValueLabels.DEFAULT,
    ): String? {
        val root = parseObject(toolInputJson) ?: return null
        return displayValue(root["explanation"], valueLabels)
    }

    internal fun parameterRows(
        toolInputJson: String?,
        valueLabels: ApprovalValueLabels = ApprovalValueLabels.DEFAULT,
    ): List<ApprovalParameterRow> {
        val root = parseObject(toolInputJson) ?: return emptyList()
        val rows = mutableListOf<ApprovalParameterRow>()
        val consumed = mutableSetOf("explanation")

        for (group in fieldGroups) {
            val key = group.keys.firstOrNull { displayValue(root[it], valueLabels) != null } ?: continue
            val value = displayValue(root[key], valueLabels) ?: continue
            rows += ApprovalParameterRow(
                key = key,
                label = ApprovalFieldLabel.Res(group.labelResId),
                value = value,
                style = group.style,
            )
            consumed += group.keys
        }

        // Skill 调用的实参单独成行，否则会掉进「未知字段」按字母序展开。
        if (rows.any { it.label == ApprovalFieldLabel.Res(R.string.chat_approval_field_skill) }) {
            displayValue(root["args"], valueLabels)?.let { value ->
                rows += ApprovalParameterRow(
                    key = "args",
                    label = ApprovalFieldLabel.Res(R.string.chat_approval_field_args),
                    value = value,
                    style = ApprovalValueStyle.TEXT,
                )
                consumed += "args"
            }
        }

        for (key in root.keys.sorted()) {
            if (key in consumed) continue
            val value = displayValue(root[key], valueLabels) ?: continue
            rows += ApprovalParameterRow(
                key = key,
                label = ApprovalFieldLabel.Raw(friendlyLabel(key)),
                value = value,
                style = inferredStyle(key),
            )
        }
        return rows
    }

    internal fun layout(
        toolInputJson: String?,
        valueLabels: ApprovalValueLabels = ApprovalValueLabels.DEFAULT,
    ): ApprovalActionLayout = layout(parameterRows(toolInputJson, valueLabels))

    /**
     * 把参数行分成三段：命令块 / 主区字段（最多两条已知语义字段）/ 折叠区。
     *
     * 决策视线只留「做什么」，未知字段与超额的已知字段一律收进折叠区——
     * 这是本次改造的核心：不再让一屏同权重灰字把关键信息淹没。
     */
    internal fun layout(rows: List<ApprovalParameterRow>): ApprovalActionLayout {
        val commandLabel = ApprovalFieldLabel.Res(R.string.chat_approval_field_command)
        val candidates = rows.toMutableList()
        val commandIndex = candidates.indexOfFirst { it.label == commandLabel }
        val command = if (commandIndex >= 0) candidates.removeAt(commandIndex) else null

        val primaryRows = mutableListOf<ApprovalParameterRow>()
        val collapsedRows = mutableListOf<ApprovalParameterRow>()
        for (row in candidates) {
            // 已知语义字段（来自 fieldGroups）才有资格进主区；未知字段一律折叠。
            if (primaryRows.size < PRIMARY_ROW_LIMIT && row.label is ApprovalFieldLabel.Res) {
                primaryRows += row
            } else {
                collapsedRows += row
            }
        }
        return ApprovalActionLayout(
            command = command,
            primaryRows = primaryRows,
            collapsedRows = collapsedRows,
        )
    }

    /**
     * 要不要为这条操作占一行风险提示。
     *
     * 普通低风险不占位；但越界 / 敏感资源即使 risk_level=low，也必须保留一行
     * 可见提示，删除 severity 侧条后不能让这类决策退化成中性卡片。
     */
    internal fun riskHint(riskLevel: String?, workspaceZone: String?): ApprovalRiskHint? {
        val zoneResId = when (workspaceZone) {
            "sensitive" -> R.string.chat_approval_risk_zone_sensitive
            "outside" -> R.string.chat_approval_risk_zone_outside
            else -> null
        }
        return when (riskLevel) {
            "high" -> ApprovalRiskHint(
                riskResId = R.string.chat_approval_risk_high,
                zoneResId = zoneResId,
                emphasis = ApprovalRiskEmphasis.CRITICAL,
            )
            "medium", "review" -> if (zoneResId == null) {
                null
            } else {
                ApprovalRiskHint(
                    riskResId = R.string.chat_approval_risk_medium,
                    zoneResId = zoneResId,
                    emphasis = ApprovalRiskEmphasis.WARNING,
                )
            }
            else -> zoneResId?.let {
                ApprovalRiskHint(
                    riskResId = R.string.chat_approval_risk_medium,
                    zoneResId = it,
                    emphasis = ApprovalRiskEmphasis.WARNING,
                )
            }
        }
    }

    /**
     * 工作区归属：payload 字段优先，缺失时从判决理由反推。
     *
     * 为什么要兜底：`workspace_zone` 在 runtime 生产链路上**并未下发**，
     * 直接读字段会恒为 null，于是「越界操作必须展开确认」这条门槛会静默失效。
     * 判决理由是同一事实的另一种表达，且确实有下发。字段放在前面，是为了 runtime
     * 补发之后不必再改这里。iOS `ApprovalPresentation.workspaceZone(for:)` 同口径。
     */
    internal fun workspaceZone(action: ApprovalActionRequest): String? {
        action.workspaceZone?.takeIf { it == "outside" || it == "sensitive" }?.let { return it }
        return when (action.decisionReasonType) {
            "workspace_out", "deny_read_path", "deny_write_path" -> "outside"
            "sensitive_in_ask", "sensitive_out_deny" -> "sensitive"
            else -> null
        }
    }

    /**
     * 收起态（Dock）能否一键放行。手机上单手误触代价高，只有「单条 + 非高风险 + 工作区内」
     * 才允许直接批准；其余一律要求展开详情后确认。
     *
     * 与 Electron `ApprovalAttentionDock.requiresDetailedReview` 同构（取反）。
     */
    internal fun allowsDirectApproval(actions: List<ApprovalActionRequest>): Boolean {
        if (detailsAreRedacted(actions)) return false
        val action = actions.singleOrNull() ?: return false
        if (action.riskLevel == "high") return false
        return workspaceZone(action) == null
    }

    /** Team-member redaction uses a sentinel tool name; no surface may expose a decision for it. */
    internal fun detailsAreRedacted(actions: List<ApprovalActionRequest>): Boolean =
        actions.any { it.toolName.equals("redacted_tool", ignoreCase = true) }

    /** 整批的严重度，决定行首图标与风险色。任一条高危即整批高危。 */
    internal fun severity(actions: List<ApprovalActionRequest>): ApprovalSeverity {
        var resolved = ApprovalSeverity.NEUTRAL
        for (action in actions) {
            val zone = workspaceZone(action)
            if (action.riskLevel == "high" || zone == "sensitive") {
                return ApprovalSeverity.CRITICAL
            }
            if (action.riskLevel == "medium" || action.riskLevel == "review" || zone == "outside") {
                resolved = ApprovalSeverity.WARNING
            }
        }
        return resolved
    }

    // MARK: 内部

    /** 解析失败一律回落到 null——绝不把原始 JSON 再甩回 UI。 */
    private fun parseObject(toolInputJson: String?): JsonObject? {
        if (toolInputJson.isNullOrBlank()) return null
        return runCatching { LENIENT_JSON.parseToJsonElement(toolInputJson).jsonObject }.getOrNull()
    }

    private fun displayValue(value: JsonElement?, labels: ApprovalValueLabels): String? {
        if (value == null || value is JsonNull) return null
        return when (value) {
            is JsonPrimitive -> primitiveValue(value, labels)
            is JsonArray -> value.mapNotNull { displayValue(it, labels) }
                .takeIf { it.isNotEmpty() }
                ?.joinToString("、")
            is JsonObject -> value.keys.sorted()
                .mapNotNull { key ->
                    displayValue(value[key], labels)?.let { "${friendlyLabel(key)}：$it" }
                }
                .takeIf { it.isNotEmpty() }
                ?.joinToString("；")
        }
    }

    private fun primitiveValue(value: JsonPrimitive, labels: ApprovalValueLabels): String? {
        if (value.isString) return value.content.trim().takeIf { it.isNotEmpty() }
        value.booleanOrNull?.let { return if (it) labels.yes else labels.no }
        value.longOrNull?.let { return it.toString() }
        value.doubleOrNull?.let { number ->
            return if (number == Math.floor(number) && !number.isInfinite()) {
                number.toLong().toString()
            } else {
                number.toString()
            }
        }
        return value.content.trim().takeIf { it.isNotEmpty() }
    }

    private fun friendlyLabel(key: String): String = key.replace('_', ' ').replace('-', ' ')

    private fun inferredStyle(key: String): ApprovalValueStyle {
        val normalized = key.lowercase()
        if (normalized.contains("path") || normalized.contains("file")) {
            return ApprovalValueStyle.PATH
        }
        if (normalized.contains("command") || normalized == "cmd" ||
            normalized.contains("url") || normalized.contains("uri")
        ) {
            return ApprovalValueStyle.CODE
        }
        return ApprovalValueStyle.TEXT
    }
}

/** 字段名：已知语义字段走资源，未知字段直出 key 的可读形式。 */
internal sealed interface ApprovalFieldLabel {
    data class Res(@StringRes val id: Int) : ApprovalFieldLabel
    data class Raw(val text: String) : ApprovalFieldLabel
}

/** 值的排版：等宽或普通正文。与 iOS `ApprovalParameterRow.Style` 对齐。 */
internal enum class ApprovalValueStyle { TEXT, CODE, PATH }

internal data class ApprovalParameterRow(
    val key: String,
    val label: ApprovalFieldLabel,
    val value: String,
    val style: ApprovalValueStyle,
)

internal data class ApprovalActionLayout(
    val command: ApprovalParameterRow?,
    val primaryRows: List<ApprovalParameterRow>,
    val collapsedRows: List<ApprovalParameterRow>,
) {
    internal companion object {
        internal val EMPTY = ApprovalActionLayout(null, emptyList(), emptyList())
    }
}

internal enum class ApprovalRiskEmphasis { CRITICAL, WARNING }

internal data class ApprovalRiskHint(
    @StringRes val riskResId: Int,
    @StringRes val zoneResId: Int?,
    val emphasis: ApprovalRiskEmphasis,
)

/**
 * 整批审批的严重度。低风险走中性色——不着绿，因为我们没有担保它安全，
 * 只是风险分级低。
 */
internal enum class ApprovalSeverity { CRITICAL, WARNING, NEUTRAL }

/** 布尔值的本地化字面量。纯函数不持有 Context，由调用方注入。 */
internal data class ApprovalValueLabels(val yes: String, val no: String) {
    internal companion object {
        /** 单测与 fallback 用；UI 层应传入 `stringResource` 的结果。 */
        internal val DEFAULT = ApprovalValueLabels(yes = "是", no = "否")
    }
}
