package com.tabtin.mobile.data.model

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Catalog `runtime_profile.thinking.modes` 白名单（与 Electron thinkingModeCapability 对齐）。 */
public val THINKING_MODE_VALUES: Set<String> = setOf("off", "standard", "deep")

/**
 * Catalog 思考能力投影。`supported && modes.nonEmpty` 才暴露 UI；
 * 选项严格用 Catalog `modes`（强制思考模型可能无 `off`）。
 */
public data class CatalogThinkingCapability(
    val modes: List<String>,
    val defaultMode: String,
)

/** 多档且至少一档 `is_user_selectable` → 可切换上下文长度。 */
public fun LlmModel.canSelectContextTier(): Boolean {
    val tiers = contextTiers
    return tiers.size > 1 && tiers.any { it.isUserSelectable }
}

/** 可切换档，或仅有只读 `context_window_tokens` → 展示「上下文长度」区块。 */
public fun LlmModel.shouldShowContextSelector(): Boolean {
    if (canSelectContextTier()) return true
    val tokens = contextWindowTokens ?: return false
    return tokens > 0
}

public fun LlmModel.catalogThinkingCapability(): CatalogThinkingCapability? {
    val thinking = runtimeProfile?.thinking ?: return null
    if (!thinking.supported) return null
    val modes = thinking.modes.map { it.trim().lowercase() }.filter { it in THINKING_MODE_VALUES }
    if (modes.isEmpty()) return null
    val defaultRaw = thinking.defaultMode?.trim()?.lowercase()
    val defaultMode = when {
        defaultRaw != null && defaultRaw in THINKING_MODE_VALUES && defaultRaw in modes -> defaultRaw
        "standard" in modes -> "standard"
        else -> modes.first()
    }
    return CatalogThinkingCapability(modes = modes, defaultMode = defaultMode)
}

/** L1「运行设置」入口：有可调档 / 只读窗口 / 思考能力任一即可。 */
public fun LlmModel.hasRuntimeSettings(): Boolean =
    shouldShowContextSelector() || catalogThinkingCapability() != null

/** 将 token 数格式化为产品文案：128K / 256K / 1M。 */
public fun formatContextWindowLabel(tokens: Long): String {
    if (tokens <= 0L) return ""
    if (tokens >= 1_000_000L) {
        val m = tokens.toDouble() / 1_000_000.0
        val rounded = kotlin.math.round(m * 10.0) / 10.0
        return if (rounded == rounded.toLong().toDouble()) {
            "${rounded.toLong()}M"
        } else {
            "${rounded}M"
        }
    }
    if (tokens >= 1_000L) return "${(tokens + 500) / 1_000}K"
    return tokens.toString()
}

public fun formatContextWindowLabel(tokens: Int): String = formatContextWindowLabel(tokens.toLong())

public fun resolveActiveContextTierId(
    model: LlmModel,
    selectedTierId: String?,
): String? {
    if (!model.canSelectContextTier()) return null
    val tiers = model.contextTiers
    val selected = selectedTierId?.trim()?.takeIf { it.isNotEmpty() }
    if (selected != null && tiers.any { it.id == selected }) return selected
    return tiers.firstOrNull { it.isDefault }?.id ?: tiers.firstOrNull()?.id
}

public fun resolveActiveThinkingMode(
    overrides: JsonObject?,
    selectedMode: String?,
    capability: CatalogThinkingCapability,
): String {
    val fromSelection = selectedMode?.trim()?.lowercase()?.takeIf { it in capability.modes }
    if (fromSelection != null) return fromSelection
    val fromOverrides = overrides.thinkingMode()?.takeIf { it in capability.modes }
    if (fromOverrides != null) return fromOverrides
    return capability.defaultMode
}

public fun JsonObject?.thinkingMode(): String? {
    val raw = this?.get("thinking_mode") as? JsonPrimitive ?: return null
    return raw.contentOrNull?.trim()?.lowercase()?.takeIf { it in THINKING_MODE_VALUES }
}

/** 桌面端响应策略意图；普通 Composer UI 不写入，但 merge 时必须保留。 */
public fun JsonObject?.performanceProfile(): String? {
    val raw = this?.get("performance_profile") as? JsonPrimitive ?: return null
    return raw.contentOrNull?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
}

/**
 * 构造 PUT `/model-params` 的 v2 body：更新 `thinking_mode`，保留既有 `performance_profile`。
 * 对齐 iOS `ChatModelParamOverrides.thinkingModeV2(_:preserving:)`。
 */
public fun modelParamOverridesWriteForThinkingMode(
    thinkingMode: String,
    preserving: JsonObject? = null,
): ModelParamOverridesWrite = ModelParamOverridesWrite(
    v = 2,
    thinkingMode = thinkingMode.trim().lowercase(),
    performanceProfile = preserving.performanceProfile(),
)

/** 工具条 / 运行设置入口摘要：`200K · 深度`。 */
public fun runtimeSettingsSummary(
    model: LlmModel,
    contextTierId: String?,
    thinkingMode: String?,
    thinkingLabels: Map<String, String>,
): String? {
    val parts = mutableListOf<String>()
    if (model.canSelectContextTier()) {
        val tierId = resolveActiveContextTierId(model, contextTierId)
        val label = model.contextTiers.firstOrNull { it.id == tierId }?.label
            ?: tierId
        if (!label.isNullOrBlank()) parts += label
    } else {
        model.contextWindowTokens?.takeIf { it > 0 }?.let { parts += formatContextWindowLabel(it) }
    }
    model.catalogThinkingCapability()?.let { capability ->
        val mode = resolveActiveThinkingMode(
            overrides = null,
            selectedMode = thinkingMode,
            capability = capability,
        )
        thinkingLabels[mode]?.let { parts += it }
    }
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}
