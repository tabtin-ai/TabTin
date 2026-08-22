package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public enum class WorkspaceMemoryModelMode {
    @SerialName("official_default")
    OFFICIAL_DEFAULT,

    @SerialName("explicit_model")
    EXPLICIT_MODEL,
}

@Serializable
public enum class WorkspaceMemoryProviderScope {
    @SerialName("global")
    GLOBAL,

    @SerialName("user")
    USER,

    @SerialName("organization")
    ORGANIZATION,
}

@Serializable
public data class WorkspaceMemoryModel(
    val id: String,
    @SerialName("display_name") val displayName: String,
    @SerialName("provider_scope") val providerScope: WorkspaceMemoryProviderScope,
    @SerialName("provider_display_name") val providerDisplayName: String,
)

@Serializable
public data class WorkspaceMemorySettings(
    @SerialName("workspace_scope") val workspaceScope: String,
    @SerialName("auto_memory_enabled") val autoMemoryEnabled: Boolean,
    @SerialName("memory_model_mode") val memoryModelMode: WorkspaceMemoryModelMode,
    @SerialName("memory_model") val memoryModel: WorkspaceMemoryModel? = null,
    @SerialName("can_update") val canUpdate: Boolean,
) {
    public fun hasAvailableExplicitModel(candidates: List<WorkspaceMemoryModel>): Boolean =
        memoryModelMode != WorkspaceMemoryModelMode.EXPLICIT_MODEL ||
            memoryModel?.let { selected -> candidates.any { it.id == selected.id } } == true
}

@Serializable
public data class WorkspaceMemoryModelCatalog(
    @SerialName("workspace_scope") val workspaceScope: String,
    val items: List<WorkspaceMemoryModel> = emptyList(),
)

@Serializable
public data class WorkspaceMemorySettingsUpdateRequest(
    @SerialName("organization_id") val organizationId: String,
    @SerialName("auto_memory_enabled") val autoMemoryEnabled: Boolean? = null,
    @SerialName("memory_model_mode") val memoryModelMode: WorkspaceMemoryModelMode? = null,
    @SerialName("memory_model_id") val memoryModelId: String? = null,
)
