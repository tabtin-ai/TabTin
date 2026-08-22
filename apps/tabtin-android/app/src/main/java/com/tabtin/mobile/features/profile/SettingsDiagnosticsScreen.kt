package com.tabtin.mobile.features.profile

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.diagnostics.DiagnosticRecorder
import com.tabtin.mobile.ui.theme.TTSpacing
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

@HiltViewModel
public class DiagnosticExportViewModel @Inject constructor(
    private val recorder: DiagnosticRecorder,
) : ViewModel() {
    private val _state = MutableStateFlow<DiagnosticExportState>(DiagnosticExportState.Idle)
    public val state: StateFlow<DiagnosticExportState> = _state.asStateFlow()

    public fun export() {
        if (_state.value == DiagnosticExportState.Exporting) return
        viewModelScope.launch {
            _state.value = DiagnosticExportState.Exporting
            _state.value = runCatching { recorder.exportBundle() }
                .fold(
                    onSuccess = DiagnosticExportState::Ready,
                    onFailure = {
                        recorder.recordAppEvent("diagnostics_export_failed", error = it)
                        DiagnosticExportState.Failed(it.javaClass.simpleName)
                    },
                )
        }
    }

    public fun consumeReady() {
        _state.value = DiagnosticExportState.Idle
    }
}

public sealed interface DiagnosticExportState {
    public data object Idle : DiagnosticExportState
    public data object Exporting : DiagnosticExportState
    public data class Ready(public val file: File) : DiagnosticExportState
    public data class Failed(public val errorClass: String) : DiagnosticExportState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun SettingsDiagnosticsScreen(
    onBack: () -> Unit,
    viewModel: DiagnosticExportViewModel = hiltViewModel(),
) {
    val context = LocalContext.current
    val state by viewModel.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state) {
        when (val current = state) {
            is DiagnosticExportState.Ready -> {
                val uri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    current.file,
                )
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "application/zip"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                context.startActivity(Intent.createChooser(intent, context.getString(R.string.settings_diagnostics_share)))
                viewModel.consumeReady()
            }
            is DiagnosticExportState.Failed -> {
                snackbarHostState.showSnackbar(context.getString(R.string.settings_diagnostics_failed))
                viewModel.consumeReady()
            }
            DiagnosticExportState.Idle,
            DiagnosticExportState.Exporting -> Unit
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_diagnostics_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            Text(
                text = stringResource(R.string.settings_diagnostics_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = stringResource(R.string.settings_diagnostics_privacy),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = viewModel::export,
                enabled = state != DiagnosticExportState.Exporting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state == DiagnosticExportState.Exporting) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(end = TTSpacing.sm),
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Icon(Icons.Default.FileDownload, contentDescription = null)
                }
                Text(
                    text = stringResource(
                        if (state == DiagnosticExportState.Exporting) {
                            R.string.settings_diagnostics_exporting
                        } else {
                            R.string.settings_diagnostics_export
                        },
                    ),
                    modifier = Modifier.padding(start = TTSpacing.sm),
                )
            }
        }
    }
}
