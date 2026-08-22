package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AskUserQuestion
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * AskUser questions 模式下的单题回答（与 iOS / Electron 协议对齐）。
 * 自由文本必须独立字段 `freeText`，**禁止**塞进 [selectedOptions]——
 * 后端 LLM 把 selected_options 解释为 option id 列表，自由文本若混入
 * 会被当成 id 解析丢失语义。
 */
public data class AskUserAnswerSelection(
    val questionId: String,
    val selectedOptions: List<String>,
    val freeText: String?,
)

@Composable
internal fun AskUserPanelView(
    title: String?,
    questions: List<AskUserQuestion>,
    isSubmitting: Boolean,
    onSubmit: (List<AskUserAnswerSelection>) -> Unit,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val selections = remember(questions) { mutableStateMapOf<String, MutableSet<String>>() }
    val freeTextInputs = remember(questions) { mutableStateMapOf<String, String>() }

    val hasAnyAnswer = questions.any { q ->
        selections[q.id]?.isNotEmpty() == true ||
            freeTextInputs[q.id]?.isNotBlank() == true
    }

    HitlQuestionPanel(
        title = title ?: stringResource(R.string.chat_ask_answer_questions),
        modifier = modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        contentSpacing = TTSpacing.sm,
        content = {
            questions.forEach { q ->
                // W4 (2026-05-11): header chip 在问题旁显示
                if (!q.header.isNullOrBlank()) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            q.header,
                            style = TTFonts.captionSemibold,
                            color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                            modifier = Modifier
                                .clip(TTRadius.Shapes.sm)
                                .background(ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.1f))
                                .padding(horizontal = TTSpacing.xs, vertical = 2.dp),
                        )
                        Spacer(Modifier.width(TTSpacing.xs))
                    }
                }
                Text(q.text, style = TTFonts.body, color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary))

                if (q.allowMultiple) {
                    Text(
                        stringResource(R.string.chat_ask_allow_multiple),
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }

                if (q.options.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                        q.options.forEach { option ->
                            val isSelected = selections[q.id]?.contains(option.id) == true
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(TTRadius.Shapes.sm)
                                    .background(
                                        if (isSelected) ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.08f)
                                        else Color.Transparent,
                                    )
                                    .border(
                                        1.dp,
                                        if (isSelected) ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.3f)
                                        else ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight),
                                        TTRadius.Shapes.sm,
                                    )
                                    .clickable {
                                        if (q.allowMultiple) {
                                            val current = selections.getOrPut(q.id) { mutableSetOf() }
                                            if (current.contains(option.id)) current.remove(option.id) else current.add(option.id)
                                        } else {
                                            selections[q.id] = mutableSetOf(option.id)
                                        }
                                    }
                                    .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(
                                    if (q.allowMultiple) {
                                        if (isSelected) Icons.Default.CheckBox else Icons.Default.CheckBoxOutlineBlank
                                    } else {
                                        if (isSelected) Icons.Default.RadioButtonChecked else Icons.Default.RadioButtonUnchecked
                                    },
                                    null,
                                    modifier = Modifier.size(16.dp),
                                    tint = if (isSelected) ttColor(TTColors.Primary, TTColors.Dark.Primary)
                                    else ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                )
                                Spacer(Modifier.width(TTSpacing.sm))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(option.label, style = TTFonts.caption, color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary))
                                    // W4 (2026-05-11): option.description 渲染
                                    if (!option.description.isNullOrBlank()) {
                                        Text(
                                            option.description,
                                            style = TTFonts.caption,
                                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                        )
                                    }
                                    // W4 (2026-05-11): option.preview（mockup / code snippet）
                                    if (!option.preview.isNullOrBlank()) {
                                        Text(
                                            option.preview,
                                            style = TTFonts.caption,
                                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                                            modifier = Modifier
                                                .padding(top = 2.dp)
                                                .clip(TTRadius.Shapes.sm)
                                                .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                                                .padding(horizontal = TTSpacing.xs, vertical = 2.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                if (q.allowFreeText) {
                    OutlinedTextField(
                        value = freeTextInputs[q.id] ?: "",
                        onValueChange = { freeTextInputs[q.id] = it },
                        placeholder = {
                            Text(
                                stringResource(R.string.chat_ask_custom_input),
                                style = TTFonts.caption,
                                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                            )
                        },
                        modifier = Modifier.fillMaxWidth(),
                        textStyle = TTFonts.caption,
                        singleLine = true,
                    )
                }
            }
        },
        actions = {
            OutlinedButton(
                onClick = { if (!isSubmitting) onSkip() },
                enabled = !isSubmitting,
            ) {
                Text(stringResource(R.string.chat_ask_skip), style = TTFonts.captionSemibold)
            }
            Button(
                onClick = {
                    if (!isSubmitting) {
                        // 拆分 selected_options 与 free_text 两个独立字段，与 iOS
                        // ConversationScreen.handleAskUserSubmit 行 790-799 对齐。
                        val result = mutableListOf<AskUserAnswerSelection>()
                        for (q in questions) {
                            val opts = selections[q.id]?.toList().orEmpty()
                            val free = freeTextInputs[q.id]?.trim()?.takeIf { it.isNotEmpty() }
                            if (opts.isNotEmpty() || free != null) {
                                result.add(AskUserAnswerSelection(q.id, opts, free))
                            }
                        }
                        onSubmit(result)
                    }
                },
                enabled = hasAnyAnswer && !isSubmitting,
                colors = ButtonDefaults.buttonColors(
                    containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                    contentColor = Color.White,
                ),
            ) {
                if (isSubmitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = Color.White,
                    )
                } else {
                    Text(stringResource(R.string.chat_ask_submit), style = TTFonts.captionSemibold)
                }
            }
        },
    )
}


// W4 (2026-05-11): AskUserFieldsFallbackPanelView / AskUserFieldsPanelView /
// AskUserFieldRow / SelectField / AskUserOptionRow / fieldPlaceholder 已下线——
// ask_form 形态合并到 ask_user questions[] 单形态。
// 整段 ~420 行 fields 渲染相关代码全部删除。
