package com.tabtin.mobile.features.tabchat

import android.widget.Toast
import androidx.annotation.StringRes
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.CentrifugoClient
import com.tabtin.mobile.data.im.ImConversation
import com.tabtin.mobile.data.im.ExternalContact
import com.tabtin.mobile.data.im.ImConversationStore
import com.tabtin.mobile.data.im.ImConversationLabel
import com.tabtin.mobile.data.im.ImConversationLabelRepository
import com.tabtin.mobile.data.im.ImConversationTitlePolicy
import com.tabtin.mobile.data.im.ImConversationType
import com.tabtin.mobile.data.im.ImMessageSearchResult
import com.tabtin.mobile.data.im.ImMemberDisplayPolicy
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TTFormSheet
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import com.tabtin.mobile.util.RelativeTimeFormatter
import com.tabtin.mobile.util.ErrorClassifier
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import javax.inject.Inject

internal const val IM_SYSTEM_MENTION_LABEL_ID: String = "sys:mention"

internal fun imConversationLabelCatalog(customLabels: List<ImConversationLabel>): List<ImConversationLabel> =
    listOf(
        ImConversationLabel.systemMention,
    ) + customLabels.filterNot { it.id == IM_SYSTEM_MENTION_LABEL_ID }

internal fun imConversationMatchesLabelFilters(
    conversation: ImConversation,
    selectedLabelIds: Set<String>,
): Boolean = selectedLabelIds.isEmpty() ||
    conversation.labels.asSequence().map { it.id }.toSet().containsAll(selectedLabelIds)

private fun imLabelColor(raw: String): Color = runCatching {
    Color(android.graphics.Color.parseColor(raw))
}.getOrDefault(Color(0xFF6B7280))

/** IM 会话列表状态桥接：会话、实时通道、置顶动作都由同一个全局 Store 收敛。 */
@HiltViewModel
public class ImInboxViewModel @Inject constructor(
    private val store: ImConversationStore,
    private val centrifugoClient: CentrifugoClient,
    private val labelRepository: ImConversationLabelRepository,
) : ViewModel() {
    public val conversations: StateFlow<List<ImConversation>> get() = store.conversations
    public val aggregateUnreadCount: StateFlow<Int> get() = store.aggregateUnreadCount
    public val isLoading: StateFlow<Boolean> get() = store.isLoading
    public val loadErrorRes: StateFlow<Int?> get() = store.loadErrorRes
    public val searchResults: StateFlow<List<ImMessageSearchResult>> get() = store.searchResults
    public val isSearching: StateFlow<Boolean> get() = store.isSearching
    public val searchErrorRes: StateFlow<Int?> get() = store.searchErrorRes
    public val pinningConversationIds: StateFlow<Set<String>> get() = store.pinningConversationIds
    public val pinActionError: StateFlow<String?> get() = store.pinActionError
    public val mutingConversationIds: StateFlow<Set<String>> get() = store.mutingConversationIds
    public val muteActionError: StateFlow<String?> get() = store.muteActionError
    public val personalNotice: StateFlow<ImConversationStore.PersonalNotice?> get() = store.personalNotice
    private val _labels = MutableStateFlow<List<ImConversationLabel>>(emptyList())
    public val labels: StateFlow<List<ImConversationLabel>> = _labels.asStateFlow()
    private val _selectedLabelIds = MutableStateFlow<Set<String>>(emptySet())
    public val selectedLabelIds: StateFlow<Set<String>> = _selectedLabelIds.asStateFlow()
    private var labelsOrganizationId: String? = null
    private var labelsLoadGeneration: Int = 0

    /** 初始化或用户重复点按消息 Tab 时都可调用；列表请求会自动替换旧请求。 */
    public fun activate(organizationId: String) {
        if (organizationId.isBlank()) {
            store.clear()
            labelsOrganizationId = null
            labelsLoadGeneration += 1
            _labels.value = emptyList()
            _selectedLabelIds.value = emptySet()
            return
        }
        if (labelsOrganizationId != organizationId) {
            labelsOrganizationId = organizationId
            labelsLoadGeneration += 1
            _labels.value = imConversationLabelCatalog(emptyList())
            _selectedLabelIds.value = emptySet()
        }
        centrifugoClient.connect()
        store.loadConversations(organizationId)
        val generation = labelsLoadGeneration
        viewModelScope.launch {
            val labels = runCatching { labelRepository.list(organizationId) }.getOrNull() ?: return@launch
            if (labelsOrganizationId != organizationId || generation != labelsLoadGeneration) return@launch
            _labels.value = imConversationLabelCatalog(labels)
            _selectedLabelIds.value = _selectedLabelIds.value.intersect(_labels.value.map { it.id }.toSet())
        }
    }

    public suspend fun refresh(organizationId: String) {
        if (organizationId.isBlank()) return
        centrifugoClient.connect()
        store.reload(organizationId)
        val generation = labelsLoadGeneration
        val labels = runCatching { labelRepository.list(organizationId) }.getOrNull() ?: return
        if (labelsOrganizationId == organizationId && generation == labelsLoadGeneration) {
            _labels.value = imConversationLabelCatalog(labels)
        }
    }

    public suspend fun searchMessages(organizationId: String, query: String) {
        store.searchMessages(organizationId, query)
    }

    public suspend fun togglePin(conversationId: String) {
        store.togglePin(conversationId)
    }

    public suspend fun toggleMute(conversationId: String) {
        store.toggleMute(conversationId)
    }

    public fun dismissPinActionError() {
        store.dismissPinActionError()
    }

    public fun dismissMuteActionError() {
        store.dismissMuteActionError()
    }

    public fun dismissPersonalNotice() {
        store.dismissPersonalNotice()
    }

    public fun toggleLabelFilter(labelId: String) {
        _selectedLabelIds.value = if (labelId in _selectedLabelIds.value) {
            _selectedLabelIds.value - labelId
        } else {
            _selectedLabelIds.value + labelId
        }
    }
}

/**
 * iOS `MessagesTabRoot` 的 Android 对齐页：搜索、群聊创建和最近会话。
 * `activationId` 在用户每次点按消息 Tab 时递增，使保留的 Compose 页面也会刷新 IM 快照。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun RecentMessagesSection(
    organizationId: String,
    activationId: Int,
    searchQuery: String,
    onDismissSearch: () -> Unit,
    onOpenConversation: (conversationId: String, title: String) -> Unit,
    viewModel: ImInboxViewModel = hiltViewModel(),
    contactsViewModel: ContactsViewModel = hiltViewModel(),
) {
    val conversations by viewModel.conversations.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val loadErrorRes by viewModel.loadErrorRes.collectAsState()
    val searchResults by viewModel.searchResults.collectAsState()
    val isSearching by viewModel.isSearching.collectAsState()
    val searchErrorRes by viewModel.searchErrorRes.collectAsState()
    val pinningConversationIds by viewModel.pinningConversationIds.collectAsState()
    val pinActionError by viewModel.pinActionError.collectAsState()
    val mutingConversationIds by viewModel.mutingConversationIds.collectAsState()
    val muteActionError by viewModel.muteActionError.collectAsState()
    val contactsState by contactsViewModel.uiState.collectAsState()
    val labels by viewModel.labels.collectAsState()
    val selectedLabelIds by viewModel.selectedLabelIds.collectAsState()
    val context = LocalContext.current
    val pinFailedMessage = stringResource(R.string.im_messages_pin_failed)
    val muteFailedMessage = stringResource(R.string.im_messages_mute_failed)
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var isRefreshing by remember { mutableStateOf(false) }

    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }
            .filter { it }
            .collect { onDismissSearch() }
    }

    LaunchedEffect(organizationId, activationId) {
        // 首次加载与每次回到 Tab 都走同一条权威快照链路，避免置顶/未读/最后消息滞后。
        viewModel.activate(organizationId)
        contactsViewModel.activate(organizationId)
    }
    LaunchedEffect(organizationId, searchQuery) {
        viewModel.searchMessages(organizationId, searchQuery)
    }
    LaunchedEffect(pinActionError) {
        pinActionError ?: return@LaunchedEffect
        Toast.makeText(
            context,
            pinActionError ?: pinFailedMessage,
            Toast.LENGTH_LONG,
        ).show()
        viewModel.dismissPinActionError()
    }
    LaunchedEffect(muteActionError) {
        muteActionError ?: return@LaunchedEffect
        Toast.makeText(
            context,
            muteActionError ?: muteFailedMessage,
            Toast.LENGTH_LONG,
        ).show()
        viewModel.dismissMuteActionError()
    }

    val directMessageFallbackTitle = stringResource(R.string.im_kind_dm)
    val conversationFallbackTitle = stringResource(R.string.im_conversation_default_title)
    val resolvedTitles = remember(
        conversations,
        contactsState.members,
        directMessageFallbackTitle,
        conversationFallbackTitle,
    ) {
        conversations.associate { conversation ->
            val peerName = conversation.dmPeerUserId?.let { peerId ->
                contactsState.members.firstOrNull { it.userId == peerId }?.displayName
            }
            conversation.id to ImConversationTitlePolicy.resolve(
                conversationName = conversation.name,
                isDirectMessage = conversation.type == ImConversationType.DM,
                peerDisplayName = peerName,
                directMessageFallback = directMessageFallbackTitle,
                conversationFallback = conversationFallbackTitle,
            )
        }
    }
    val sortedConversations = remember(conversations) {
        conversations
            .sortedWith(
                compareByDescending<ImConversation> { it.pinned }
                    .thenByDescending { it.sortValue }
                    .thenBy { it.id },
            )
    }
    val normalizedQuery = searchQuery.trim()
    val visibleRows = remember(sortedConversations, resolvedTitles, searchResults, normalizedQuery, selectedLabelIds) {
        resolveImInboxRows(
            conversations = sortedConversations,
            resolvedTitles = resolvedTitles,
            searchResults = searchResults,
            query = normalizedQuery,
        ).filter { row -> imConversationMatchesLabelFilters(row.conversation, selectedLabelIds) }
    }

    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = {
            scope.launch {
                isRefreshing = true
                viewModel.refresh(organizationId)
                isRefreshing = false
            }
        },
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectTapGestures(onTap = { onDismissSearch() })
            },
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            if (labels.isNotEmpty()) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    items(labels, key = { it.id }) { label ->
                        val selected = label.id in selectedLabelIds
                        Surface(
                            shape = RoundedCornerShape(999.dp),
                            color = if (selected) {
                                imLabelColor(label.color)
                            } else {
                                MaterialTheme.colorScheme.surfaceVariant
                            },
                            modifier = Modifier.clickable { viewModel.toggleLabelFilter(label.id) },
                        ) {
                            Text(
                                label.name,
                                modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
                                style = MaterialTheme.typography.labelMedium,
                                color = if (selected) {
                                    Color.White
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                },
                            )
                        }
                    }
                }
            }
            MessageListContent(
                listState = listState,
                rows = visibleRows,
                isLoading = if (normalizedQuery.isEmpty()) isLoading else isSearching,
                errorRes = if (normalizedQuery.isEmpty()) loadErrorRes else searchErrorRes,
                isSearch = normalizedQuery.isNotEmpty(),
                isPinning = { it in pinningConversationIds },
                isMuting = { it in mutingConversationIds },
                onRetry = {
                    if (normalizedQuery.isEmpty()) {
                        viewModel.activate(organizationId)
                    } else {
                        scope.launch { viewModel.searchMessages(organizationId, normalizedQuery) }
                    }
                },
                titleFor = { conversation -> resolvedTitles[conversation.id] ?: conversationFallbackTitle },
                organizationMembers = contactsState.members,
                onOpenConversation = onOpenConversation,
                onTogglePin = { conversationId ->
                    scope.launch { viewModel.togglePin(conversationId) }
                },
                onToggleMute = { conversationId ->
                    scope.launch { viewModel.toggleMute(conversationId) }
                },
            )
        }
    }
}

@Composable
private fun MessageListContent(
    listState: LazyListState,
    rows: List<ImInboxRowItem>,
    isLoading: Boolean,
    @StringRes errorRes: Int?,
    isSearch: Boolean,
    isPinning: (String) -> Boolean,
    isMuting: (String) -> Boolean,
    onRetry: () -> Unit,
    titleFor: (ImConversation) -> String,
    organizationMembers: List<OrganizationMember>,
    onOpenConversation: (conversationId: String, title: String) -> Unit,
    onTogglePin: (String) -> Unit,
    onToggleMute: (String) -> Unit,
) {
    when {
        isLoading && rows.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        errorRes != null && rows.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(stringResource(errorRes), color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.size(TTSpacing.lg))
                Button(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
            }
        }
        rows.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    stringResource(if (isSearch) R.string.im_messages_search_empty else R.string.im_messages_empty_title),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!isSearch) {
                    Spacer(Modifier.size(TTSpacing.sm))
                    Text(
                        stringResource(R.string.im_messages_empty_description),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        else -> LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(vertical = TTSpacing.sm),
        ) {
            items(rows, key = { it.conversation.id }) { row ->
                val conversation = row.conversation
                val displayTitle = titleFor(conversation)
                ImInboxRow(
                    conversation = conversation,
                    preview = row.preview,
                    displayTitle = displayTitle,
                    organizationMembers = organizationMembers,
                    isPinning = isPinning(conversation.id),
                    isMuting = isMuting(conversation.id),
                    onClick = { onOpenConversation(conversation.id, displayTitle) },
                    onTogglePin = { onTogglePin(conversation.id) },
                    onToggleMute = { onToggleMute(conversation.id) },
                )
                HorizontalDivider(
                    modifier = Modifier.padding(start = 64.dp),
                    color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
                )
            }
        }
    }
}

/** 会话行只展示会话状态；置顶与免打扰操作统一收口到长按菜单。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ImInboxRow(
    conversation: ImConversation,
    preview: String,
    displayTitle: String,
    organizationMembers: List<OrganizationMember>,
    isPinning: Boolean,
    isMuting: Boolean,
    onClick: () -> Unit,
    onTogglePin: () -> Unit,
    onToggleMute: () -> Unit,
) {
    val context = LocalContext.current
    var showMenu by remember { mutableStateOf(false) }
    Box {
        Surface(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .combinedClickable(
                        onClick = onClick,
                        onLongClick = { showMenu = true },
                        onLongClickLabel = stringResource(R.string.im_messages_actions),
                    )
                    .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ConversationAvatar(conversation, displayTitle, organizationMembers)
                Spacer(Modifier.size(TTSpacing.md))
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (conversation.pinned) {
                            Icon(
                                imageVector = Icons.Filled.PushPin,
                                contentDescription = stringResource(R.string.im_messages_pinned),
                                modifier = Modifier.size(16.dp),
                                tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                            )
                            Spacer(Modifier.size(TTSpacing.xs))
                        }
                        Text(
                            text = displayTitle,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        conversation.lastMessageAt?.let { ts ->
                            RelativeTimeFormatter.format(context, ts)?.let { time ->
                                Spacer(Modifier.size(TTSpacing.sm))
                                Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                    Spacer(Modifier.size(TTSpacing.xxs))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        KindLabel(conversation)
                        conversation.labels.take(2).forEach { label ->
                            Spacer(Modifier.size(TTSpacing.xs))
                            ConversationLabelBadge(label)
                        }
                        if (preview.isNotEmpty()) {
                            Spacer(Modifier.size(TTSpacing.xs))
                            Text(
                                text = preview,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                        } else {
                            Spacer(Modifier.weight(1f))
                        }
                        if (conversation.unreadCount > 0) {
                            Spacer(Modifier.size(TTSpacing.sm))
                            UnreadBadge(conversation.unreadCount)
                        }
                    }
                }
                if (conversation.isMuted) {
                    Spacer(Modifier.size(TTSpacing.sm))
                    Icon(
                        imageVector = Icons.Filled.NotificationsOff,
                        contentDescription = stringResource(R.string.im_messages_muted),
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(if (conversation.pinned) R.string.im_messages_unpin else R.string.im_messages_pin)) },
                leadingIcon = { Icon(Icons.Default.PushPin, contentDescription = null) },
                enabled = !isPinning,
                onClick = {
                    showMenu = false
                    onTogglePin()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(if (conversation.isMuted) R.string.im_messages_unmute else R.string.im_messages_mute)) },
                leadingIcon = {
                    Icon(
                        imageVector = if (conversation.isMuted) Icons.Filled.Notifications else Icons.Filled.NotificationsOff,
                        contentDescription = null,
                    )
                },
                enabled = !isMuting,
                onClick = {
                    showMenu = false
                    onToggleMute()
                },
            )
        }
    }
}

@Composable
private fun ConversationLabelBadge(label: ImConversationLabel) {
    val color = imLabelColor(label.color)
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = color.copy(alpha = 0.14f),
    ) {
        Text(
            text = label.name,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
            style = MaterialTheme.typography.labelSmall,
            color = color,
            maxLines = 1,
        )
    }
}

internal data class ImInboxRowItem(
    val conversation: ImConversation,
    val preview: String,
)

/** 保留会话标题/最后摘要的即时本地命中，再用云正文命中补齐并覆盖同会话摘要。 */
internal fun resolveImInboxRows(
    conversations: List<ImConversation>,
    resolvedTitles: Map<String, String>,
    searchResults: List<ImMessageSearchResult>,
    query: String,
): List<ImInboxRowItem> {
    val normalizedQuery = query.trim()
    if (normalizedQuery.isEmpty()) {
        return conversations.map { ImInboxRowItem(it, it.lastMessagePreview) }
    }

    val rowsByConversationId = linkedMapOf<String, ImInboxRowItem>()
    conversations.forEach { conversation ->
        val matchesLocalSummary =
            resolvedTitles[conversation.id].orEmpty().contains(normalizedQuery, ignoreCase = true) ||
                conversation.lastMessagePreview.contains(normalizedQuery, ignoreCase = true)
        if (matchesLocalSummary) {
            rowsByConversationId[conversation.id] = ImInboxRowItem(conversation, conversation.lastMessagePreview)
        }
    }
    searchResults.forEach { result ->
        rowsByConversationId[result.conversation.id] = ImInboxRowItem(
            conversation = result.conversation,
            preview = result.matchedMessagePreview,
        )
    }
    return rowsByConversationId.values.toList()
}

@Composable
public fun CreateGroupDialog(
    viewModel: ContactsViewModel,
    onDismiss: () -> Unit,
    onCreated: (ContactDirectMessageTarget) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var selectedMemberIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var selectedExternalContactIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    LaunchedEffect(viewModel) { viewModel.reload() }
    val candidates = remember(state.members, viewModel.currentUserId) {
        state.members.filter { it.userId.isNotBlank() && it.userId != viewModel.currentUserId }
    }
    TTFormSheet(
        onDismissRequest = { if (!state.isCreatingGroup) onDismiss() },
        dismissEnabled = !state.isCreatingGroup,
        scrollable = false,
        title = { Text(stringResource(R.string.im_messages_new_group)) },
        content = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text(stringResource(R.string.im_messages_group_name)) },
                )
                Spacer(Modifier.size(TTSpacing.sm))
                Text(
                    stringResource(R.string.im_messages_group_members),
                    style = MaterialTheme.typography.labelLarge,
                )
                LazyColumn(modifier = Modifier.heightIn(max = 260.dp)) {
                    items(candidates, key = { it.userId }) { member ->
                        GroupMemberChoice(
                            member = member,
                            selected = member.userId in selectedMemberIds,
                            onToggle = {
                                selectedMemberIds = if (member.userId in selectedMemberIds) {
                                    selectedMemberIds - member.userId
                                } else {
                                    selectedMemberIds + member.userId
                                }
                            },
                        )
                    }
                    if (state.externalContacts.isNotEmpty()) {
                        item {
                            Text(
                                stringResource(R.string.external_contacts_title),
                                style = MaterialTheme.typography.labelLarge,
                                modifier = Modifier.padding(top = TTSpacing.md, bottom = TTSpacing.xs),
                            )
                        }
                        items(state.externalContacts, key = { "external:${it.contactId}" }) { contact ->
                            ExternalGroupMemberChoice(
                                contact = contact,
                                selected = contact.contactId in selectedExternalContactIds,
                                onToggle = {
                                    selectedExternalContactIds = if (contact.contactId in selectedExternalContactIds) {
                                        selectedExternalContactIds - contact.contactId
                                    } else {
                                        selectedExternalContactIds + contact.contactId
                                    }
                                },
                            )
                        }
                    }
                    state.externalContactsErrorMessage?.let { message ->
                        item {
                            Text(
                                message,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.padding(top = TTSpacing.sm),
                            )
                        }
                    }
                }
            }
        },
        actions = {
            TextButton(onClick = onDismiss, enabled = !state.isCreatingGroup) {
                Text(stringResource(R.string.common_cancel))
            }
            TextButton(
                enabled = !state.isCreatingGroup,
                onClick = {
                    scope.launch {
                        viewModel.createGroup(name, selectedMemberIds, selectedExternalContactIds)
                            .onSuccess(onCreated)
                            .onFailure { error ->
                                val exception = error as? Exception ?: Exception(error)
                                Toast.makeText(
                                    context,
                                    imGroupCreationFailureMessage(
                                        exception,
                                        context.getString(ErrorClassifier.classify(exception)),
                                    ),
                                    Toast.LENGTH_LONG,
                                ).show()
                            }
                    }
                },
            ) { Text(stringResource(R.string.common_confirm)) }
        },
    )
}

@Composable
private fun ExternalGroupMemberChoice(contact: ExternalContact, selected: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = selected, onCheckedChange = { onToggle() })
        IdentityColorAvatar(
            name = contact.displayName,
            seed = contact.peerUserId,
            imageUrl = contact.avatarUrl,
            size = 32.dp,
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Column(modifier = Modifier.weight(1f)) {
            Text(contact.displayName.ifBlank { contact.peerUserId }, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                contact.peerOrganizationName,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun GroupMemberChoice(member: OrganizationMember, selected: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = selected, onCheckedChange = { onToggle() })
        IdentityColorAvatar(
            name = member.displayName,
            seed = member.userId,
            imageUrl = member.user?.avatar,
            size = 32.dp,
        )
        Spacer(Modifier.width(TTSpacing.sm))
        Text(member.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ConversationAvatar(
    conversation: ImConversation,
    displayTitle: String,
    organizationMembers: List<OrganizationMember>,
) {
    val isChannel = conversation.isTeamSpaceChannel
    val isGroup = conversation.isGroup && !isChannel
    val seed = when {
        conversation.type == ImConversationType.DM -> conversation.dmPeerUserId?.takeIf { it.isNotBlank() } ?: conversation.id
        else -> conversation.name.ifBlank { conversation.id }
    }
    val displayName = displayTitle.ifBlank {
        when {
            isChannel -> stringResource(R.string.im_kind_channel)
            isGroup -> stringResource(R.string.im_kind_group)
            else -> stringResource(R.string.im_kind_dm)
        }
    }
    IdentityColorAvatar(
        name = displayName,
        seed = seed,
        imageUrl = if (conversation.type == ImConversationType.DM) {
            ImMemberDisplayPolicy.resolvedAvatar(
                userId = conversation.dmPeerUserId,
                snapshotAvatar = conversation.avatarUrl,
                organizationMembers = organizationMembers,
            ).takeIf { it.isNotBlank() }
        } else {
            conversation.avatarUrl.takeIf { it.isNotBlank() }
        },
        size = 40.dp,
        group = isGroup,
        channel = isChannel,
    )
}

@Composable
private fun KindLabel(conversation: ImConversation) {
    val label = when {
        conversation.isTeamSpaceChannel -> {
            val space = conversation.spaceName.trim()
            if (space.isEmpty()) stringResource(R.string.im_kind_channel)
            else stringResource(R.string.im_kind_channel_with_space, space)
        }
        conversation.type == ImConversationType.GROUP -> stringResource(R.string.im_kind_group)
        else -> stringResource(R.string.im_kind_dm)
    }
    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun UnreadBadge(count: Int) {
    Text(
        text = if (count > 99) "99+" else count.toString(),
        style = MaterialTheme.typography.labelSmall,
        color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
        modifier = Modifier
            .clip(CircleShape)
            .background(ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
