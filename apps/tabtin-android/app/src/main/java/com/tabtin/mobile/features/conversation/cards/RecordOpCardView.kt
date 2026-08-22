package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun RecordOpCardView(step: AgentStep) {
    if (step.status == StepStatus.FAILED) {
        ErrorBannerView(step.output ?: stringResource(R.string.chat_error_tool_exec))
        return
    }
    if (step.status == StepStatus.RUNNING && step.output.isNullOrBlank() && step.input.isNullOrBlank()) {
        LoadingPlaceholderView()
        return
    }

    val output = remember(step.output) { parseJson(step.output) }
    val input = remember(step.input) { parseJson(step.input) }

    val operation = output?.optString("operation").orEmpty()
        .ifEmpty { input?.optString("operation").orEmpty() }
    val recordId = output?.optString("record_id").takeIf { !it.isNullOrEmpty() }
        ?: output?.optString("id").orEmpty()
    val tableId = input?.optString("table_id").takeIf { !it.isNullOrEmpty() }
        ?: output?.optString("table_id").orEmpty()

    val (icon, accentColor, label) = when (operation.lowercase()) {
        "create", "created" -> Triple(Icons.Default.Add, ChatCardTokens.diffAddText(), stringResource(R.string.chat_card_record_created))
        "delete", "deleted" -> Triple(Icons.Default.Delete, ChatCardTokens.diffRemoveText(), stringResource(R.string.chat_card_record_deleted))
        else -> Triple(Icons.Default.Edit, ChatCardTokens.textAccent(), stringResource(R.string.chat_card_record_updated))
    }

    ToolCardContainer(
        header = {
            Icon(icon, contentDescription = label, modifier = Modifier.size(ChatCardTokens.iconSize), tint = accentColor)
            Spacer(Modifier.width(TTSpacing.xs))
            Text(label, style = TTFonts.captionSemibold, color = accentColor)
            if (recordId.isNotBlank()) {
                Spacer(Modifier.width(TTSpacing.sm))
                val displayId = if (recordId.length > 12) "${recordId.take(8)}…" else recordId
                Text(displayId, style = TTFonts.caption, color = ChatCardTokens.textMuted())
            }
        },
    ) {
        Column(
            modifier = Modifier.padding(ChatCardTokens.cardPaddingH, ChatCardTokens.cardPaddingV),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
        ) {
            if (tableId.isNotBlank()) {
                InfoRow(stringResource(R.string.chat_card_table), tableId)
            }

            val message = output?.optString("message").takeIf { !it.isNullOrEmpty() }
            val data = output?.optJSONObject("data")
                ?: input?.optJSONObject("data")
                ?: input?.optJSONObject("fields")
            if (data != null) {
                val fieldCount = data.length()
                InfoRow(stringResource(R.string.chat_card_fields), fieldCount.toString())
                KeyValuePairsView(data)
            } else if (message != null) {
                Text(message, style = TTFonts.caption, color = ChatCardTokens.textSecondary())
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row {
        Text(label, style = TTFonts.caption, color = ChatCardTokens.textSecondary())
        Spacer(Modifier.width(TTSpacing.xs))
        Text(value, style = TTFonts.caption, color = ChatCardTokens.textPrimary())
    }
}
