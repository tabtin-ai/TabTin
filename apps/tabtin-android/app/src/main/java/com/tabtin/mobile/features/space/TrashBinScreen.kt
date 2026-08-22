package com.tabtin.mobile.features.space

import androidx.annotation.StringRes
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DeleteForever
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
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.ErrorClassifier
import com.tabtin.mobile.util.safeLaunch
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject

@Serializable
public data class TrashedItem(
    val id: String,
    val title: String = "",
    @SerialName("item_type") val itemType: String = "",
    @SerialName("resource_id") val resourceId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("trashed_at") val trashedAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("days_left") val daysLeft: Int = 30,
) {
    val displayTime: String?
        get() = (trashedAt ?: updatedAt)?.take(16)?.replace("T", " ")

    @get:StringRes
    val typeLabelRes: Int?
        get() = when (itemType) {
            "tabdoc", "document" -> R.string.trash_type_document
            "tabdata", "table" -> R.string.trash_type_table
            "tabslide", "slide", "ppt" -> R.string.trash_type_slide
            "tabmemo", "memo" -> R.string.trash_type_memo
            "tabsite", "site" -> R.string.trash_type_site
            "tabvideo", "video" -> R.string.trash_type_video
            "tabcode", "code" -> R.string.trash_type_code
            "tabwhiteboard", "canvas" -> R.string.trash_type_whiteboard
            else -> null
        }

    val emoji: String
        get() = when (itemType) {
            "tabdoc", "document" -> "📄"
            "tabdata", "table" -> "📊"
            "tabslide", "slide", "ppt" -> "📑"
            "design" -> "🎨"
            "tabmemo", "memo" -> "📝"
            "tabsite", "site" -> "🌐"
            "tabvideo", "video" -> "🎬"
            "tabcode", "code" -> "💻"
            "tabwhiteboard", "canvas" -> "🖼️"
            else -> "📁"
        }
}

@Serializable
public data class TrashedItemsResponse(
    val items: List<TrashedItem> = emptyList(),
)

public data class TrashBinUiState(
    val items: List<TrashedItem> = emptyList(),
    val isLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    @StringRes val errorRes: Int? = null,
    @StringRes val toastRes: Int? = null,
    val restoringIds: Set<String> = emptySet(),
    val isEmptying: Boolean = false,
)

@HiltViewModel
public class TrashBinViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val contextApi: ContextApi,
) : ViewModel() {

    public val organizationId: String = savedStateHandle["organizationId"] ?: ""

    private val _uiState = MutableStateFlow(TrashBinUiState())
    public val uiState: StateFlow<TrashBinUiState> = _uiState.asStateFlow()

    init { load() }

    public fun load() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(isLoading = false, isRefreshing = false, errorRes = ErrorClassifier.classify(e)) }
            }
        ) {
            _uiState.update { it.copy(isLoading = it.items.isEmpty(), isRefreshing = it.items.isNotEmpty(), errorRes = null) }
            val response = contextApi.getOrganizationTrashItems(organizationId)
            val items = response.unwrap().items.sortedByDescending { it.trashedAt ?: it.updatedAt ?: "" }
            _uiState.update { it.copy(items = items, isLoading = false, isRefreshing = false) }
        }
    }

    public fun refresh(): Unit = load()

    public fun restoreItem(item: TrashedItem) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(restoringIds = it.restoringIds - item.id, toastRes = ErrorClassifier.classify(e)) }
            }
        ) {
            _uiState.update { it.copy(restoringIds = it.restoringIds + item.id) }
            contextApi.postTrashResourceAction(item.restorePath(organizationId))
            _uiState.update {
                it.copy(
                    items = it.items.filter { i -> i.id != item.id },
                    restoringIds = it.restoringIds - item.id,
                    toastRes = R.string.trash_restored,
                )
            }
        }
    }

    public fun permanentDelete(item: TrashedItem) {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(toastRes = ErrorClassifier.classify(e)) }
            }
        ) {
            contextApi.deleteTrashResourceAction(item.permanentDeletePath(organizationId))
            _uiState.update { it.copy(items = it.items.filter { i -> i.id != item.id }) }
        }
    }

    public fun emptyTrash() {
        viewModelScope.safeLaunch(
            onError = { e ->
                _uiState.update { it.copy(isEmptying = false, toastRes = ErrorClassifier.classify(e)) }
            }
        ) {
            _uiState.update { it.copy(isEmptying = true) }
            contextApi.emptyOrganizationTrash(organizationId)
            _uiState.update { it.copy(items = emptyList(), isEmptying = false) }
        }
    }

    public fun consumeToast() { _uiState.update { it.copy(toastRes = null) } }
}

/**
 * 组织回收站是 ContextItem 的聚合入口；具体资源仍必须走各模块的恢复/永久删除
 * 接口，不能再调用已退役的 /context/spaces/.../trash/{type}/{id} 通用路径。
 */
private fun TrashedItem.restorePath(organizationId: String): String {
    val resourceId = resourceId ?: id
    return trashActionPath(organizationId, resourceId, "restore-from-trash")
}

private fun TrashedItem.permanentDeletePath(organizationId: String): String {
    val resourceId = resourceId ?: id
    return trashActionPath(organizationId, resourceId, "permanent")
}

private fun TrashedItem.trashActionPath(
    organizationId: String,
    resourceId: String,
    action: String,
): String = when (itemType) {
    "tabdoc", "document" -> "tabdoc/documents/$resourceId/$action"
    "tabdata", "table" -> "tabdata/tables/$resourceId/$action"
    "tabslide", "slide", "ppt" -> "tabslide/projects/$resourceId/$action/"
    "tabvideo", "video" -> "tabvideo/projects/$resourceId/$action/"
    "tabwhiteboard", "canvas" -> "tabwhiteboard/canvases/$resourceId/$action/"
    "tabmemo", "memo" -> "tabmemo/memos/$resourceId/$action/"
    "tabfiles", "file" -> "context/organizations/$organizationId/files/$resourceId/${if (action == "restore-from-trash") "restore" else action}"
    "tabcode", "code" -> "tabcode/spaces/${requireNotNull(spaceId) { "code resource is missing its host" }}/code-projects/$resourceId/$action/"
    else -> error("Unsupported trashed resource type: $itemType")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TrashBinScreen(
    viewModel: TrashBinViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current
    var deleteTarget by remember { mutableStateOf<TrashedItem?>(null) }
    var showEmptyConfirm by remember { mutableStateOf(false) }

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
                title = { Text(stringResource(R.string.trash_title)) },
                actions = {
                    if (state.items.isNotEmpty()) {
                        TextButton(
                            onClick = { showEmptyConfirm = true },
                            enabled = !state.isEmptying,
                        ) {
                            Text(
                                stringResource(R.string.trash_empty_all),
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        when {
            state.isLoading && state.items.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            state.errorRes != null && state.items.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(state.errorRes!!), color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary))
                        Spacer(Modifier.height(8.dp))
                        TextButton(onClick = { viewModel.load() }) { Text(stringResource(R.string.common_retry)) }
                    }
                }
            }
            state.items.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("🗑️", style = MaterialTheme.typography.displayMedium)
                        Spacer(Modifier.height(12.dp))
                        Text(stringResource(R.string.trash_empty), color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary))
                        Spacer(Modifier.height(4.dp))
                        Text(
                            stringResource(R.string.trash_desc),
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
                                stringResource(R.string.trash_desc),
                                style = MaterialTheme.typography.bodySmall,
                                color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                            )
                        }
                        items(state.items, key = { it.id }) { item ->
                            TrashItemRow(
                                item = item,
                                isRestoring = item.id in state.restoringIds,
                                onRestore = { viewModel.restoreItem(item) },
                                onDelete = { deleteTarget = item },
                            )
                        }
                    }
                }
            }
        }
    }

    deleteTarget?.let { item ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text(stringResource(R.string.trash_permanent_delete_confirm)) },
            text = { Text(stringResource(R.string.trash_permanent_delete_warning)) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.permanentDelete(item)
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

    if (showEmptyConfirm) {
        AlertDialog(
            onDismissRequest = { showEmptyConfirm = false },
            title = { Text(stringResource(R.string.trash_empty_confirm_title)) },
            text = { Text(stringResource(R.string.trash_empty_confirm_message, state.items.size)) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.emptyTrash()
                    showEmptyConfirm = false
                }) {
                    Text(stringResource(R.string.trash_empty_all), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { showEmptyConfirm = false }) { Text(stringResource(R.string.common_cancel)) }
            },
        )
    }
}

@Composable
private fun TrashItemRow(
    item: TrashedItem,
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
        Text(item.emoji, style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.padding(start = 12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = item.title.ifEmpty { stringResource(R.string.trash_untitled) },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    item.typeLabelRes?.let { stringResource(it) } ?: item.itemType,
                    style = MaterialTheme.typography.labelSmall,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
                item.displayTime?.let { time ->
                    Text("·", style = MaterialTheme.typography.labelSmall, color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary))
                    Text(time, style = MaterialTheme.typography.labelSmall, color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary))
                }
                if (item.daysLeft > 0) {
                    Text("·", style = MaterialTheme.typography.labelSmall, color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary))
                    Text(
                        stringResource(R.string.trash_days_left, item.daysLeft),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (item.daysLeft <= 7) MaterialTheme.colorScheme.error else ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
            }
        }
        if (isRestoring) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        } else {
            IconButton(onClick = onRestore) {
                Icon(Icons.Default.Restore, contentDescription = stringResource(R.string.trash_restore), tint = ttColor(TTColors.Primary, TTColors.Dark.Primary))
            }
        }
        IconButton(onClick = onDelete) {
            Icon(Icons.Default.DeleteForever, contentDescription = stringResource(R.string.trash_permanent_delete), tint = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical))
        }
    }
    HorizontalDivider(modifier = Modifier.padding(start = 50.dp))
}
