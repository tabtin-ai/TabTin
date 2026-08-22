package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
public data class SkillRequirements(
    val bins: List<String>? = null,
    @SerialName("any_bins") val anyBins: List<String>? = null,
    val env: List<String>? = null,
    val config: List<String>? = null,
)

@Serializable
public data class SkillInstallSpec(
    val id: String,
    val kind: String,
    val formula: String? = null,
    @SerialName("package") val pkg: String? = null,
    val module: String? = null,
    val url: String? = null,
    val bins: List<String>? = null,
    val label: String? = null,
    val os: List<String>? = null,
)

@Serializable
public data class SkillConfig(
    val enabled: Boolean? = null,
    @SerialName("api_key") val apiKey: String? = null,
    val env: Map<String, String>? = null,
)

@Serializable
public data class SpaceSkill(
    val id: String = "",
    @SerialName("skill_id") val skillId: String? = null,
    val name: String = "",
    val description: String? = null,
    @SerialName("is_enabled") val isEnabled: Boolean? = null,
    val category: String? = null,
    val version: String? = null,
    @SerialName("skill_key") val skillKey: String? = null,
    val source: String? = null,
    val emoji: String? = null,
    @SerialName("primary_env") val primaryEnv: String? = null,
    @SerialName("os_filter") val osFilter: List<String>? = null,
    val always: Boolean? = null,
    val requires: SkillRequirements? = null,
    val install: List<SkillInstallSpec>? = null,
    val homepage: String? = null,
    @SerialName("app_id") val appId: String? = null,
    val tags: List<String>? = null,
    val status: String? = null,
) {
    val resolvedId: String get() = id.ifEmpty { skillId ?: "" }

    val sourceLabel: String
        get() = when (source) {
            "marketplace", "market" -> "市场"
            "managed" -> "已安装"
            "local_agent" -> "本地"
            "system" -> "系统"
            "app" -> "内置"
            else -> source ?: ""
        }

    public fun isEnabledInSpace(configs: Map<String, SkillConfig>): Boolean {
        skillKey?.let { key ->
            configs[key]?.enabled?.let { return it }
        }
        isEnabled?.let { return it }
        status?.let { return it == "enabled" }
        return true
    }

    public fun computeReadiness(config: SkillConfig?): SkillReadiness {
        val filter = osFilter
        if (!filter.isNullOrEmpty() && "android" !in filter && "linux" !in filter) {
            return SkillReadiness.INCOMPATIBLE
        }

        val requiredBins = requires?.bins ?: emptyList()
        if (requiredBins.isNotEmpty() && !install.isNullOrEmpty()) {
            val common = setOf("curl", "bash", "sh", "python3", "node")
            if (requiredBins.any { it !in common }) return SkillReadiness.NEEDS_INSTALL
        }

        val requiredEnv = requires?.env ?: emptyList()
        if (requiredEnv.isNotEmpty()) {
            val envObj = config?.env ?: emptyMap()
            val hasApiKey = !config?.apiKey.isNullOrBlank()
            for (key in requiredEnv) {
                if (key == primaryEnv) {
                    if (!hasApiKey && envObj[key] == null) return SkillReadiness.NEEDS_CONFIG
                } else {
                    if (envObj[key] == null) return SkillReadiness.NEEDS_CONFIG
                }
            }
        }
        return SkillReadiness.READY
    }
}

public enum class SkillReadiness(public val label: String, public val sortOrder: Int) {
    READY("就绪", 0),
    NEEDS_CONFIG("需配置", 1),
    NEEDS_INSTALL("需安装", 2),
    INCOMPATIBLE("不兼容", 3),
}

@Serializable
public data class SkillListResponse(
    val skills: List<SpaceSkill>,
    val total: Int? = null,
)

@Serializable
public data class SkillConfigsResponse(
    val configs: Map<String, SkillConfig>,
)

@Serializable
public data class SkillToggleRequest(
    @SerialName("space_id") val spaceId: String,
    val enabled: Boolean,
)

@Serializable
public data class SkillApiKeyRequest(
    @SerialName("space_id") val spaceId: String,
    @SerialName("api_key") val apiKey: String,
)

@Serializable
public data class SkillEnableRequest(
    @SerialName("is_enabled") val isEnabled: Boolean,
)

/** `/skills/visible` 的移动端目录项：服务端给出组织可见范围及当前 AI 分身携带态。 */
@Serializable
public data class VisibleSkillEntry(
    @SerialName("skill_id") val skillId: String? = null,
    @SerialName("skill_key") val skillKey: String = "",
    val name: String = "",
    @SerialName("display_name") val displayName: String? = null,
    val description: String = "",
    val emoji: String? = null,
    val source: String = "user",
    val visibility: String = "",
    val version: String = "",
    val tags: List<String> = emptyList(),
    val category: String? = null,
    @SerialName("app_id") val appId: String? = null,
    val distribution: String? = null,
    @SerialName("owner_user_id") val ownerUserId: String? = null,
    @SerialName("primary_env") val primaryEnv: String? = null,
    @SerialName("quick_use") val quickUse: List<SkillQuickUsePreset> = emptyList(),
    val installed: Boolean = false,
    val enabled: Boolean = true,
    @SerialName("agent_enabled") val agentEnabled: Boolean = false,
) {
    public val canonicalKey: String get() = skillKey.ifBlank { skillId.orEmpty() }
    public val resolvedName: String get() = displayName?.takeIf { it.isNotBlank() } ?: name.ifBlank { canonicalKey }
    public val requiresCredential: Boolean get() = !primaryEnv.isNullOrBlank()
}

/** 技能发布者提供的快捷任务模板；手机只消费模板，不编辑或发布。 */
@Serializable
public data class SkillQuickUsePreset(
    val id: String? = null,
    val label: String = "",
    @SerialName("promptTemplate") val promptTemplate: String = "",
    val variables: List<SkillQuickUseVariable> = emptyList(),
    @SerialName("canSubmitKeys") val canSubmitKeys: List<String> = emptyList(),
) {
    public val resolvedId: String get() = id?.takeIf { it.isNotBlank() } ?: "$label-$promptTemplate"
    public val resolvedLabel: String get() = label.ifBlank { promptTemplate }

    public fun render(values: Map<String, String>): String = variables.fold(promptTemplate) { prompt, variable ->
        prompt.replace("{{${variable.key}}}", values[variable.key].orEmpty())
    }
}

@Serializable
public data class SkillQuickUseVariable(
    val key: String,
    val type: String = "input",
    val label: String = "",
    val placeholder: String = "",
    val options: List<SkillQuickUseOption> = emptyList(),
)

@Serializable
public data class SkillQuickUseOption(
    val value: String,
    val label: String = "",
) {
    public val resolvedLabel: String get() = label.ifBlank { value }
}

@Serializable
public data class VisibleSkillListResponse(
    val skills: List<VisibleSkillEntry> = emptyList(),
    @SerialName("user_gates") val userGates: Map<String, Boolean> = emptyMap(),
)

/** Credential Vault 的脱敏列表项；不声明或持有任何凭据明文。 */
@Serializable
public data class CredentialListItem(
    val id: String,
    val category: String = "",
    @SerialName("service_name") val serviceName: String = "",
    @SerialName("display_name") val displayName: String = "",
    @SerialName("is_active") val isActive: Boolean = true,
    @SerialName("masked_data") val maskedData: JsonObject? = null,
) {
    public val resolvedName: String get() = displayName.takeIf { it.isNotBlank() } ?: serviceName
}
