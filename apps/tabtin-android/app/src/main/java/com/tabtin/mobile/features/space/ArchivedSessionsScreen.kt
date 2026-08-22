package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.repository.ChatRepository
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject

public data class ArchivedSessionsUiState(
    val sessions: List<ChatSession> = emptyList(),
    val isLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    @StringRes val errorRes: Int? = null,
    @StringRes val toastRes: Int? = null,
    val restoringIds: Set<String> = emptySet(),
)

@HiltViewModel
public class ArchivedSessionsViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val chatRepository: ChatRepository,
    private val spaceRepository: SpaceRepository,
) : ViewModel() {

    public val spaceId: String = savedStateHandle["spaceId"] ?: ""

    private val _uiState = MutableStateFlow(ArchivedSessionsUiState())
    public val uiState: StateFlow<ArchivedSessionsUiState> = _uiState.asStateFlow()

    init { load() }

    public fun load() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(isLoading = false, isRefreshing = false, errorRes = ErrorClassifier.classify(e)) }
            }
        ) {
            _uiState.update { it.copy(isLoading = it.sessions.isEmpty(), isRefreshing = it.sessions.isNotEmpty(), errorRes = null) }
            val sessions = chatRepository.getArchivedSessions(spaceRepository.getSpace(spaceId))
            _uiState.update { it.copy(sessions = sessions, isLoading = false, isRefreshing = false) }
        }
    }

    public fun refresh(): Unit = load()

    public fun restoreSession(sessionId: String) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(restoringIds = it.restoringIds - sessionId, toastRes = ErrorClassifier.classify(e)) }
            }
        ) {
            _uiState.update { it.copy(restoringIds = it.restoringIds + sessionId) }
            chatRepository.restoreSession(sessionId)
            _uiState.update {
                it.copy(
                    sessions = it.sessions.filter { s -> s.id != sessionId },
                    restoringIds = it.restoringIds - sessionId,
                    toastRes = R.string.archived_session_restored,
                )
            }
        }
    }

    public fun deleteSession(sessionId: String) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(toastRes = ErrorClassifier.classify(e)) }
            }
        ) {
            chatRepository.deleteSession(sessionId)
            _uiState.update { it.copy(sessions = it.sessions.filter { s -> s.id != sessionId }) }
        }
    }

    public fun consumeToast() { _uiState.update { it.copy(toastRes = null) } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun ArchivedSessionsScreen(
    viewModel: ArchivedSessionsViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current
    var deleteTarget by remember { mutableStateOf<ChatSession?>(null) }

    LaunchedEffect(state.toastRes) {
        state.toastRes?.let { res ->
            snackbar.showSnackbar(context.getString(res))
            viewModel.consumeToast()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
                title = { Text(stringResource(R.string.archived_sessions_title)) },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        when {
            state.isLoading && state.sessions.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            state.errorRes != null && state.sessions.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(state.errorRes!!), color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary))
                        Spacer(Modifier.height(8.dp))
                        TextButton(onClick = { viewModel.load() }) { Text(stringResource(R.string.common_retry)) }
                    }
                }
            }
            state.sessions.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("📦", style = MaterialTheme.typography.displayMedium)
                        Spacer(Modifier.height(12.dp))
                        Text(stringResource(R.string.archived_sessions_empty), color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary))
                        Spacer(Modifier.height(4.dp))
                        Text(
                            stringResource(R.string.archived_sessions_desc),
                            style = MaterialTheme.typography.bodySmall,
                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                        )
                    }
                }
            }
            else -> {
                PullToRefreshBox(
                    isRefreshing = state.isRefreshing,
                    onRefresh = { viewModel.refresh() },
                    modifier = Modifier.fillMaxSize().padding(padding),
                ) {
                    LazyColumn(Modifier.fillMaxSize()) {
                        item {
                            Text(
                                stringResource(R.string.archived_sessions_desc),
                                style = MaterialTheme.typography.bodySmall,
                                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                            )
                        }
                        items(state.sessions, key = { it.id }) { session ->
                            SessionRow(
                                session = session,
                                isRestoring = session.id in state.restoringIds,
                                onRestore = { viewModel.restoreSession(session.id) },
                                onDelete = { deleteTarget = session },
                            )
                        }
                    }
                }
            }
        }
    }

    deleteTarget?.let { session ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text(stringResource(R.string.archived_session_delete_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.deleteSession(session.id)
                    deleteTarget = null
                }) {
                    Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }
}

@Composable
private fun SessionRow(
    session: ChatSession,
    isRestoring: Boolean,
    onRestore: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = session.title ?: stringResource(R.string.archived_session_untitled),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                val time = session.updatedAt?.take(16)?.replace("T", " ")
                if (!time.isNullOrEmpty()) {
                    Text(
                        text = time,
                        style = MaterialTheme.typography.labelSmall,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
                val count = session.messageCount ?: 0
                if (count > 0) {
                    if (!time.isNullOrEmpty()) {
                        Text("·", style = MaterialTheme.typography.labelSmall, color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary))
                    }
                    Text(
                        text = stringResource(R.string.archived_session_message_count, count),
                        style = MaterialTheme.typography.labelSmall,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
            }
        }
        if (isRestoring) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        } else {
            IconButton(onClick = onRestore) {
                Icon(Icons.Default.Restore, contentDescription = stringResource(R.string.archived_session_restore), tint = ttColor(TTColors.Primary, TTColors.Dark.Primary))
            }
        }
        IconButton(onClick = onDelete) {
            Icon(Icons.Default.Delete, contentDescription = stringResource(R.string.common_delete), tint = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical))
        }
    }
    HorizontalDivider(modifier = Modifier.padding(start = 16.dp))
}
