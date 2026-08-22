package com.tabtin.mobile.features.conversation.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing

@Composable
internal fun TerminalCardView(step: AgentStep, isSsh: Boolean = false) {
    val shape = ChatCardTokens.cardRadius
    val input = remember(step.input) { parseJson(step.input) }
    val output = remember(step.output) { parseJson(step.output) }

    val command = input?.optString("command").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("cmd").takeIf { !it.isNullOrEmpty() }
        ?: step.input?.take(200) ?: ""
    val exitCode = output?.optInt("exit_code", -1) ?: -1
    val stdout = output?.optString("stdout").takeIf { !it.isNullOrEmpty() }
        ?: output?.optString("output").takeIf { !it.isNullOrEmpty() }
        ?: step.output ?: ""
    val stderr = output?.optString("stderr").orEmpty()
    val cwd = output?.optString("cwd").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("working_directory").takeIf { !it.isNullOrEmpty() }
    val server = if (isSsh) (input?.optString("host").takeIf { !it.isNullOrEmpty() }
        ?: input?.optString("server").takeIf { !it.isNullOrEmpty() }) else null

    val isRunning = step.status == StepStatus.RUNNING
    val isError = step.status == StepStatus.FAILED ||
        (exitCode != 0 && exitCode != -1 && !isRunning)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(ChatCardTokens.bgTerminal())
            .border(
                0.5.dp,
                if (isError) ChatCardTokens.borderError() else ChatCardTokens.borderDefault(),
                shape,
            ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = ChatCardTokens.cardPaddingH, vertical = ChatCardTokens.headerPaddingV),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                isRunning -> CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    strokeWidth = 1.5.dp,
                    color = Color.White.copy(alpha = 0.6f),
                )
                isError -> Icon(
                    Icons.Default.Error, null,
                    modifier = Modifier.size(12.dp),
                    tint = ChatCardTokens.diffRemoveText(),
                )
                else -> Icon(
                    Icons.Default.CheckCircle, null,
                    modifier = Modifier.size(12.dp),
                    tint = ChatCardTokens.diffAddText(),
                )
            }
            Spacer(Modifier.width(TTSpacing.xs))
            if (server != null) {
                Text(server, style = TTFonts.captionSemibold, color = ChatCardTokens.textSshHost())
                Spacer(Modifier.width(TTSpacing.xs))
            }
            Text(
                "$ ${command.take(120)}",
                style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                color = Color.White.copy(alpha = 0.9f),
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            if (!isRunning && exitCode >= 0) {
                Spacer(Modifier.width(TTSpacing.xs))
                Text(
                    stringResource(R.string.chat_card_exit_code, exitCode),
                    style = TTFonts.caption,
                    color = if (isError) ChatCardTokens.diffRemoveText()
                    else Color.White.copy(alpha = 0.4f),
                )
            }
        }

        val displayOutput = stdout.ifBlank { stderr }.trim()
        if (displayOutput.isNotEmpty()) {
            SelectionContainer {
                Text(
                    displayOutput.take(3000),
                    style = TTFonts.caption.copy(fontFamily = FontFamily.Monospace),
                    color = if (stderr.isNotBlank() && stdout.isBlank()) ChatCardTokens.diffRemoveText()
                    else Color.White.copy(alpha = 0.8f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = ChatCardTokens.maxHeightMd)
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = ChatCardTokens.cardPaddingH, vertical = ChatCardTokens.cardPaddingV),
                )
            }
        }

        cwd?.let {
            Text(
                it, style = TTFonts.caption,
                color = Color.White.copy(alpha = 0.3f),
                maxLines = 1,
                modifier = Modifier.padding(horizontal = ChatCardTokens.cardPaddingH, vertical = TTSpacing.xxs),
            )
        }
    }
}
