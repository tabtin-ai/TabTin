package com.tabtin.mobile.features.tracker

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.tracker.StepRunInfo
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun CheckpointSheet(
    stepRun: StepRunInfo,
    trackerName: String,
    onDismiss: () -> Unit,
) {
    val viewModel: CheckpointViewModel = hiltViewModel()
    val sheetState = rememberTTSheetState()
    val scope = rememberCoroutineScope()

    var userInput by remember { mutableStateOf("") }
    var isSubmitting by remember { mutableStateOf(false) }
    var showAbortConfirm by remember { mutableStateOf(false) }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    val hasInput = userInput.isNotBlank()

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        TTSheetColumn(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.tracker_checkpoint_title),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, stringResource(R.string.common_close))
                }
            }

            Spacer(Modifier.height(12.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("✋", style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.width(8.dp))
                Column {
                    Text(
                        trackerName,
                        style = MaterialTheme.typography.bodyLarge,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    )
                    Text(
                        stepRun.stepName,
                        style = MaterialTheme.typography.bodySmall,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    )
                }
            }

            Text(
                stepRun.capability,
                style = MaterialTheme.typography.labelSmall,
                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                modifier = Modifier.padding(top = 4.dp),
            )

            if (stepRun.checkpointPrompt.isNotEmpty()) {
                Spacer(Modifier.height(16.dp))
                Text(
                    stepRun.checkpointPrompt,
                    style = MaterialTheme.typography.bodyMedium,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                        .padding(12.dp),
                )
            }

            if (stepRun.outputSummary.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    stepRun.outputSummary,
                    style = MaterialTheme.typography.bodySmall,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                    maxLines = 5,
                )
            }

            Spacer(Modifier.height(16.dp))
            Text(
                stringResource(R.string.tracker_checkpoint_provide),
                style = MaterialTheme.typography.labelMedium,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = userInput,
                onValueChange = { userInput = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(120.dp),
                placeholder = {
                    Text(
                        stringResource(R.string.tracker_checkpoint_input_placeholder),
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                },
            )

            if (errorMsg != null) {
                Spacer(Modifier.height(8.dp))
                Text(
                    errorMsg!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                )
            }

            Spacer(Modifier.height(16.dp))

            Button(
                onClick = {
                    scope.launch {
                        isSubmitting = true
                        errorMsg = null
                        try {
                            if (hasInput) {
                                viewModel.provide(stepRun.id, userInput.trim())
                            } else {
                                viewModel.continueCheckpoint(stepRun.id)
                            }
                            onDismiss()
                        } catch (e: Exception) {
                            errorMsg = e.message
                        } finally {
                            isSubmitting = false
                        }
                    }
                },
                enabled = !isSubmitting,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                ),
            ) {
                if (isSubmitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    if (hasInput) stringResource(R.string.tracker_checkpoint_provide)
                    else stringResource(R.string.tracker_checkpoint_continue),
                )
            }

            Spacer(Modifier.height(8.dp))

            Button(
                onClick = { showAbortConfirm = true },
                enabled = !isSubmitting,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical).copy(alpha = 0.08f),
                    contentColor = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                ),
            ) {
                Text(stringResource(R.string.tracker_checkpoint_abort))
            }

            Spacer(Modifier.height(24.dp))
        }
    }

    if (showAbortConfirm) {
        AlertDialog(
            onDismissRequest = { showAbortConfirm = false },
            title = { Text(stringResource(R.string.tracker_checkpoint_abort)) },
            text = { Text(stringResource(R.string.tracker_checkpoint_abort_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    showAbortConfirm = false
                    scope.launch {
                        isSubmitting = true
                        try {
                            viewModel.abort(stepRun.id)
                            onDismiss()
                        } catch (e: Exception) {
                            errorMsg = e.message
                        } finally {
                            isSubmitting = false
                        }
                    }
                }) {
                    Text(
                        stringResource(R.string.tracker_checkpoint_abort),
                        color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showAbortConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}
