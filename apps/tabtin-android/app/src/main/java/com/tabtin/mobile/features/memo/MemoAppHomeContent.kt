package com.tabtin.mobile.features.memo

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.memo.MemoAppHomeFeatureFlags
import com.tabtin.mobile.data.model.memo.MemoHeatmapBucket
import com.tabtin.mobile.features.memo.voice.MemoVoiceRecorderOverlay
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * Organization Memo App 首页可嵌入内容：搜索、热力图、视图切换、快捷落笔与时间流。
 * 详情 / 编辑器 / 语音复用既有 Overlay，不在此重写。
 *
 * Organization 首页固定 [spaceId] 为空串。
 */
@Composable
public fun MemoAppHomeContent(
    viewModel: TabMemoViewModel,
    organizationId: String,
    organizationName: String = "",
    appTitle: String = "",
    spaceId: String = "",
    onBack: (() -> Unit)? = null,
    initialMemoId: String? = null,
    backHandlingEnabled: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsState()
    var isEditorPresented by remember { mutableStateOf(false) }
    var isVoiceRecorderPresented by remember { mutableStateOf(false) }
    var detailMemoId by remember { mutableStateOf<String?>(initialMemoId) }

    LaunchedEffect(organizationId) {
        viewModel.loadMemos(organizationId, spaceId, force = true)
    }
    LaunchedEffect(initialMemoId) {
        if (!initialMemoId.isNullOrBlank()) {
            detailMemoId = initialMemoId
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            MemoAppHomeHeader(
                title = appTitle.ifBlank { stringResource(R.string.memo_tab_title) },
                organizationName = organizationName,
                onBack = onBack,
            )
            MemoHomeSearchField(
                query = state.homeSearchQuery,
                onQueryChange = viewModel::setHomeSearchQuery,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
            )
            MemoHeatmapRow(
                monthCount = state.monthCount,
                buckets = state.heatmapBuckets,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg),
            )
            MemoViewKindRow(
                selected = state.viewKind,
                onSelect = viewModel::setViewKind,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
            )
            if (organizationId.isEmpty()) {
                NoOrganizationView(modifier = Modifier.fillMaxSize())
            } else {
                MemoListContent(
                    viewModel = viewModel,
                    organizationId = organizationId,
                    spaceId = spaceId,
                    onMemoClick = { detailMemoId = it },
                    onZenEditorTap = { isEditorPresented = true },
                    onVoiceRecordTap = { isVoiceRecorderPresented = true },
                    useHomeSections = true,
                )
            }
        }

        if (isEditorPresented) {
            MemoEditorOverlay(
                isPresented = isEditorPresented,
                viewModel = viewModel,
                onDismiss = { isEditorPresented = false },
                onCreated = { isEditorPresented = false },
            )
        }

        if (isVoiceRecorderPresented) {
            MemoVoiceRecorderOverlay(
                viewModel = viewModel,
                webSocketService = viewModel.webSocketService,
                tokenManager = viewModel.tokenManager,
                backHandlingEnabled = backHandlingEnabled,
                onDismiss = { isVoiceRecorderPresented = false },
                onCreated = {
                    isVoiceRecorderPresented = false
                    viewModel.loadMemos(organizationId, spaceId, force = true)
                },
            )
        }

        detailMemoId?.let { memoId ->
            Box(Modifier.fillMaxSize()) {
                MemoDetailScreen(
                    memoId = memoId,
                    viewModel = viewModel,
                    onDismiss = { detailMemoId = null },
                    backHandlingEnabled = backHandlingEnabled,
                )
            }
        }
    }
}

@Composable
private fun MemoAppHomeHeader(
    title: String,
    organizationName: String,
    onBack: (() -> Unit)?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            val backLabel = stringResource(R.string.workbench_back_to_overview)
            IconButton(
                onClick = onBack,
                modifier = Modifier.semantics {
                    contentDescription = backLabel
                },
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = backLabel,
                )
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.semantics { heading() },
            )
            if (organizationName.isNotBlank()) {
                val orgLabel = stringResource(R.string.memo_home_org_label)
                Text(
                    text = organizationName,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.semantics {
                        contentDescription = "$orgLabel $organizationName"
                    },
                )
            }
        }
    }
}

@Composable
private fun MemoHomeSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val hint = stringResource(R.string.memo_home_search_hint)
    TabSearchField(
        query = query,
        onQueryChange = onQueryChange,
        placeholder = hint,
        modifier = modifier.semantics { contentDescription = hint },
    )
}

@Composable
private fun MemoHeatmapRow(
    monthCount: Int,
    buckets: List<MemoHeatmapBucket>,
    modifier: Modifier = Modifier,
) {
    val label = stringResource(R.string.memo_home_month_count, monthCount)
    val heatmapLabel = stringResource(R.string.memo_home_heatmap)
    Column(
        modifier = modifier.semantics {
            contentDescription = "$heatmapLabel. $label"
        },
        verticalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            val visible = buckets.takeLast(84)
            visible.forEach { bucket ->
                val intensity = when {
                    bucket.count <= 0 -> 0.12f
                    bucket.count == 1 -> 0.35f
                    bucket.count <= 3 -> 0.55f
                    else -> 0.85f
                }
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = intensity)),
                )
            }
            if (visible.isEmpty()) {
                Box(
                    modifier = Modifier
                        .height(8.dp)
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(2.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant),
                )
            }
        }
    }
}

@Composable
private fun MemoViewKindRow(
    selected: MemoViewKind,
    onSelect: (MemoViewKind) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        MemoViewKind.visibleKinds().forEach { kind ->
            val label = when (kind) {
                MemoViewKind.ALL -> stringResource(R.string.memo_all)
                MemoViewKind.TODAY -> stringResource(R.string.memo_home_today_review)
                MemoViewKind.AGENT_DIARY -> stringResource(R.string.memo_home_agent_diary)
            }
            FilterChip(
                selected = selected == kind,
                onClick = { onSelect(kind) },
                label = { Text(label) },
                modifier = Modifier.semantics { contentDescription = label },
            )
        }
        // 隐藏态断言：flag 关闭时不应渲染 Agent 日记芯片
        if (!MemoAppHomeFeatureFlags.IS_ORGANIZATION_AGENT_DIARY_ENABLED) {
            // no-op：visibleKinds 已排除
        }
    }
}
