package com.tabtin.mobile.features.doc

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Description
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
public fun DocListScreen(
    viewModel: DocListViewModel,
    onDocClick: (Doc) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val state by viewModel.uiState.collectAsState()
    var docToDelete by remember { mutableStateOf<Doc?>(null) }
    val snackbarHostState = remember { SnackbarHostState() }

    val snackbarMsg = state.snackbarRes?.let { stringResource(it) }
    LaunchedEffect(snackbarMsg) {
        val msg = snackbarMsg ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(msg)
        viewModel.consumeSnackbar()
    }

    state.createDocumentQuotaExceeded?.let { quotaExceeded ->
        DocumentQuotaExceededDialog(
            error = quotaExceeded,
            onDismiss = viewModel::dismissCreateDocumentQuotaExceeded,
        )
    }

    docToDelete?.let { doc ->
        AlertDialog(
            onDismissRequest = { docToDelete = null },
            title = { Text(stringResource(R.string.doc_delete_title)) },
            text = { Text(stringResource(R.string.doc_delete_message, doc.trimmedTitle.ifEmpty { stringResource(R.string.doc_untitled) })) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.deleteDocument(doc.id)
                    docToDelete = null
                }) {
                    Text(stringResource(R.string.doc_delete_confirm), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { docToDelete = null }) {
                    Text(stringResource(R.string.doc_delete_cancel))
                }
            },
        )
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            if (onBack != null) {
                TopAppBar(
                    title = { Text(stringResource(R.string.doc_list_title)) },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                        }
                    },
                )
            }
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { viewModel.createDocument() },
                containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            ) {
                if (state.isCreating) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                        strokeWidth = 2.dp,
                    )
                } else {
                    Icon(
                        Icons.Default.Add,
                        contentDescription = stringResource(R.string.doc_list_create),
                        tint = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.isLoading && state.documents.isEmpty() -> {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }
                state.errorRes != null && state.documents.isEmpty() -> {
                    Column(
                        modifier = Modifier.align(Alignment.Center).padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            stringResource(state.errorRes ?: R.string.doc_error_unknown),
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Spacer(Modifier.height(12.dp))
                        Button(onClick = { viewModel.refresh() }) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
                state.documents.isEmpty() -> {
                    Column(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Default.Description,
                            contentDescription = null,
                            modifier = Modifier.size(48.dp),
                            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        )
                        Spacer(Modifier.height(12.dp))
                        Text(
                            stringResource(R.string.doc_list_empty),
                            style = MaterialTheme.typography.bodyLarge,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                    }
                }
                else -> {
                    PullToRefreshBox(
                        isRefreshing = state.isLoading,
                        onRefresh = { viewModel.refresh() },
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        LazyColumn(Modifier.fillMaxSize()) {
                            items(state.documents, key = { it.id }) { doc ->
                                DocRow(
                                    doc = doc,
                                    onClick = { onDocClick(doc) },
                                    onLongClick = { docToDelete = doc },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DocRow(doc: Doc, onClick: () -> Unit, onLongClick: () -> Unit = {}) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(vertical = 8.dp),
        ) {
            Icon(
                Icons.Default.Description,
                contentDescription = null,
                modifier = Modifier.size(32.dp),
                tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = doc.trimmedTitle.ifEmpty { stringResource(R.string.doc_untitled) },
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                doc.displayTime?.let { time ->
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = time,
                        style = MaterialTheme.typography.bodySmall,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
            }
        }
    }
}
