package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.GppBad
import androidx.compose.material.icons.filled.GppGood
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ConversationAgentMode
import com.tabtin.mobile.data.model.ConversationApprovalMode
import com.tabtin.mobile.data.model.LlmModel
import com.tabtin.mobile.data.model.LlmModelSource
import com.tabtin.mobile.data.model.canSelectContextTier
import com.tabtin.mobile.data.model.catalogThinkingCapability
import com.tabtin.mobile.data.model.formatContextWindowLabel
import com.tabtin.mobile.data.model.hasRuntimeSettings
import com.tabtin.mobile.data.model.resolveActiveContextTierId
import com.tabtin.mobile.data.model.resolveActiveThinkingMode
import com.tabtin.mobile.data.model.runtimeSettingsSummary
import com.tabtin.mobile.data.model.shouldShowContextSelector
import com.tabtin.mobile.data.model.source
import com.tabtin.mobile.features.space.AgentIdentityAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

internal enum class ComposerTool {
    CONTEXT,
    PHOTO_LIBRARY,
    CAMERA,
    FILE,
    ;

    @get:StringRes
    val titleRes: Int
        get() = when (this) {
            CONTEXT -> R.string.chat_add_context
            PHOTO_LIBRARY -> R.string.chat_pick_album
            CAMERA -> R.string.chat_pick_camera
            FILE -> R.string.chat_pick_files
        }

    @get:StringRes
    val gridTitleRes: Int
        get() = when (this) {
            CONTEXT -> R.string.chat_composer_tool_context
            PHOTO_LIBRARY -> R.string.chat_composer_tool_photo
            CAMERA -> R.string.chat_composer_tool_camera
            FILE -> R.string.chat_composer_tool_file
        }

    val icon: ImageVector
        get() = when (this) {
            CONTEXT -> Icons.Default.Link
            PHOTO_LIBRARY -> Icons.Default.Image
            CAMERA -> Icons.Default.CameraAlt
            FILE -> Icons.Default.AttachFile
        }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ComposerModelSelectionDrawer(
    models: List<LlmModel>,
    selectedModelId: String?,
    selectedModel: LlmModel?,
    contextTierId: String?,
    thinkingMode: String?,
    isSwitchingModel: Boolean,
    errorMessage: String?,
    onSelect: (LlmModel) -> Unit,
    onOpenRuntimeSettings: () -> Unit,
    onDismiss: () -> Unit,
) {
    val thinkingLabels = composerThinkingModeLabels()
    val runtimeModel = selectedModel ?: models.firstOrNull { it.id == selectedModelId }
    val showRuntimeEntry = runtimeModel?.hasRuntimeSettings() == true
    val runtimeSummary = runtimeModel?.let {
        runtimeSettingsSummary(
            model = it,
            contextTierId = contextTierId,
            thinkingMode = thinkingMode,
            thinkingLabels = thinkingLabels,
        )
    }
    val modelGroups = models.groupBy { it.source }
    val sourceOrder = listOf(
        LlmModelSource.PLATFORM,
        LlmModelSource.ORGANIZATION_BYOK,
        LlmModelSource.USER_BYOK,
    )

    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Text(
            text = stringResource(R.string.chat_model_select),
            style = TTFonts.subtitleSemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        )
        errorMessage?.let { message ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm)
                    .clip(TTRadius.Shapes.sm)
                    .background(
                        ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
                            .copy(alpha = 0.12f),
                    )
                    .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Default.ErrorOutline,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
                Spacer(modifier = Modifier.size(TTSpacing.sm))
                Text(
                    text = message,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }
        }
        LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            sourceOrder.forEach { source ->
                val sourceModels = modelGroups[source].orEmpty()
                if (sourceModels.isEmpty()) return@forEach
                item(key = "model-source-$source") {
                    Text(
                        text = stringResource(source.titleRes),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        modifier = Modifier.padding(
                            start = TTSpacing.lg,
                            end = TTSpacing.lg,
                            top = TTSpacing.md,
                            bottom = TTSpacing.xs,
                        ),
                    )
                }
                items(sourceModels, key = { it.id }) { model ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = !isSwitchingModel) { onSelect(model) }
                            .alpha(if (isSwitchingModel) 0.6f else 1f)
                            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (model.id == selectedModelId) {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                                tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
                            )
                            Spacer(modifier = Modifier.size(TTSpacing.sm))
                        } else {
                            Spacer(modifier = Modifier.size(18.dp + TTSpacing.sm))
                        }
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = model.title,
                                style = TTFonts.body,
                                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            model.promotionCreditSummary?.let { summary ->
                                Text(
                                    text = summary,
                                    style = ConversationTypography.meta,
                                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            val providerLabel = model.providerDisplayName?.takeIf { it.isNotBlank() }
                                ?: model.providerName?.takeIf { it.isNotBlank() }
                            providerLabel?.let {
                                Text(
                                    text = it,
                                    style = ConversationTypography.meta,
                                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                    HorizontalDivider(
                        color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight).copy(alpha = 0.5f),
                    )
                }
            }
            if (showRuntimeEntry) {
                item(key = "runtime-settings-entry") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm)
                            .clip(TTRadius.Shapes.lg)
                            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                            .clickable(enabled = !isSwitchingModel, onClick = onOpenRuntimeSettings)
                            .alpha(if (isSwitchingModel) 0.6f else 1f)
                            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = stringResource(R.string.chat_composer_runtime_settings),
                                style = TTFonts.bodyMedium,
                                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                            )
                            Text(
                                text = runtimeSummary
                                    ?: (stringResource(R.string.chat_composer_context_length) +
                                        " · " +
                                        stringResource(R.string.chat_composer_thinking_intensity)),
                                style = TTFonts.caption,
                                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Icon(
                            Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        )
                    }
                    Text(
                        text = stringResource(R.string.chat_composer_runtime_settings_hint),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
                    )
                }
            }
            item { Spacer(modifier = Modifier.size(TTSpacing.xl)) }
        }
    }
}

private val LlmModelSource.titleRes: Int
    get() = when (this) {
        LlmModelSource.PLATFORM -> R.string.chat_model_source_platform
        LlmModelSource.ORGANIZATION_BYOK -> R.string.chat_model_source_organization_byok
        LlmModelSource.USER_BYOK -> R.string.chat_model_source_user_byok
    }

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun ComposerRuntimeSettingsSheet(
    model: LlmModel,
    contextTierId: String?,
    thinkingMode: String?,
    onSelectContextTier: (String) -> Unit,
    onSelectThinkingMode: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val thinkingLabels = composerThinkingModeLabels()
    val showContext = model.shouldShowContextSelector()
    val selectableContext = model.canSelectContextTier()
    val thinking = model.catalogThinkingCapability()
    val activeTierId = resolveActiveContextTierId(model, contextTierId)
    val activeThinking = thinking?.let {
        resolveActiveThinkingMode(
            overrides = null,
            selectedMode = thinkingMode,
            capability = it,
        )
    }

    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.common_back))
            }
            Text(
                text = stringResource(R.string.chat_composer_runtime_settings),
                style = TTFonts.subtitleSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.chat_composer_done))
            }
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            Row(
                modifier = Modifier
                    .clip(TTRadius.Shapes.md)
                    .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                    .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = model.title,
                    style = TTFonts.bodyMedium,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (showContext) {
                Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                    Text(
                        text = stringResource(R.string.chat_composer_context_length),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    )
                    if (selectableContext) {
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        ) {
                            model.contextTiers.forEach { tier ->
                                RuntimeSettingChip(
                                    label = tier.label,
                                    selected = tier.id == activeTierId,
                                    badge = if (tier.tags.any { it.equals("beta", ignoreCase = true) }) {
                                        stringResource(R.string.chat_composer_context_tier_beta)
                                    } else {
                                        null
                                    },
                                    onClick = { onSelectContextTier(tier.id) },
                                )
                            }
                        }
                    } else {
                        val label = model.contextWindowTokens
                            ?.takeIf { it > 0 }
                            ?.let { formatContextWindowLabel(it) }
                            .orEmpty()
                        if (label.isNotEmpty()) {
                            RuntimeSettingChip(
                                label = label,
                                selected = true,
                                readonly = true,
                                onClick = {},
                            )
                        }
                    }
                }
            }

            if (thinking != null) {
                Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                    Text(
                        text = stringResource(R.string.chat_composer_thinking_intensity),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        thinking.modes.forEach { mode ->
                            RuntimeSettingChip(
                                label = thinkingLabels[mode] ?: mode,
                                selected = mode == activeThinking,
                                onClick = { onSelectThinkingMode(mode) },
                            )
                        }
                    }
                }
            }

            if (!showContext && thinking == null) {
                Text(
                    text = stringResource(R.string.chat_composer_runtime_empty),
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
        }
    }
}

@Composable
internal fun composerThinkingModeLabels(): Map<String, String> = mapOf(
    "off" to stringResource(R.string.chat_composer_thinking_mode_off),
    "standard" to stringResource(R.string.chat_composer_thinking_mode_standard),
    "deep" to stringResource(R.string.chat_composer_thinking_mode_deep),
)

@Composable
private fun RuntimeSettingChip(
    label: String,
    selected: Boolean,
    badge: String? = null,
    readonly: Boolean = false,
    onClick: () -> Unit,
) {
    val accent = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
    val warn = Color(0xFFB54708)
    val border = if (selected || readonly) {
        accent.copy(alpha = 0.28f)
    } else {
        Color.Transparent
    }
    val background = if (selected || readonly) {
        accent.copy(alpha = 0.12f)
    } else {
        ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)
    }
    val contentColor = if (selected || readonly) {
        accent
    } else {
        ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    }
    Row(
        modifier = Modifier
            .clip(TTRadius.Shapes.sm)
            .background(background)
            .border(1.dp, border, TTRadius.Shapes.sm)
            .then(
                if (readonly) Modifier else Modifier.clickable(onClick = onClick),
            )
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Text(
            text = label,
            style = if (selected || readonly) TTFonts.bodyMedium else TTFonts.body,
            color = contentColor,
        )
        if (!badge.isNullOrBlank()) {
            Text(
                text = badge,
                style = TTFonts.caption,
                color = if (selected) accent else warn,
                modifier = Modifier
                    .clip(TTRadius.Shapes.xs)
                    .background(
                        if (selected) accent.copy(alpha = 0.16f)
                        else warn.copy(alpha = 0.12f),
                    )
                    .padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ComposerSettingsDrawer(
    agentOptions: List<ComposerTaskAgentOption>,
    selectedAgentId: String?,
    agentTitle: String,
    agentIsMutable: Boolean,
    currentMode: String,
    currentApprovalMode: String,
    permitsRelaxedApproval: Boolean,
    onSelectTool: (ComposerTool) -> Unit,
    onAgentChange: (ComposerTaskAgentOption) -> Unit,
    onModeChange: (String) -> Unit,
    onApprovalModeChange: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var route by remember { mutableStateOf<SettingsRoute?>(null) }
    var awaitingFullAccess by remember { mutableStateOf(false) }

    val mode = ConversationAgentMode.resolve(currentMode)
    val approval = ConversationApprovalMode.resolve(currentApprovalMode)
        ?: ConversationApprovalMode.ALWAYS_ASK
    val selectedAgent = agentOptions.firstOrNull { it.id == selectedAgentId }

    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = TTSpacing.xl),
        ) {
            when (route) {
                null -> {
                    Text(
                        text = stringResource(R.string.chat_composer_task_settings),
                        style = TTFonts.subtitleSemibold,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                    )
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                    ) {
                        ComposerTool.entries.forEach { tool ->
                            ComposerToolTile(
                                tool = tool,
                                modifier = Modifier.weight(1f),
                                onClick = {
                                    onDismiss()
                                    onSelectTool(tool)
                                },
                            )
                        }
                    }
                    HorizontalDivider(
                        modifier = Modifier.padding(vertical = TTSpacing.sm),
                        color = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight).copy(alpha = 0.5f),
                    )
                    ComposerSettingRow(
                        title = stringResource(R.string.chat_composer_setting_agent),
                        value = agentTitle,
                        leading = {
                            if (selectedAgent != null) {
                                AgentIdentityAvatar(
                                    name = selectedAgent.name,
                                    avatarKey = selectedAgent.avatarKey,
                                    avatarUrl = selectedAgent.avatarUrl,
                                    size = 24.dp,
                                )
                            } else {
                                Icon(
                                    Icons.Default.Person,
                                    contentDescription = null,
                                    modifier = Modifier.size(20.dp),
                                    tint = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent),
                                )
                            }
                        },
                        enabled = agentOptions.isNotEmpty(),
                        onClick = { route = SettingsRoute.AGENT },
                    )
                    ComposerSettingRow(
                        title = stringResource(R.string.chat_composer_setting_mode),
                        value = stringResource(mode.titleRes),
                        leading = {
                            Icon(
                                mode.icon,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp),
                                tint = mode.color(),
                            )
                        },
                        onClick = { route = SettingsRoute.MODE },
                    )
                    ComposerSettingRow(
                        title = stringResource(R.string.chat_composer_setting_approval),
                        value = stringResource(approval.titleRes),
                        leading = {
                            Icon(
                                approval.icon,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp),
                                tint = approval.color(),
                            )
                        },
                        onClick = { route = SettingsRoute.APPROVAL },
                    )
                }

                SettingsRoute.AGENT -> {
                    ComposerDrawerSubpageTitle(
                        title = stringResource(R.string.chat_composer_setting_agent),
                        onBack = { route = null },
                    )
                    if (agentOptions.isEmpty()) {
                        Text(
                            text = stringResource(R.string.chat_composer_agent_unavailable),
                            style = TTFonts.meta,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                            modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                        )
                    } else {
                        ComposerAgentPickerGrid(
                            agents = agentOptions,
                            selectedAgentId = selectedAgentId,
                            agentIsMutable = agentIsMutable,
                            onSelect = { agent ->
                                onAgentChange(agent)
                                route = null
                                onDismiss()
                            },
                            modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                        )
                    }
                }

                SettingsRoute.MODE -> {
                    ComposerDrawerSubpageTitle(
                        title = stringResource(R.string.chat_composer_setting_mode),
                        onBack = { route = null },
                    )
                    ConversationAgentMode.entries.forEach { candidate ->
                        ComposerOptionRow(
                            title = stringResource(candidate.titleRes),
                            selected = candidate == mode,
                            leading = {
                                Icon(
                                    candidate.icon,
                                    contentDescription = null,
                                    modifier = Modifier.size(20.dp),
                                    tint = candidate.color(),
                                )
                            },
                            onClick = {
                                onModeChange(candidate.wireValue)
                                route = null
                            },
                        )
                    }
                }

                SettingsRoute.APPROVAL -> {
                    ComposerDrawerSubpageTitle(
                        title = stringResource(R.string.chat_composer_setting_approval),
                        onBack = { route = null },
                    )
                    ConversationApprovalMode.entries.forEach { candidate ->
                        val restricted = candidate != ConversationApprovalMode.ALWAYS_ASK &&
                            !permitsRelaxedApproval
                        ComposerOptionRow(
                            title = stringResource(candidate.titleRes),
                            summary = stringResource(candidate.summaryRes),
                            disabledReason = if (restricted) {
                                stringResource(R.string.chat_approval_mode_org_locked)
                            } else {
                                null
                            },
                            selected = candidate == approval,
                            enabled = !restricted,
                            leading = {
                                Icon(
                                    candidate.icon,
                                    contentDescription = null,
                                    modifier = Modifier
                                        .size(20.dp)
                                        .then(if (restricted) Modifier.alpha(0.45f) else Modifier),
                                    tint = candidate.color(),
                                )
                            },
                            onClick = {
                                if (candidate == ConversationApprovalMode.FULL_ACCESS) {
                                    awaitingFullAccess = true
                                } else {
                                    onApprovalModeChange(candidate.wireValue)
                                    route = null
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    if (awaitingFullAccess) {
        AlertDialog(
            onDismissRequest = { awaitingFullAccess = false },
            title = { Text(stringResource(R.string.chat_composer_full_access_title)) },
            text = { Text(stringResource(R.string.chat_composer_full_access_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        awaitingFullAccess = false
                        onApprovalModeChange(ConversationApprovalMode.FULL_ACCESS.wireValue)
                        route = null
                    },
                ) {
                    Text(stringResource(R.string.chat_composer_full_access_confirm))
                }
            },
            dismissButton = {
                TextButton(onClick = { awaitingFullAccess = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

private enum class SettingsRoute {
    AGENT,
    MODE,
    APPROVAL,
}

@Composable
private fun ComposerAgentPickerGrid(
    agents: List<ComposerTaskAgentOption>,
    selectedAgentId: String?,
    agentIsMutable: Boolean,
    onSelect: (ComposerTaskAgentOption) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        agents.chunked(3).forEach { rowAgents ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
            ) {
                rowAgents.forEach { agent ->
                    val isSelected = agent.id == selectedAgentId
                    val selectable = agent.isAvailable && (agentIsMutable || isSelected)
                    ComposerAgentGridCell(
                        agent = agent,
                        isSelected = isSelected,
                        showsLock = !agentIsMutable && isSelected,
                        enabled = selectable,
                        onClick = { if (selectable) onSelect(agent) },
                        modifier = Modifier.weight(1f),
                    )
                }
                repeat(3 - rowAgents.size) {
                    Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun ComposerAgentGridCell(
    agent: ComposerTaskAgentOption,
    isSelected: Boolean,
    showsLock: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val accent = ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
    val borderColor = if (isSelected) accent else ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight)
    Column(
        modifier = modifier
            .aspectRatio(1f)
            .clip(TTRadius.Shapes.lg)
            .border(1.dp, borderColor, TTRadius.Shapes.lg)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(TTSpacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box {
            AgentIdentityAvatar(
                name = agent.name,
                avatarKey = agent.avatarKey,
                avatarUrl = agent.avatarUrl,
                size = 48.dp,
            )
            if (showsLock) {
                Icon(
                    Icons.Default.Lock,
                    contentDescription = null,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .size(16.dp),
                    tint = accent,
                )
            } else if (isSelected) {
                Icon(
                    Icons.Default.Check,
                    contentDescription = null,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .size(16.dp),
                    tint = accent,
                )
            }
        }
        Spacer(Modifier.size(TTSpacing.xs))
        Text(
            text = agent.name,
            style = if (isSelected) TTFonts.captionMedium else TTFonts.caption,
            color = if (enabled) {
                ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
            } else {
                ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
            },
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        agent.unavailableReason?.let { reason ->
            Text(
                text = reason,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ComposerToolTile(
    tool: ComposerTool,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Column(
        modifier = modifier
            .aspectRatio(1f)
            .clip(TTRadius.Shapes.lg)
            .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
            .clickable(onClick = onClick)
            .padding(TTSpacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            tool.icon,
            contentDescription = stringResource(tool.titleRes),
            modifier = Modifier.size(22.dp),
            tint = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        Spacer(Modifier.size(TTSpacing.xs))
        Text(
            text = stringResource(tool.gridTitleRes),
            style = TTFonts.caption,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ComposerSettingRow(
    title: String,
    value: String,
    leading: @Composable () -> Unit,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.size(TTSpacing.md))
        Text(
            text = title,
            style = TTFonts.body,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier.weight(1f),
        )
        Text(
            text = value,
            style = TTFonts.body,
            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ComposerDrawerSubpageTitle(
    title: String,
    onBack: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack) {
            Text(stringResource(R.string.common_back))
        }
        Text(
            text = title,
            style = TTFonts.subtitleSemibold,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun ComposerOptionRow(
    title: String,
    selected: Boolean,
    leading: @Composable () -> Unit,
    summary: String? = null,
    disabledReason: String? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        verticalAlignment = Alignment.Top,
    ) {
        leading()
        Spacer(Modifier.size(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = TTFonts.bodyMedium,
                color = if (enabled) {
                    ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
                } else {
                    ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                },
            )
            if (!summary.isNullOrBlank()) {
                Text(
                    text = summary,
                    style = TTFonts.meta,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
            if (!disabledReason.isNullOrBlank()) {
                Text(
                    text = disabledReason,
                    style = TTFonts.caption,
                    color = ttColor(TTColors.TextWarning, TTColors.Dark.TextWarning),
                )
            }
        }
        if (selected) {
            Icon(
                Icons.Default.Check,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = ttColor(TTColors.IconAccent, TTColors.Dark.IconAccent),
            )
        }
    }
}

@get:StringRes
private val ConversationAgentMode.titleRes: Int
    get() = when (this) {
        ConversationAgentMode.ASK -> R.string.chat_mode_ask
        ConversationAgentMode.AGENT -> R.string.chat_mode_agent
        ConversationAgentMode.PLAN -> R.string.chat_mode_plan
        ConversationAgentMode.GROUP -> R.string.chat_mode_group
    }

private val ConversationAgentMode.icon: ImageVector
    get() = when (this) {
        ConversationAgentMode.ASK -> Icons.AutoMirrored.Filled.HelpOutline
        ConversationAgentMode.AGENT -> Icons.Default.Memory
        ConversationAgentMode.PLAN -> Icons.Default.Map
        ConversationAgentMode.GROUP -> Icons.Default.Group
    }

@Composable
private fun ConversationAgentMode.color(): Color = when (this) {
    ConversationAgentMode.ASK -> Color(0xFF3B82F6)
    ConversationAgentMode.AGENT -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
    ConversationAgentMode.PLAN -> ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
    ConversationAgentMode.GROUP -> Color(0xFF8B5CF6)
}

@get:StringRes
private val ConversationApprovalMode.titleRes: Int
    get() = composerApprovalTitleRes(this)

@get:StringRes
private val ConversationApprovalMode.summaryRes: Int
    get() = composerApprovalSummaryRes(this)

private val ConversationApprovalMode.icon: ImageVector
    get() = composerApprovalIcon(this)

@Composable
private fun ConversationApprovalMode.color(): Color = when (this) {
    // Electron: muted / warning / destructive；iOS: textSecondary / textWarning / textCritical
    ConversationApprovalMode.ALWAYS_ASK -> ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
    ConversationApprovalMode.AUTO -> ttColor(TTColors.TextWarning, TTColors.Dark.TextWarning)
    ConversationApprovalMode.FULL_ACCESS -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
}

/** 审批三档 icon：对齐 Electron ShieldCheck / Shield / ShieldAlert。 */
internal fun composerApprovalIcon(mode: ConversationApprovalMode): ImageVector = when (mode) {
    ConversationApprovalMode.ALWAYS_ASK -> Icons.Default.GppGood
    ConversationApprovalMode.AUTO -> Icons.Default.Shield
    ConversationApprovalMode.FULL_ACCESS -> Icons.Default.GppBad
}

@StringRes
internal fun composerApprovalTitleRes(mode: ConversationApprovalMode): Int = when (mode) {
    ConversationApprovalMode.ALWAYS_ASK -> R.string.chat_approval_mode_always_ask_short
    ConversationApprovalMode.AUTO -> R.string.chat_approval_mode_auto_short
    ConversationApprovalMode.FULL_ACCESS -> R.string.chat_approval_mode_full_access_short
}

@StringRes
internal fun composerApprovalSummaryRes(mode: ConversationApprovalMode): Int = when (mode) {
    ConversationApprovalMode.ALWAYS_ASK -> R.string.chat_approval_mode_always_ask_summary
    ConversationApprovalMode.AUTO -> R.string.chat_approval_mode_auto_summary
    ConversationApprovalMode.FULL_ACCESS -> R.string.chat_approval_mode_full_access_summary
}
