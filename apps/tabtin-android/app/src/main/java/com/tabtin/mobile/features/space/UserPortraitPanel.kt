package com.tabtin.mobile.features.space

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.HourglassEmpty
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.UserPortraitApiException
import com.tabtin.mobile.data.model.DistillStatus
import com.tabtin.mobile.data.model.UserPortrait
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * UserPortraitPanel —— Android 实现，严格对齐 Electron `UserPortraitPanel.tsx`
 *
 * 4 个核心区块：
 *  1. TopStatusBar：上次蒸馏时间 + Organization 名 + "立即整理" 按钮
 *  2. PortraitContent：渲染 5 段 markdown（split by ## 后分段显示），空 content_md 显示 EmptyState
 *  3. Banner 区：LoadErrorBanner / DistillFailedBanner / StillDistillingBanner / Notice
 *  4. HintInput：输入框 + 提交 Button
 *
 * P0-2 / P0-3 等边界处理：
 *  - blockedByLoadError：加载失败且没拿到 portrait 时，禁用 "立即整理"/hint 输入
 *  - hint 提交失败：保留输入文字（rethrow，HintInput 内部不清空）
 *  - 切换 (organizationId, agentId)：hint 草稿按画像作用域重新创建
 *
 * 字体限制：不引入 Markdown 渲染库（避免增加依赖），按 Electron 的
 * parsePortraitSections 自己分段渲染（## 标题 + 正文），fallback 保留全文。
 */
@Composable
public fun UserPortraitPanel(
    organizationId: String,
    agentId: String,
    organizationName: String?,
    canManage: Boolean,
    viewModel: UserPortraitViewModel,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsState()
    val scope = rememberCoroutineScope()

    // 画像作用域变化时重置 + 重拉
    LaunchedEffect(organizationId, agentId) {
        viewModel.bind(organizationId, agentId)
    }

    // 没有 organizationId（极少出现）—— 直接展示 noOrganization 提示
    if (organizationId.isBlank() || agentId.isBlank()) {
        Box(
            modifier = modifier.fillMaxWidth().padding(vertical = TTSpacing.xl),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.user_portrait_no_organization),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    // ── 短暂通知（distill 调度成功 / hint 软警告 / hint 提交失败 / distill skipped）
    var notice by remember(organizationId, agentId) { mutableStateOf<TransientNotice?>(null) }
    LaunchedEffect(notice) {
        if (notice != null) {
            delay(2_500L)
            notice = null
        }
    }

    // 把后面 lambda（非 Composable 上下文）需要的字符串提前在 Composable 上下文里取出
    val distillScheduledText = stringResource(R.string.user_portrait_distill_scheduled)
    val distillSkippedText = stringResource(R.string.user_portrait_distill_skipped)
    val hintSubmitFailedText = stringResource(R.string.user_portrait_hint_submit_failed)

    val isLoadErrorWithoutPortrait = state.loadError != null && state.portrait == null
    // blockedByLoadError：加载失败且没有可用画像 —— "立即整理"和 hint 输入应被禁用
    val blockedByLoadError = isLoadErrorWithoutPortrait
    val memoryDisabled = state.portrait?.memoryEnabled == false
    val disabled = state.isLoading || !canManage || memoryDisabled
    val isDistillFailed = state.portrait?.lastDistillStatus == DistillStatus.FAILED

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        // ── 1. 顶部状态栏 ────────────────────────────────
        TopStatusBar(
            portrait = state.portrait,
            organizationName = organizationName,
            isDistilling = state.isDistilling,
            disabled = disabled || blockedByLoadError,
            onTriggerDistill = {
                scope.launch {
                    try {
                        val result = viewModel.triggerDistill(organizationId, agentId)
                        notice = when {
                            result.accepted == false -> TransientNotice.Info(
                                result.message ?: distillSkippedText,
                            )
                            !result.message.isNullOrBlank() -> TransientNotice.Info(result.message)
                            else -> TransientNotice.Info(distillScheduledText)
                        }
                    } catch (e: UserPortraitApiException) {
                        notice = TransientNotice.Error(e.message ?: e.errorCode ?: "")
                    } catch (e: Exception) {
                        notice = TransientNotice.Error(e.message ?: e.javaClass.simpleName)
                    }
                }
            },
        )

        // ── 2. Banner 区 ────────────────────────────────
        state.loadError?.let { message ->
            LoadErrorBanner(
                message = message,
                disabled = state.isLoading,
                onRetry = { viewModel.refresh(organizationId, agentId) },
            )
        }

        if (isDistillFailed) {
            val err = state.portrait?.lastDistillError.orEmpty()
            if (err.isNotBlank()) {
                DistillFailedBanner(
                    error = err,
                    disabled = disabled,
                    onRetry = {
                        scope.launch {
                            try {
                                viewModel.triggerDistill(organizationId, agentId)
                            } catch (e: UserPortraitApiException) {
                                notice = TransientNotice.Error(e.message ?: e.errorCode ?: "")
                            } catch (e: Exception) {
                                notice = TransientNotice.Error(e.message ?: e.javaClass.simpleName)
                            }
                        }
                    },
                )
            }
        }

        if (state.isStillDistilling) {
            StillDistillingBanner(
                disabled = state.isLoading,
                onRefresh = { viewModel.refresh(organizationId, agentId) },
            )
        }

        notice?.let { TransientNoticeBanner(it) }

        // ── 3. 画像主体 ────────────────────────────────
        if (memoryDisabled) {
            Text(
                text = stringResource(R.string.user_portrait_disabled),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.xl),
                textAlign = TextAlign.Center,
            )
        } else if (!isLoadErrorWithoutPortrait) {
            PortraitMainSection(
                portrait = state.portrait,
                isLoading = state.isLoading,
                isDistilling = state.isDistilling,
            )
        }

        // ── 4. Hint 输入 ────────────────────────────────
        if (!memoryDisabled) {
            HintInput(
                // (organizationId, agentId) 共同作 key，切换分身时清空草稿，避免提交到错误画像。
                key = "$organizationId:$agentId",
                disabled = disabled || state.isDistilling || blockedByLoadError,
                onSubmit = { text ->
                    try {
                        val result = viewModel.submitHint(organizationId, agentId, text)
                        notice = when {
                            !result.softWarning.isNullOrBlank() -> TransientNotice.Warn(result.softWarning)
                            result.distillDispatched != false -> TransientNotice.Info(distillScheduledText)
                            else -> null
                        }
                        true
                    } catch (e: UserPortraitApiException) {
                        val raw = e.message ?: e.errorCode ?: ""
                        val prefix = hintSubmitFailedText
                        notice = TransientNotice.Error(
                            if (raw.isBlank()) prefix else "$prefix ($raw)",
                        )
                        false
                    } catch (e: Exception) {
                        val raw = e.message ?: e.javaClass.simpleName
                        val prefix = hintSubmitFailedText
                        notice = TransientNotice.Error(
                            if (raw.isBlank()) prefix else "$prefix ($raw)",
                        )
                        false
                    }
                },
            )
        }
    }
}

// ── 顶部状态栏 ─────────────────────────────────────────────

@Composable
private fun TopStatusBar(
    portrait: UserPortrait?,
    organizationName: String?,
    isDistilling: Boolean,
    disabled: Boolean,
    onTriggerDistill: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                val timeStr = formatRelative(portrait?.lastDistilledAt)
                Text(
                    text = stringResource(R.string.user_portrait_last_distilled_at, timeStr),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = onTriggerDistill,
                    enabled = !disabled && !isDistilling,
                    contentPadding = PaddingValues(horizontal = TTSpacing.sm),
                ) {
                    if (isDistilling) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Default.AutoAwesome,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                    Spacer(Modifier.width(width = TTSpacing.xs))
                    Text(stringResource(R.string.user_portrait_distill_now))
                }
            }
            if (!organizationName.isNullOrBlank()) {
                Text(
                    text = stringResource(R.string.user_portrait_organization_scope, organizationName),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
    }
}

// ── 画像主体（5 段渲染 + Loading + Empty + Distilling 遮罩） ─

@Composable
private fun PortraitMainSection(
    portrait: UserPortrait?,
    isLoading: Boolean,
    isDistilling: Boolean,
) {
    Box(modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp)) {
        val portraitOrNull = portrait
        when {
            isLoading && portraitOrNull == null -> {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.xxl),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp))
                }
            }
            portraitOrNull != null && portraitOrNull.contentMd.isNotBlank() -> {
                PortraitContent(portraitOrNull)
            }
            else -> {
                EmptyState()
            }
        }

        // 蒸馏中遮罩
        if (isDistilling) {
            DistillingOverlay()
        }
    }
}

@Composable
private fun PortraitContent(portrait: UserPortrait) {
    val sections = remember(portrait.contentMd) {
        parsePortraitSections(portrait.contentMd)
    }
    if (sections.isEmpty()) {
        // fallback：未匹配到 ## 标题时整段显示
        Text(
            text = portrait.contentMd,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.lg)) {
        sections.forEach { section ->
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                Text(
                    text = section.title,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                HorizontalDivider(
                    color = MaterialTheme.colorScheme.outlineVariant,
                    thickness = 1.dp,
                )
                if (section.body.isNotBlank()) {
                    Text(
                        text = section.body,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyState() {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Text(
            text = stringResource(R.string.user_portrait_empty_title),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            text = stringResource(R.string.user_portrait_empty_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun DistillingOverlay() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 120.dp)
            // 半透明遮罩
            .padding(0.dp),
        contentAlignment = Alignment.Center,
    ) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
            ),
            shape = RoundedCornerShape(8.dp),
        ) {
            Column(
                modifier = Modifier.padding(TTSpacing.lg),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp))
                Text(
                    text = stringResource(R.string.user_portrait_distilling_title),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = stringResource(R.string.user_portrait_distilling_hint),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// ── Banner ─────────────────────────────────────────────────

@Composable
private fun LoadErrorBanner(
    message: String,
    disabled: Boolean,
    onRetry: () -> Unit,
) {
    BannerCard(
        bgColor = MaterialTheme.colorScheme.errorContainer,
        iconTint = MaterialTheme.colorScheme.error,
        icon = { Icon(Icons.Default.Error, contentDescription = null, tint = it) },
        title = stringResource(R.string.user_portrait_load_error_title),
        body = message,
        actionLabel = stringResource(R.string.user_portrait_load_error_retry),
        actionEnabled = !disabled,
        onAction = onRetry,
    )
}

@Composable
private fun DistillFailedBanner(
    error: String,
    disabled: Boolean,
    onRetry: () -> Unit,
) {
    BannerCard(
        bgColor = MaterialTheme.colorScheme.errorContainer,
        iconTint = MaterialTheme.colorScheme.error,
        icon = { Icon(Icons.Default.Error, contentDescription = null, tint = it) },
        title = stringResource(R.string.user_portrait_distill_failed_title),
        body = error,
        actionLabel = stringResource(R.string.user_portrait_distill_failed_retry),
        actionEnabled = !disabled,
        onAction = onRetry,
    )
}

@Composable
private fun StillDistillingBanner(
    disabled: Boolean,
    onRefresh: () -> Unit,
) {
    BannerCard(
        bgColor = MaterialTheme.colorScheme.tertiaryContainer,
        iconTint = MaterialTheme.colorScheme.tertiary,
        icon = { Icon(Icons.Default.HourglassEmpty, contentDescription = null, tint = it) },
        title = stringResource(R.string.user_portrait_still_distilling),
        body = stringResource(R.string.user_portrait_still_distilling_hint),
        actionLabel = stringResource(R.string.user_portrait_still_distilling_refresh),
        actionEnabled = !disabled,
        onAction = onRefresh,
    )
}

@Composable
private fun BannerCard(
    bgColor: Color,
    iconTint: Color,
    icon: @Composable (Color) -> Unit,
    title: String,
    body: String,
    actionLabel: String,
    actionEnabled: Boolean,
    onAction: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = bgColor),
    ) {
        Row(
            modifier = Modifier.padding(TTSpacing.md),
            verticalAlignment = Alignment.Top,
        ) {
            icon(iconTint)
            Spacer(Modifier.width(TTSpacing.sm))
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs)) {
                Text(title, style = MaterialTheme.typography.bodyMedium)
                if (body.isNotBlank()) {
                    Text(
                        text = body,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            TextButton(onClick = onAction, enabled = actionEnabled) {
                Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(TTSpacing.xxs))
                Text(actionLabel)
            }
        }
    }
}

// ── 短暂通知 banner ───────────────────────────────────────

private sealed interface TransientNotice {
    val text: String
    data class Info(override val text: String) : TransientNotice
    data class Warn(override val text: String) : TransientNotice
    data class Error(override val text: String) : TransientNotice
}

@Composable
private fun TransientNoticeBanner(notice: TransientNotice) {
    val bg = when (notice) {
        is TransientNotice.Info -> MaterialTheme.colorScheme.primaryContainer
        is TransientNotice.Warn -> MaterialTheme.colorScheme.tertiaryContainer
        is TransientNotice.Error -> MaterialTheme.colorScheme.errorContainer
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = bg),
    ) {
        Text(
            text = notice.text,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        )
    }
}

// ── Hint 输入区 ───────────────────────────────────────────

@Composable
private fun HintInput(
    key: String,
    disabled: Boolean,
    onSubmit: suspend (text: String) -> Boolean,
) {
    val scope = rememberCoroutineScope()
    // 用 organizationId 作 saveable key —— 切换 Organization 时草稿清空
    var text by rememberSaveable(key) { mutableStateOf("") }
    var submitting by remember(key) { mutableStateOf(false) }

    val trimmed = text.trim()
    val hasText = trimmed.isNotEmpty()
    val overHard = trimmed.length > HINT_HARD_LIMIT
    val overSoft = trimmed.length > HINT_SOFT_LIMIT && !overHard

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.fillMaxWidth(),
                enabled = !disabled && !submitting,
                minLines = 2,
                maxLines = 4,
                placeholder = {
                    Text(
                        stringResource(R.string.user_portrait_hint_placeholder),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                },
                shape = RoundedCornerShape(6.dp),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                val warningText = when {
                    overHard -> stringResource(R.string.user_portrait_hint_hard_limit, HINT_HARD_LIMIT)
                    overSoft -> stringResource(R.string.user_portrait_hint_soft_limit, HINT_SOFT_LIMIT)
                    else -> ""
                }
                Text(
                    text = warningText,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (overHard) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        if (!hasText || overHard || submitting) return@Button
                        scope.launch {
                            submitting = true
                            val sent = trimmed
                            try {
                                val succeeded = onSubmit(sent)
                                if (succeeded) {
                                    text = ""
                                }
                                // P0-3：失败时不清空 text，让用户能直接再发一次
                            } finally {
                                submitting = false
                            }
                        }
                    },
                    enabled = hasText && !overHard && !submitting && !disabled,
                    contentPadding = PaddingValues(horizontal = TTSpacing.md),
                    colors = ButtonDefaults.buttonColors(),
                ) {
                    if (submitting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                    Spacer(Modifier.width(TTSpacing.xs))
                    Text(stringResource(R.string.user_portrait_hint_submit))
                }
            }
    }
}

// ── 工具 ──────────────────────────────────────────────────

/**
 * 相对时间格式化（与 Electron formatRelativeTime 对齐）：
 *  - <1min：刚刚
 *  - <60min：N 分钟前
 *  - <24h：N 小时前
 *  - <7d：N 天前
 *  - 更久：yyyy-MM-dd（locale 默认）
 */
@Composable
private fun formatRelative(iso: String?): String {
    if (iso.isNullOrBlank()) return stringResource(R.string.user_portrait_never_distilled)
    val ts = parseIsoMillis(iso) ?: return iso
    val now = System.currentTimeMillis()
    val diffMs = now - ts
    val min = diffMs / 60_000L
    val hour = diffMs / 3_600_000L
    val day = diffMs / 86_400_000L
    return when {
        min < 1 -> stringResource(R.string.user_portrait_just_now)
        min < 60 -> stringResource(R.string.user_portrait_minutes_ago, min)
        hour < 24 -> stringResource(R.string.user_portrait_hours_ago, hour)
        day < 7 -> stringResource(R.string.user_portrait_days_ago, day)
        else -> formatYmd(ts)
    }
}

private fun parseIsoMillis(iso: String): Long? {
    // Java 8+ Instant.parse 支持 ISO-8601 后缀 Z 与 offset，但有些后端返回不带 Z 的 naive ISO
    return try {
        java.time.Instant.parse(iso).toEpochMilli()
    } catch (_: Exception) {
        try {
            java.time.LocalDateTime
                .parse(iso)
                .atZone(java.time.ZoneOffset.UTC)
                .toInstant()
                .toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }
}

private fun formatYmd(millis: Long): String {
    val zdt = java.time.Instant.ofEpochMilli(millis)
        .atZone(java.time.ZoneId.systemDefault())
    return java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd").format(zdt)
}

// HINT 软 / 硬限制，对齐后端 HINT_SOFT_LIMIT_CHARS / 硬阈值
internal const val HINT_SOFT_LIMIT: Int = 200
internal const val HINT_HARD_LIMIT: Int = 2_000
