package com.tabtin.mobile.features.doc.editor.interaction

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.rememberTTSheetState

public data class CodeLanguageOption(
    val key: String,
    val labelRes: Int,
)

private val LANGUAGE_ALIASES = mapOf(
    "js" to "javascript",
    "ts" to "typescript",
    "bash" to "shell",
    "sh" to "shell",
    "zsh" to "shell",
    "c++" to "cpp",
    "c#" to "csharp",
    "objectivec" to "c",
    "objc" to "c",
    "yml" to "yaml",
    "md" to "markdown",
    "rb" to "ruby",
)

public fun normalizeLanguageKey(lang: String): String = LANGUAGE_ALIASES[lang.lowercase()] ?: lang.lowercase()

public val CODE_LANGUAGES: List<CodeLanguageOption> = listOf(
    CodeLanguageOption("", R.string.doc_code_language_plain),
    CodeLanguageOption("javascript", R.string.doc_code_lang_javascript),
    CodeLanguageOption("typescript", R.string.doc_code_lang_typescript),
    CodeLanguageOption("python", R.string.doc_code_lang_python),
    CodeLanguageOption("java", R.string.doc_code_lang_java),
    CodeLanguageOption("kotlin", R.string.doc_code_lang_kotlin),
    CodeLanguageOption("swift", R.string.doc_code_lang_swift),
    CodeLanguageOption("go", R.string.doc_code_lang_go),
    CodeLanguageOption("rust", R.string.doc_code_lang_rust),
    CodeLanguageOption("c", R.string.doc_code_lang_c),
    CodeLanguageOption("cpp", R.string.doc_code_lang_cpp),
    CodeLanguageOption("csharp", R.string.doc_code_lang_csharp),
    CodeLanguageOption("html", R.string.doc_code_lang_html),
    CodeLanguageOption("css", R.string.doc_code_lang_css),
    CodeLanguageOption("sql", R.string.doc_code_lang_sql),
    CodeLanguageOption("shell", R.string.doc_code_lang_shell),
    CodeLanguageOption("json", R.string.doc_code_lang_json),
    CodeLanguageOption("yaml", R.string.doc_code_lang_yaml),
    CodeLanguageOption("xml", R.string.doc_code_lang_xml),
    CodeLanguageOption("markdown", R.string.doc_code_lang_markdown),
    CodeLanguageOption("ruby", R.string.doc_code_lang_ruby),
    CodeLanguageOption("php", R.string.doc_code_lang_php),
    CodeLanguageOption("dart", R.string.doc_code_lang_dart),
    CodeLanguageOption("r", R.string.doc_code_lang_r),
    CodeLanguageOption("scala", R.string.doc_code_lang_scala),
    CodeLanguageOption("lua", R.string.doc_code_lang_lua),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CodeLanguageSelectorSheet(
    currentLanguage: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberTTSheetState()

    val normalized = normalizeLanguageKey(currentLanguage)
    val knownMatch = CODE_LANGUAGES.any { it.key == normalized }

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 24.dp),
        ) {
            Text(
                text = stringResource(R.string.doc_code_language_title),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
            HorizontalDivider()
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                if (!knownMatch && currentLanguage.isNotBlank()) {
                    LanguageRow(
                        label = currentLanguage,
                        isCurrent = true,
                        onClick = {},
                    )
                }
                CODE_LANGUAGES.forEach { option ->
                    val isCurrent = option.key == normalized
                    LanguageRow(
                        label = stringResource(option.labelRes),
                        isCurrent = isCurrent,
                        onClick = { onSelect(option.key) },
                    )
                }
            }
        }
    }
}

@Composable
private fun LanguageRow(
    label: String,
    isCurrent: Boolean,
    onClick: () -> Unit,
) {
    val textColor = if (isCurrent) MaterialTheme.colorScheme.primary
        else MaterialTheme.colorScheme.onSurface
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (isCurrent) Modifier else Modifier.clickable(onClick = onClick))
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = textColor,
            modifier = Modifier.weight(1f),
        )
        if (isCurrent) {
            Icon(
                Icons.Filled.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}
