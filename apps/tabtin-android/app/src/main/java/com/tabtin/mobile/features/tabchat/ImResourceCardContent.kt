package com.tabtin.mobile.features.tabchat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import android.os.SystemClock
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImCardTablePreview
import com.tabtin.mobile.data.im.ImCardStatusMemoryCache
import com.tabtin.mobile.data.im.ImPromptCard
import com.tabtin.mobile.data.im.ImResourceCardPreview
import com.tabtin.mobile.data.im.ImResourceCardPreviewResult
import com.tabtin.mobile.data.im.ImResourceCardPreviewStatus
import com.tabtin.mobile.data.im.ImResourceCard
import com.tabtin.mobile.data.im.ImResourceCardType
import com.tabtin.mobile.ui.components.TTAvatar
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.launch

internal object ImStructuredCardLayout {
    val width = 300.dp
    val height = 222.dp
    val bodyHeight = 164.dp
    val promptHeight = 190.dp
    val promptBodyHeight = 132.dp
    val footerHeight = 57.dp
    val cornerRadius = 16.dp
    val actionCornerRadius = 8.dp
    val actionHeight = 42.dp
    /** 名片紧凑方案 B：自适应气泡列宽，上限贴近手机可读宽度。 */
    val contactMaxWidth = 248.dp
    val contactMinHeight = 68.dp
    val contactAvatarSize = 44.dp
    val contactCornerRadius = 14.dp
}

/**
 * 资源卡消息主体：文档 / 表格 / 名片 / 指令。快照嵌在消息 metadata，直接渲染，无需额外请求。
 */
@Composable
internal fun ImResourceCardContent(
    card: ImResourceCard,
    displayName: String = card.displayName,
    contactAvatarUrl: String? = null,
    currentUserId: String? = null,
    onClick: ((ImResourceCardPreview?) -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    onUsePrompt: ((ImPromptCard) -> Unit)? = null,
    loadPreview: (suspend (ImResourceCard) -> ImResourceCardPreviewResult)? = null,
    onRequestAccess: (suspend () -> Boolean)? = null,
) {
    val prompt = card.promptCard
    if (prompt != null) {
        ImPromptCardContent(prompt = prompt, onUsePrompt = onUsePrompt, onLongClick = onLongClick)
        return
    }
    var lastClickAt by remember(card.type, card.resourceId, card.userId, displayName) {
        mutableLongStateOf(0L)
    }
    val debouncedClick = onClick?.let { action ->
        { preview: ImResourceCardPreview? ->
            val now = SystemClock.elapsedRealtime()
            if (now - lastClickAt >= 700L) {
                lastClickAt = now
                action(preview)
            }
        }
    }
    val isSelfContact = !card.userId.isNullOrBlank() && card.userId == currentUserId
    val actionLabel = when (card.type) {
        ImResourceCardType.CONTACT -> if (isSelfContact) {
            stringResource(R.string.im_contact_self_a11y)
        } else {
            stringResource(R.string.im_contact_open_dm_a11y, displayName)
        }
        ImResourceCardType.TABLE -> stringResource(R.string.im_table_open_a11y, displayName)
        ImResourceCardType.SPACE,
        ImResourceCardType.AGENT_SPACE,
        -> stringResource(R.string.im_workspace_open_a11y, displayName)
        else -> stringResource(R.string.im_document_open_a11y, displayName)
    }
    when (card.type) {
        ImResourceCardType.CONTACT -> {
            val cardShape = RoundedCornerShape(ImStructuredCardLayout.contactCornerRadius)
            Row(
                modifier = Modifier
                    .width(ImStructuredCardLayout.contactMaxWidth)
                    .heightIn(min = ImStructuredCardLayout.contactMinHeight)
                    .clip(cardShape)
                    .background(MaterialTheme.colorScheme.surface)
                    .border(1.dp, imBorderLight(), cardShape)
                    .imCardActions(
                        onClick = debouncedClick?.let { action -> { action(null) } },
                        onLongClick = onLongClick,
                    )
                    .semantics { contentDescription = actionLabel }
                    .padding(horizontal = TTSpacing.md, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ContactCard(
                    card = card,
                    displayName = displayName,
                    contactAvatarUrl = contactAvatarUrl,
                    isSelf = isSelfContact,
                )
            }
        }
        ImResourceCardType.TABLE,
        ImResourceCardType.DOCUMENT,
        -> DocLikeResourceCard(
            card = card,
            displayName = displayName,
            onClick = debouncedClick,
            onLongClick = onLongClick,
            actionLabel = actionLabel,
            loadPreview = loadPreview,
            onRequestAccess = onRequestAccess,
        )
        ImResourceCardType.SPACE,
        ImResourceCardType.AGENT_SPACE,
        -> WorkspaceResourceCard(
            card = card,
            displayName = displayName,
            onClick = debouncedClick?.let { action -> { action(null) } },
            onLongClick = onLongClick,
            actionLabel = actionLabel,
        )
        else -> DocLikeResourceCard(
            card = card,
            displayName = displayName,
            onClick = debouncedClick,
            onLongClick = onLongClick,
            actionLabel = actionLabel,
            loadPreview = loadPreview,
            onRequestAccess = onRequestAccess,
        )
    }
}

@Composable
private fun WorkspaceResourceCard(
    card: ImResourceCard,
    displayName: String,
    onClick: (() -> Unit)?,
    onLongClick: (() -> Unit)?,
    actionLabel: String,
) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val shape = RoundedCornerShape(ImStructuredCardLayout.contactCornerRadius)
    val iconText = card.icon
        ?.trim()
        ?.takeIf { it.isNotEmpty() && !it.startsWith("http", ignoreCase = true) }
        ?: displayName.firstOrNull()?.uppercase()
        ?: "W"
    Row(
        modifier = Modifier
            .width(ImStructuredCardLayout.contactMaxWidth)
            .heightIn(min = ImStructuredCardLayout.contactMinHeight)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, accent.copy(alpha = 0.32f), shape)
            .imCardActions(onClick = onClick, onLongClick = onLongClick)
            .semantics { contentDescription = actionLabel }
            .padding(horizontal = TTSpacing.md, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(ImStructuredCardLayout.contactAvatarSize)
                .clip(RoundedCornerShape(12.dp))
                .background(accent.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = iconText,
                style = MaterialTheme.typography.titleMedium,
                color = accent,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = displayName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = stringResource(R.string.im_workspace_card_label),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Icon(
            imageVector = Icons.Default.ChatBubbleOutline,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

/** 指令卡正文最多展示两行；点击「使用此指令」只预填到新任务，不会绕过 AI 分身/Workspace 确认。 */
@Composable
private fun ImPromptCardContent(
    prompt: ImPromptCard,
    onUsePrompt: ((ImPromptCard) -> Unit)?,
    onLongClick: (() -> Unit)?,
) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val cardShape = RoundedCornerShape(ImStructuredCardLayout.cornerRadius)
    Column(
        modifier = Modifier
            .width(ImStructuredCardLayout.width)
            .height(ImStructuredCardLayout.promptHeight)
            .clip(cardShape)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.78f))
            .border(1.dp, accent.copy(alpha = 0.38f), cardShape)
            .imCardActions(onClick = null, onLongClick = onLongClick),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImStructuredCardLayout.promptBodyHeight)
                .padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(
                    modifier = Modifier.weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Default.Terminal,
                        contentDescription = null,
                        tint = accent,
                        modifier = Modifier.size(18.dp),
                    )
                    Text(
                        text = "指令",
                        style = MaterialTheme.typography.labelLarge,
                        color = accent,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Text(
                    text = "可复用",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .clip(RoundedCornerShape(ImStructuredCardLayout.actionCornerRadius))
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.64f))
                        .padding(horizontal = TTSpacing.sm, vertical = 4.dp),
                )
            }
            Text(
                text = prompt.displayTitle,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = prompt.promptText,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .clip(RoundedCornerShape(ImStructuredCardLayout.actionCornerRadius))
                    .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.62f))
                    .padding(TTSpacing.sm),
            )
        }
        HorizontalDivider(color = imBorderLight())
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(ImStructuredCardLayout.footerHeight)
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(
                onClick = { onUsePrompt?.invoke(prompt) },
                enabled = onUsePrompt != null,
                shape = RoundedCornerShape(ImStructuredCardLayout.actionCornerRadius),
                colors = ButtonDefaults.buttonColors(containerColor = accent),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(ImStructuredCardLayout.actionHeight),
            ) {
                Text("使用此指令", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun DocLikeResourceCard(
    card: ImResourceCard,
    displayName: String,
    onClick: ((ImResourceCardPreview?) -> Unit)?,
    onLongClick: (() -> Unit)?,
    actionLabel: String,
    loadPreview: (suspend (ImResourceCard) -> ImResourceCardPreviewResult)?,
    onRequestAccess: (suspend () -> Boolean)?,
) {
    val resourceKey = remember(card.type, card.resourceId) {
        ImCardStatusMemoryCache.resourceKey(card)
    }
    val cachedPreviews by ImCardStatusMemoryCache.resourcePreviews.collectAsState()
    val refreshRevisions by ImCardStatusMemoryCache.resourceRefreshRevisions.collectAsState()
    val requestedAccessKeys by ImCardStatusMemoryCache.requestedResourceAccess.collectAsState()
    val cachedPreview = resourceKey?.let { cachedPreviews[it] }
    val refreshRevision = resourceKey?.let { refreshRevisions[it] } ?: 0L
    val cachedAccessRequested = resourceKey != null && resourceKey in requestedAccessKeys
    var preview by remember(resourceKey) {
        mutableStateOf(cachedPreview ?: ImCardStatusMemoryCache.cachedResourcePreview(card))
    }
    var freshOpenPreview by remember(resourceKey) {
        mutableStateOf<ImResourceCardPreview?>(null)
    }
    var accessRequested by remember(resourceKey) {
        mutableStateOf(cachedAccessRequested || ImCardStatusMemoryCache.hasRequestedResourceAccess(card))
    }
    var requestingAccess by remember(card.type, card.resourceId) { mutableStateOf(false) }
    var openingResource by remember(card.type, card.resourceId) { mutableStateOf(false) }
    val actionScope = rememberCoroutineScope()
    LaunchedEffect(cachedPreview) {
        if (cachedPreview != null && cachedPreview != preview) preview = cachedPreview
    }
    LaunchedEffect(cachedAccessRequested) {
        accessRequested = cachedAccessRequested || ImCardStatusMemoryCache.hasRequestedResourceAccess(card)
    }
    LaunchedEffect(card.type, card.resourceId, refreshRevision) {
        freshOpenPreview = null
        if (loadPreview == null) return@LaunchedEffect
        val requestRevision = refreshRevision
        val loaded = loadPreview(card)
        if (ImCardStatusMemoryCache.resourceRefreshRevision(card) != requestRevision) {
            return@LaunchedEffect
        }
        val effective = if (loaded.status == ImResourceCardPreviewStatus.ERROR && preview != null) {
            preview
        } else {
            loaded
        }
        if (effective != null) {
            ImCardStatusMemoryCache.putResourcePreview(card, effective)
            if (effective != preview) preview = effective
        }
        freshOpenPreview = loaded.authoritativePreview()
    }
    val openResource = onClick?.let { action ->
        {
            val current = freshOpenPreview
            if (current != null) {
                action(current)
            } else if (!openingResource) {
                val loader = loadPreview
                if (loader == null) {
                    action(null)
                } else {
                    openingResource = true
                    actionScope.launch {
                        try {
                            val loaded = loader(card)
                            if (loaded.status != ImResourceCardPreviewStatus.ERROR || preview == null) {
                                ImCardStatusMemoryCache.putResourcePreview(card, loaded)
                                if (loaded != preview) preview = loaded
                            }
                            val authoritative = loaded.authoritativePreview()
                            freshOpenPreview = authoritative
                            action(authoritative)
                        } finally {
                            openingResource = false
                        }
                    }
                }
            }
        }
    }
    val isTable = card.type == ImResourceCardType.TABLE
    val accent = if (isTable) Color(0xFF24D99A) else Color(0xFF4B96FF)
    val background = accent.copy(alpha = if (isTable) 0.10f else 0.09f)
    val border = accent.copy(alpha = 0.45f)
    val status = preview?.status
    val data = preview?.data
    val resolvedTitle = data?.name?.trim()?.takeIf { it.isNotEmpty() } ?: displayName
    val resolvedDescription = data?.description?.trim()?.takeIf { it.isNotEmpty() } ?: card.description
    val tablePreview = data?.previewTable ?: card.previewTable

    Column(
        modifier = Modifier
            .width(ImStructuredCardLayout.width)
            .height(196.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(background)
            .border(1.dp, border, RoundedCornerShape(18.dp))
            .imCardActions(
                onClick = openResource?.takeIf { status != ImResourceCardPreviewStatus.FORBIDDEN },
                onLongClick = onLongClick,
            )
            .semantics { contentDescription = actionLabel },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(TTSpacing.md),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            ResourceTypePill(
                icon = if (isTable) Icons.Default.TableChart else Icons.Default.Description,
                label = if (isTable) "多维表格" else "云文档",
                accent = accent,
            )
            Text(
                text = resolvedTitle,
                style = MaterialTheme.typography.titleMedium,
                color = accent,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            when {
                status == ImResourceCardPreviewStatus.FORBIDDEN -> ForbiddenPreview(accent = accent)
                status == ImResourceCardPreviewStatus.DELETED -> Text(
                    text = "资源已删除或不可用",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                tablePreview != null && tablePreview.columns.isNotEmpty() -> Box(
                    modifier = Modifier.height(56.dp),
                ) {
                    TablePreviewGrid(tablePreview, accent)
                }
                !resolvedDescription.isNullOrBlank() -> Text(
                    text = resolvedDescription,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                else -> PreviewSkeleton(accent = accent)
            }
        }
        HorizontalDivider(color = border.copy(alpha = 0.45f))
        ResourceCardFooter(
            status = status,
            role = data?.currentUserRole,
            accessRequested = accessRequested,
            requestingAccess = requestingAccess,
            accent = accent,
            onOpen = openResource,
            onRequestAccess = onRequestAccess?.let { request ->
                {
                    actionScope.launch {
                        if (requestingAccess || accessRequested) return@launch
                        requestingAccess = true
                        try {
                            val submitted = request()
                            if (submitted) {
                                ImCardStatusMemoryCache.markResourceAccessRequested(card)
                                accessRequested = true
                            }
                        } finally {
                            requestingAccess = false
                        }
                    }
                }
            },
        )
    }
}

private fun ImResourceCardPreviewResult.authoritativePreview(): ImResourceCardPreview? =
    data?.takeIf {
        status == ImResourceCardPreviewStatus.OK && !it.organizationId.isNullOrBlank()
    }

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.imCardActions(
    onClick: (() -> Unit)?,
    onLongClick: (() -> Unit)?,
): Modifier = when {
    onLongClick != null -> combinedClickable(
        onClick = onClick ?: {},
        onLongClick = onLongClick,
    )
    onClick != null -> clickable(onClick = onClick)
    else -> this
}

@Composable
private fun ResourceTypePill(icon: ImageVector, label: String, accent: Color) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.72f))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = accent,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = accent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 表格采样：最多前 3 列 × 前 3 行（避免手机上过宽）。 */
@Composable
private fun TablePreviewGrid(preview: ImCardTablePreview, accent: Color = ttColor(TTColors.Primary, TTColors.Dark.Primary)) {
    val columns = preview.columns.take(3)
    val rows = preview.rows.take(3)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.58f))
            .padding(TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
            for (column in columns) {
                Text(
                    text = column.label.ifBlank { column.key },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        HorizontalDivider(color = accent.copy(alpha = 0.16f))
        for (row in rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                for (column in columns) {
                    Text(
                        text = row[column.key] ?: "",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        if (preview.totalRows > rows.size) {
            Text(
                text = stringResource(R.string.im_card_table_total_rows, preview.totalRows),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
        }
    }
}

@Composable
private fun PreviewSkeleton(accent: Color) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.45f))
            .padding(TTSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        repeat(3) { index ->
            Box(
                modifier = Modifier
                    .fillMaxWidth(if (index == 2) 0.72f else 0.92f)
                    .size(height = 8.dp, width = 1.dp)
                    .clip(CircleShape)
                    .background(accent.copy(alpha = 0.12f)),
            )
        }
    }
}

@Composable
private fun ForbiddenPreview(accent: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.58f))
            .padding(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Icon(Icons.Default.Visibility, contentDescription = null, tint = accent, modifier = Modifier.size(16.dp))
        Text(
            text = "暂无访问权限",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ResourceCardFooter(
    status: ImResourceCardPreviewStatus?,
    role: String?,
    accessRequested: Boolean,
    requestingAccess: Boolean,
    accent: Color,
    onOpen: (() -> Unit)?,
    onRequestAccess: (() -> Unit)?,
) {
    val permissionText = when {
        status == ImResourceCardPreviewStatus.FORBIDDEN && accessRequested -> "已申请访问"
        status == ImResourceCardPreviewStatus.FORBIDDEN -> "暂无访问权限"
        role in setOf("owner", "admin", "editor") -> "你可编辑"
        role == "viewer" -> "你可阅读"
        else -> "权限校验中"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = permissionText,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (status == ImResourceCardPreviewStatus.FORBIDDEN) {
            if (accessRequested) {
                Text(
                    text = "等待确认",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
                    maxLines = 1,
                )
            } else {
                TextButton(onClick = { onRequestAccess?.invoke() }, enabled = onRequestAccess != null && !requestingAccess) {
                    Text(if (requestingAccess) "申请中…" else "申请访问", color = accent)
                }
            }
        } else {
            TextButton(onClick = { onOpen?.invoke() }, enabled = onOpen != null) {
                Text("在工作台打开", color = accent)
            }
        }
    }
}

@Composable
private fun RowScope.ContactCard(
    card: ImResourceCard,
    displayName: String,
    contactAvatarUrl: String?,
    isSelf: Boolean,
) {
    val accent = ttColor(TTColors.Primary, TTColors.Dark.Primary)
    val subtitle = card.username?.takeIf { it.isNotBlank() }?.let { "@$it" }
        ?: stringResource(R.string.im_contact_card_label)
    TTAvatar(
        name = displayName,
        imageUrl = contactAvatarUrl ?: card.avatar,
        size = ImStructuredCardLayout.contactAvatarSize,
        shape = CircleShape,
    )
    Column(modifier = Modifier.weight(1f)) {
        Text(
            text = displayName,
            style = TTFonts.bodySemibold,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = subtitle,
            style = TTFonts.caption,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
    if (!isSelf) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(accent.copy(alpha = 0.08f))
                .border(1.dp, accent.copy(alpha = 0.35f), RoundedCornerShape(999.dp))
                .padding(horizontal = 9.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.ChatBubbleOutline,
                contentDescription = null,
                tint = accent,
                modifier = Modifier.size(12.dp),
            )
            Text(
                text = stringResource(R.string.im_contact_send_message),
                style = TTFonts.captionMedium,
                color = accent,
                maxLines = 1,
            )
        }
    }
}
