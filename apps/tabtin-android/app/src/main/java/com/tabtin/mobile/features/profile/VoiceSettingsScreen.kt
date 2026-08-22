package com.tabtin.mobile.features.profile

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

private val Context.voicePrefsStore by preferencesDataStore("voice_settings")

private object VoicePrefKeys {
    val ENABLED = booleanPreferencesKey("voice_enabled")
    val HOTWORDS = stringPreferencesKey("hotwords")
    val AUTO_PUNCTUATION = booleanPreferencesKey("auto_punctuation")
    val NOISE_SUPPRESSION = booleanPreferencesKey("noise_suppression")
}

public data class VoiceSettingsState(
    val enabled: Boolean = true,
    val hotwords: List<String> = emptyList(),
    val autoPunctuation: Boolean = true,
    val noiseSuppression: Boolean = true,
    val newHotword: String = "",
)

@HiltViewModel
public class VoiceSettingsViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
) : ViewModel() {

    private val _state = MutableStateFlow(VoiceSettingsState())
    public val state: StateFlow<VoiceSettingsState> = _state.asStateFlow()

    init { load() }

    private fun load() {
        viewModelScope.launch {
            val prefs = context.voicePrefsStore.data.first()
            val hotwordStr = prefs[VoicePrefKeys.HOTWORDS] ?: ""
            _state.value = VoiceSettingsState(
                enabled = prefs[VoicePrefKeys.ENABLED] ?: true,
                hotwords = if (hotwordStr.isBlank()) emptyList() else hotwordStr.split(","),
                autoPunctuation = prefs[VoicePrefKeys.AUTO_PUNCTUATION] ?: true,
                noiseSuppression = prefs[VoicePrefKeys.NOISE_SUPPRESSION] ?: true,
            )
        }
    }

    public fun setEnabled(v: Boolean) {
        _state.value = _state.value.copy(enabled = v)
        save()
    }

    public fun setAutoPunctuation(v: Boolean) {
        _state.value = _state.value.copy(autoPunctuation = v)
        save()
    }

    public fun setNoiseSuppression(v: Boolean) {
        _state.value = _state.value.copy(noiseSuppression = v)
        save()
    }

    public fun setNewHotword(v: String) {
        _state.value = _state.value.copy(newHotword = v)
    }

    public fun addHotword() {
        val word = _state.value.newHotword.trim()
        if (word.isBlank() || word in _state.value.hotwords) return
        _state.value = _state.value.copy(
            hotwords = _state.value.hotwords + word,
            newHotword = "",
        )
        save()
    }

    public fun removeHotword(word: String) {
        _state.value = _state.value.copy(hotwords = _state.value.hotwords - word)
        save()
    }

    private fun save() {
        viewModelScope.launch {
            context.voicePrefsStore.edit { prefs ->
                prefs[VoicePrefKeys.ENABLED] = _state.value.enabled
                prefs[VoicePrefKeys.HOTWORDS] = _state.value.hotwords.joinToString(",")
                prefs[VoicePrefKeys.AUTO_PUNCTUATION] = _state.value.autoPunctuation
                prefs[VoicePrefKeys.NOISE_SUPPRESSION] = _state.value.noiseSuppression
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun VoiceSettingsScreen(
    viewModel: VoiceSettingsViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.voice_settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.xl),
        ) {
            Spacer(Modifier.height(TTSpacing.md))

            Text(
                stringResource(R.string.voice_settings_desc),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(TTSpacing.xl))

            ToggleRow(
                title = stringResource(R.string.voice_enable),
                subtitle = stringResource(R.string.voice_enable_desc),
                checked = state.enabled,
                onCheckedChange = viewModel::setEnabled,
            )

            if (state.enabled) {
                Spacer(Modifier.height(TTSpacing.xl))

                Text(
                    stringResource(R.string.voice_hotwords_title),
                    style = MaterialTheme.typography.titleSmall,
                )

                Spacer(Modifier.height(TTSpacing.sm))

                Text(
                    stringResource(R.string.voice_hotwords_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(TTSpacing.md))

                state.hotwords.forEach { word ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 2.dp),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(word, modifier = Modifier.weight(1f))
                            IconButton(onClick = { viewModel.removeHotword(word) }) {
                                Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    OutlinedTextField(
                        value = state.newHotword,
                        onValueChange = viewModel::setNewHotword,
                        placeholder = { Text(stringResource(R.string.voice_hotword_placeholder)) },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        onClick = viewModel::addHotword,
                        enabled = state.newHotword.isNotBlank(),
                    ) {
                        Icon(Icons.Default.Add, contentDescription = null)
                    }
                }

                Spacer(Modifier.height(TTSpacing.xl))

                ToggleRow(
                    title = stringResource(R.string.voice_auto_punctuation),
                    subtitle = stringResource(R.string.voice_auto_punctuation_desc),
                    checked = state.autoPunctuation,
                    onCheckedChange = viewModel::setAutoPunctuation,
                )

                ToggleRow(
                    title = stringResource(R.string.voice_noise_suppression),
                    subtitle = stringResource(R.string.voice_noise_suppression_desc),
                    checked = state.noiseSuppression,
                    onCheckedChange = viewModel::setNoiseSuppression,
                )
            }

            Spacer(Modifier.height(TTSpacing.xxl))
        }
    }
}

@Composable
private fun ToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
