package com.tabtin.mobile.features.conversation

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentTodoItem
import com.tabtin.mobile.data.model.TodoStatus
import com.tabtin.mobile.features.conversation.cards.ChatCardTokens
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun TodoPanelView(
    todos: List<AgentTodoItem>,
    paused: Boolean,
    awaitingSubagents: Boolean,
    modifier: Modifier = Modifier,
) {
    val strip = remember(todos, paused, awaitingSubagents) {
        TodoStripPresentation.make(todos, paused, awaitingSubagents)
    } ?: return

    var expanded by remember { mutableStateOf(false) }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xxs),
    ) {
    Column(
        modifier = Modifier
            .widthIn(max = 680.dp)
            .fillMaxWidth()
            .align(Alignment.Center)
            .clip(ChatCardTokens.cardRadius)
            .background(ChatCardTokens.bgCard())
            .border(1.dp, ChatCardTokens.borderDefault(), ChatCardTokens.cardRadius),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(
                    onClickLabel = stringResource(
                        R.string.chat_todo_open_details,
                        strip.done,
                        strip.total,
                    ),
                ) { expanded = !expanded }
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.Checklist,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = ChatCardTokens.textMuted(),
            )
            Spacer(Modifier.width(TTSpacing.xs))
            StripStatusIcon(strip)
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                stripLabel(strip),
                style = TTFonts.caption,
                color = ChatCardTokens.textSecondary(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                strip.progressText,
                style = TTFonts.caption,
                color = ChatCardTokens.textMuted(),
            )
            Spacer(Modifier.width(TTSpacing.xxs))
            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = ChatCardTokens.textMuted(),
            )
        }

        if (strip.total > 0) {
            val barColor = if (strip.iconKind == TodoStripPresentation.IconKind.COMPLETE) {
                ChatCardTokens.diffAddText()
            } else {
                ChatCardTokens.textAccent()
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(2.dp)
                    .background(ChatCardTokens.textMuted().copy(alpha = 0.1f)),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(strip.progressScale)
                        .height(2.dp)
                        .background(barColor),
                )
            }
        }

        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column(
                modifier = Modifier
                    .heightIn(max = 200.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                todos.forEach { todo ->
                    key(todo.id) { TodoRow(todo) }
                }
            }
        }
    }
    }
}

@Composable
private fun stripLabel(strip: TodoStripPresentation.View): String {
    val content = strip.currentContent.orEmpty()
    return when (strip.labelKind) {
        TodoStripPresentation.LabelKind.ALL_DONE -> stringResource(R.string.chat_todo_all_done)
        TodoStripPresentation.LabelKind.AWAITING_SUBAGENTS ->
            stringResource(R.string.chat_todo_awaiting_subagents, content)
        TodoStripPresentation.LabelKind.PAUSED_CURRENT ->
            stringResource(R.string.chat_todo_paused_current, content)
        TodoStripPresentation.LabelKind.CURRENT ->
            stringResource(R.string.chat_todo_current, content)
    }
}

@Composable
private fun StripStatusIcon(strip: TodoStripPresentation.View) {
    when (strip.iconKind) {
        TodoStripPresentation.IconKind.COMPLETE -> Icon(
            Icons.Default.CheckCircle,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = ChatCardTokens.diffAddText(),
        )
        TodoStripPresentation.IconKind.PAUSED -> Icon(
            Icons.Default.Pause,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = ChatCardTokens.textMuted(),
        )
        TodoStripPresentation.IconKind.IN_PROGRESS -> CircularProgressIndicator(
            modifier = Modifier.size(14.dp),
            strokeWidth = 1.5.dp,
            color = ChatCardTokens.textAccent(),
        )
        TodoStripPresentation.IconKind.IDLE -> Icon(
            Icons.Outlined.Circle,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = ChatCardTokens.textMuted().copy(alpha = 0.6f),
        )
    }
}

@Composable
private fun TodoRow(todo: AgentTodoItem) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.Top,
    ) {
        when (todo.status) {
            TodoStatus.COMPLETED -> Icon(
                Icons.Default.CheckCircle, contentDescription = stringResource(R.string.chat_todo_completed),
                modifier = Modifier.size(14.dp),
                tint = ChatCardTokens.diffAddText(),
            )
            TodoStatus.IN_PROGRESS -> CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                strokeWidth = 1.5.dp,
                color = ChatCardTokens.textAccent(),
            )
            TodoStatus.CANCELLED -> Icon(
                Icons.Default.Cancel, contentDescription = stringResource(R.string.chat_todo_cancelled),
                modifier = Modifier.size(14.dp),
                tint = ChatCardTokens.textMuted().copy(alpha = 0.4f),
            )
            TodoStatus.PAUSED -> Icon(
                Icons.Default.Schedule, contentDescription = stringResource(R.string.chat_todo_paused),
                modifier = Modifier.size(14.dp),
                tint = ChatCardTokens.textMuted(),
            )
            TodoStatus.PENDING -> Icon(
                Icons.Outlined.Circle, contentDescription = stringResource(R.string.chat_todo_pending),
                modifier = Modifier.size(14.dp),
                tint = ChatCardTokens.textMuted().copy(alpha = 0.6f),
            )
        }
        Spacer(Modifier.width(TTSpacing.xs))
        Text(
            todo.content,
            style = TTFonts.caption,
            color = when (todo.status) {
                TodoStatus.CANCELLED -> ChatCardTokens.textMuted().copy(alpha = 0.4f)
                TodoStatus.COMPLETED -> ChatCardTokens.textSecondary()
                else -> ChatCardTokens.textPrimary()
            },
            textDecoration = if (todo.status == TodoStatus.CANCELLED) TextDecoration.LineThrough else null,
        )
    }
}
