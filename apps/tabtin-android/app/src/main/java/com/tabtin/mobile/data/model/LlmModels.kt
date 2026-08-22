package com.tabtin.mobile.data.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNames
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.math.RoundingMode
import java.text.NumberFormat

@Serializable
public data class LlmProvider(
    val id: String,
    val name: String,
    @SerialName("provider_key") val providerKey: String,
    @SerialName("display_name") val displayName: String,
    @SerialName("base_url") val baseUrl: String? = null,
    val scope: String? = null,
    @SerialName("is_active") val isActive: Boolean? = null,
    @SerialName("model_count") val modelCount: Int? = null,
)

/** Catalog 上下文档位（服务端已脱敏；不含 provider header / 计费私密配置）。 */
@Serializable
public data class LlmContextTier(
    val id: String,
    val label: String = id,
    @SerialName("is_default") val isDefault: Boolean = false,
    @SerialName("max_input_tokens") val maxInputTokens: Long? = null,
    val tags: List<String> = emptyList(),
    @SerialName("has_extra_headers") val hasExtraHeaders: Boolean = false,
    @SerialName("is_user_selectable") val isUserSelectable: Boolean = false,
)

/** Catalog `runtime_profile.thinking`（Canonical Runtime Profile）。 */
@Serializable
public data class LlmRuntimeProfileThinking(
    val supported: Boolean = false,
    val modes: List<String> = emptyList(),
    @SerialName("default_mode") val defaultMode: String? = null,
)

@Serializable
public data class LlmRuntimeProfile(
    val thinking: LlmRuntimeProfileThinking? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
public data class LlmModel(
    val id: String,
    @SerialName("model_name")
    @JsonNames("model_name", "name")
    val modelName: String,
    @SerialName("display_name") val displayName: String? = null,
    @SerialName("provider_id") val providerId: String? = null,
    @SerialName("provider") val providerName: String? = null,
    @SerialName("provider_display_name") val providerDisplayName: String? = null,
    @SerialName("provider_scope") val providerScope: String? = null,
    @SerialName("is_active") val isActive: Boolean? = null,
    @SerialName("capability_domain") val capabilityDomain: String? = null,
    @SerialName("wave_status") val waveStatus: String? = null,
    @SerialName("supports_document_input")
    private val declaredSupportsDocumentInput: Boolean? = null,
    @SerialName("resolved_capabilities") val resolvedCapabilities: Map<String, JsonElement>? = null,
    @SerialName("capabilities_config")
    private val capabilitiesConfig: Map<String, JsonElement>? = null,
    @SerialName("promotion_credit") val promotionCredit: PromotionCredit? = null,
    @SerialName("context_window_tokens") val contextWindowTokens: Long? = null,
    @SerialName("context_tiers") val contextTiers: List<LlmContextTier> = emptyList(),
    @SerialName("runtime_profile") val runtimeProfile: LlmRuntimeProfile? = null,
) {
    val title: String
        get() = displayName?.takeIf { it.isNotBlank() } ?: modelName

    /** 与 Electron 一致：顶层优先、嵌套回退，且只有显式 true 放行文档直传。 */
    val supportsDocumentInput: Boolean
        get() {
            val resolved = resolvedCapabilities
                ?.get("supports_document_input")
                ?.jsonPrimitive
                ?.booleanOrNull
            val configured = capabilitiesConfig
                ?.get("supports_document_input")
                ?.jsonPrimitive
                ?.booleanOrNull
            return (declaredSupportsDocumentInput ?: resolved ?: configured) == true
        }

    /** 模型选择器里的 Provider 赠享额度；能力关闭或模型不适用时不展示。 */
    val promotionCreditSummary: String?
        get() = promotionCredit?.takeIf { it.eligible }?.let { credit ->
            "赠享${formatPromotionCredit(credit.remainingCredits)}/${formatPromotionCredit(credit.totalCredits ?: credit.remainingCredits)}点券"
        }
}

public enum class LlmModelSource {
    PLATFORM,
    ORGANIZATION_BYOK,
    USER_BYOK,
}

/** 与桌面端一致：旧 catalog 缺少 scope、global 和未知值都按平台模型处理。 */
public val LlmModel.source: LlmModelSource
    get() = when (providerScope?.trim()?.lowercase()) {
        "organization" -> LlmModelSource.ORGANIZATION_BYOK
        "user" -> LlmModelSource.USER_BYOK
        else -> LlmModelSource.PLATFORM
    }

/** 服务端 `promotion_credit`：Feature Flag 关闭时字段缺失，旧服务端可能未返回 total_credits。 */
@Serializable
public data class PromotionCredit(
    val eligible: Boolean = false,
    @SerialName("remaining_credits") val remainingCredits: Double = 0.0,
    @SerialName("total_credits") val totalCredits: Double? = null,
)

internal fun formatPromotionCredit(credits: Double): String {
    val rounded = credits.toBigDecimal().setScale(0, RoundingMode.HALF_UP)
    return NumberFormat.getIntegerInstance().format(rounded)
}

/** 成功结算后只刷新当前目录中确有 Provider 专项点券的实际执行模型。 */
internal fun shouldRefreshPromotionCredit(modelId: String?, models: List<LlmModel>): Boolean =
    !modelId.isNullOrBlank() && models.firstOrNull { it.id == modelId }?.promotionCredit?.eligible == true

@Serializable
public data class ProvidersResponse(
    val providers: List<LlmProvider> = emptyList(),
    val total: Int? = null,
)

@Serializable
public data class ModelsResponse(
    val models: List<LlmModel> = emptyList(),
    val total: Int = 0,
    @SerialName("default_model_id") val defaultModelId: String? = null,
    @SerialName("default_model_name") val defaultModelName: String? = null,
)

@Serializable
public data class SetDefaultModelRequest(
    @SerialName("model_id") val modelId: String,
)
