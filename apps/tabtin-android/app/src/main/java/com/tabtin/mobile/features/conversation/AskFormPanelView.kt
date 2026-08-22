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
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AskFormField
import com.tabtin.mobile.data.model.AskFormRequest
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
internal fun AskFormPanelView(
    request: AskFormRequest,
    isSubmitting: Boolean,
    onSubmit: (JsonObject) -> Unit,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val textValues = remember(request.requestId) { mutableStateMapOf<String, String>() }
    val toggleValues = remember(request.requestId) { mutableStateMapOf<String, Boolean>() }
    val singleSelect = remember(request.requestId) { mutableStateMapOf<String, String>() }
    val multiSelect = remember(request.requestId) { mutableStateMapOf<String, MutableSet<String>>() }
    var attemptedSubmit by remember(request.requestId) { mutableStateOf(false) }

    fun normalized(raw: String): String = raw.trim().replace("-", "_").lowercase()

    fun hasText(key: String): Boolean = textValues[key]?.trim()?.isNotEmpty() == true

    fun isFilled(field: AskFormField): Boolean = when (normalized(field.type)) {
        "toggle", "boolean", "bool", "checkbox" -> true
        "select", "radio" -> if (field.options.isEmpty()) hasText(field.key) else !singleSelect[field.key].isNullOrBlank()
        "multiselect", "multi_select", "checkboxes", "tags" ->
            if (field.options.isEmpty()) hasText(field.key) else multiSelect[field.key]?.isNotEmpty() == true
        else -> hasText(field.key)
    }

    val canSubmit = request.fields.all { !it.required || isFilled(it) }

    HitlQuestionPanel(
        title = request.title,
        modifier = modifier,
        content = {
            request.fields.forEach { field ->
                AskFormFieldView(
                    field = field,
                    attemptedSubmit = attemptedSubmit,
                    textValue = textValues[field.key].orEmpty(),
                    onTextValue = { textValues[field.key] = it },
                    toggleValue = toggleValues[field.key] ?: false,
                    onToggleValue = { toggleValues[field.key] = it },
                    selectedSingle = singleSelect[field.key].orEmpty(),
                    onSingleSelected = { optionId ->
                        singleSelect[field.key] = if (singleSelect[field.key] == optionId) "" else optionId
                    },
                    selectedMultiple = multiSelect[field.key].orEmpty(),
                    onMultiToggle = { optionId ->
                        val current = multiSelect.getOrPut(field.key) { mutableSetOf() }
                        if (current.contains(optionId)) current.remove(optionId) else current.add(optionId)
                    },
                    isFilled = isFilled(field),
                )
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
                    attemptedSubmit = true
                    if (!isSubmitting && canSubmit) {
                        onSubmit(buildAskFormValues(request, textValues, toggleValues, singleSelect, multiSelect))
                    }
                },
                enabled = !isSubmitting,
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
                    Text(request.submitLabel ?: stringResource(R.string.chat_ask_form_submit), style = TTFonts.captionSemibold)
                }
            }
        },
    )
}

@Composable
private fun AskFormFieldView(
    field: AskFormField,
    attemptedSubmit: Boolean,
    textValue: String,
    onTextValue: (String) -> Unit,
    toggleValue: Boolean,
    onToggleValue: (Boolean) -> Unit,
    selectedSingle: String,
    onSingleSelected: (String) -> Unit,
    selectedMultiple: Set<String>,
    onMultiToggle: (String) -> Unit,
    isFilled: Boolean,
) {
    val normalizedType = field.type.trim().replace("-", "_").lowercase()
    val showRequiredError = attemptedSubmit && field.required && !isFilled

    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                field.label,
                style = TTFonts.captionSemibold,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
            )
            if (field.required) {
                Text(
                    " *",
                    style = TTFonts.captionSemibold,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }
        }
        field.description?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        }

        when (normalizedType) {
            "toggle", "boolean", "bool", "checkbox" -> {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        field.placeholder ?: field.label,
                        style = TTFonts.caption,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        modifier = Modifier.weight(1f),
                    )
                    Switch(checked = toggleValue, onCheckedChange = onToggleValue)
                }
            }
            "select", "radio" -> {
                if (field.options.isEmpty()) {
                    AskFormTextInput(field, textValue, onTextValue, singleLine = true)
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                        field.options.forEach { option ->
                            AskFormOptionRow(
                                selected = selectedSingle == option.id,
                                multiple = false,
                                label = option.label,
                                description = option.description,
                                onClick = { onSingleSelected(option.id) },
                            )
                        }
                    }
                }
            }
            "multiselect", "multi_select", "checkboxes", "tags" -> {
                if (field.options.isEmpty()) {
                    AskFormTextInput(
                        field = field,
                        value = textValue,
                        onValue = onTextValue,
                        singleLine = true,
                        placeholderSuffix = stringResource(R.string.chat_ask_form_comma_suffix),
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                        field.options.forEach { option ->
                            AskFormOptionRow(
                                selected = option.id in selectedMultiple,
                                multiple = true,
                                label = option.label,
                                description = option.description,
                                onClick = { onMultiToggle(option.id) },
                            )
                        }
                    }
                }
            }
            "textarea", "long_text" -> AskFormTextInput(field, textValue, onTextValue, singleLine = false)
            "number", "integer", "float" -> AskFormTextInput(
                field = field,
                value = textValue,
                onValue = onTextValue,
                singleLine = true,
                keyboardType = KeyboardType.Decimal,
            )
            else -> AskFormTextInput(field, textValue, onTextValue, singleLine = true)
        }

        if (showRequiredError) {
            Text(
                stringResource(R.string.chat_ask_form_required),
                style = TTFonts.caption,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
            )
        }
    }
}

@Composable
private fun AskFormTextInput(
    field: AskFormField,
    value: String,
    onValue: (String) -> Unit,
    singleLine: Boolean,
    placeholderSuffix: String = "",
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        placeholder = {
            Text(
                (field.placeholder ?: "") + placeholderSuffix,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            )
        },
        modifier = Modifier.fillMaxWidth(),
        textStyle = TTFonts.caption,
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 3,
        maxLines = if (singleLine) 1 else 8,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
    )
}

@Composable
private fun AskFormOptionRow(
    selected: Boolean,
    multiple: Boolean,
    label: String,
    description: String?,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(TTRadius.Shapes.sm)
            .background(
                if (selected) ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.08f)
                else Color.Transparent,
            )
            .border(
                1.dp,
                if (selected) ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = 0.3f)
                else ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight),
                TTRadius.Shapes.sm,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (multiple) {
                if (selected) Icons.Default.CheckBox else Icons.Default.CheckBoxOutlineBlank
            } else {
                if (selected) Icons.Default.RadioButtonChecked else Icons.Default.RadioButtonUnchecked
            },
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = if (selected) ttColor(TTColors.Primary, TTColors.Dark.Primary)
            else ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = TTFonts.caption, color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary))
            description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = TTFonts.caption, color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary))
            }
        }
    }
}

private fun buildAskFormValues(
    request: AskFormRequest,
    textValues: Map<String, String>,
    toggleValues: Map<String, Boolean>,
    singleSelect: Map<String, String>,
    multiSelect: Map<String, Set<String>>,
): JsonObject = buildJsonObject {
    request.fields.forEach { field ->
        when (field.type.trim().replace("-", "_").lowercase()) {
            "toggle", "boolean", "bool", "checkbox" -> put(field.key, toggleValues[field.key] ?: false)
            "select", "radio" -> {
                if (field.options.isEmpty()) {
                    addTextValue(field.key, textValues[field.key])
                } else {
                    singleSelect[field.key]?.takeIf { it.isNotBlank() }?.let { put(field.key, it) }
                }
            }
            "multiselect", "multi_select", "checkboxes", "tags" -> {
                if (field.options.isEmpty()) {
                    addDelimitedValues(field.key, textValues[field.key])
                } else {
                    val values = multiSelect[field.key].orEmpty().sorted()
                    if (values.isNotEmpty()) {
                        put(field.key, buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
                    }
                }
            }
            "number", "integer", "float" -> addNumberValue(field.key, textValues[field.key])
            else -> addTextValue(field.key, textValues[field.key])
        }
    }
}

private fun kotlinx.serialization.json.JsonObjectBuilder.addTextValue(key: String, raw: String?) {
    raw?.trim()?.takeIf { it.isNotEmpty() }?.let { put(key, it) }
}

private fun kotlinx.serialization.json.JsonObjectBuilder.addDelimitedValues(key: String, raw: String?) {
    val values = raw.orEmpty()
        .split(',', '，', '\n')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
    if (values.isNotEmpty()) {
        put(key, buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
    }
}

private fun kotlinx.serialization.json.JsonObjectBuilder.addNumberValue(key: String, raw: String?) {
    val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return
    val number = value.toDoubleOrNull()
    if (number == null) {
        put(key, value)
    } else if (number % 1.0 == 0.0) {
        put(key, number.toLong())
    } else {
        put(key, number)
    }
}
