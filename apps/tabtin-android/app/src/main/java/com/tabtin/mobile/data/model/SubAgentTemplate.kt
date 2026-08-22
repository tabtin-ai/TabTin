package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public data class SubAgentTemplate(
    val id: String,
    @SerialName("space_id") val spaceId: String = "",
    val name: String = "",
    val description: String = "",
    val icon: String = "",
    @SerialName("system_prompt") val systemPrompt: String = "",
    @SerialName("subagent_type") val subagentType: String = "execute",
    @SerialName("allowed_tools") val allowedTools: List<String>? = null,
    @SerialName("denied_tools") val deniedTools: List<String>? = null,
    @SerialName("model_id") val modelId: String? = null,
    @SerialName("thinking_level") val thinkingLevel: String? = null,
    @SerialName("default_mode") val defaultMode: String = "wait",
    @SerialName("app_id") val appId: String? = null,
    @SerialName("is_enabled") val isEnabled: Boolean = true,
    val order: Int? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
public data class SubAgentTemplateListResponse(
    val items: List<SubAgentTemplate>,
)

@Serializable
public data class SubAgentTemplateCreate(
    val name: String,
    val description: String = "",
    val icon: String = "",
    @SerialName("system_prompt") val systemPrompt: String = "",
    @SerialName("subagent_type") val subagentType: String = "execute",
    @SerialName("default_mode") val defaultMode: String = "wait",
    @SerialName("thinking_level") val thinkingLevel: String = "",
    @SerialName("app_id") val appId: String = "",
    @SerialName("is_enabled") val isEnabled: Boolean = true,
)

@Serializable
public data class SubAgentTemplateUpdate(
    val name: String? = null,
    val description: String? = null,
    val icon: String? = null,
    @SerialName("system_prompt") val systemPrompt: String? = null,
    @SerialName("subagent_type") val subagentType: String? = null,
    @SerialName("default_mode") val defaultMode: String? = null,
    @SerialName("thinking_level") val thinkingLevel: String? = null,
    @SerialName("is_enabled") val isEnabled: Boolean? = null,
    @SerialName("model_id") val modelId: String? = null,
    @SerialName("app_id") val appId: String? = null,
    @SerialName("allowed_tools") val allowedTools: List<String>? = null,
    @SerialName("denied_tools") val deniedTools: List<String>? = null,
    val order: Int? = null,
)

@Serializable
public data class SubAgentToggleRequest(
    @SerialName("is_enabled") val isEnabled: Boolean,
)
