package com.tabtin.mobile.features.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing

/**
 * 工作台入口胶囊：有资源时展示摘要，否则展示「工作台」占位，始终可点击进入 overview。
 * Agent 状态见 [com.tabtin.mobile.features.conversation.AgentStatusCapsule]。
 */
@Composable
public fun WorkbenchSummaryPill(
    resourceSummary: String,
    hasResources: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val displayText = resourceSummary.ifEmpty {
        stringResource(R.string.workbench_title)
    }

    Row(
        modifier = modifier
            .clip(RoundedCornerShape(TTRadius.full))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
    ) {
        Text(
            text = displayText,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Deprecated(
    message = "Use WorkbenchSummaryPill for resource summary; Agent status uses AgentStatusCapsule",
    replaceWith = ReplaceWith(
        "WorkbenchSummaryPill(resourceSummary, hasResources, onClick, modifier)",
        "com.tabtin.mobile.features.workbench.WorkbenchSummaryPill",
    ),
)
@Composable
public fun WorkbenchCapsule(
    isStreaming: Boolean,
    resourceSummary: String,
    hasResources: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // isStreaming 刻意忽略：不再用资源摘要胶囊冒充 Agent 状态。
    WorkbenchSummaryPill(
        resourceSummary = resourceSummary,
        hasResources = hasResources || isStreaming,
        onClick = onClick,
        modifier = modifier,
    )
}
