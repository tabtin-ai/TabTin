package com.tabtin.mobile.features.tabdata

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.IdentityAvatar
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlin.coroutines.cancellation.CancellationException

/**
 * 人员字段选择器。搜索走服务端 `search`，交互对齐会话里的 Agent 提及选择器：
 * 自管 query / 列表 / 加载，网络通过挂起 lambda 注入。
 *
 * 分页语义对齐 iOS `NativeTabDataMemberPicker.load(reset:)`：每页 50、按 userId 去重追加、
 * `searchGeneration` 丢弃过期响应；触底自动拉下一页，而不是点「加载更多」。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TabDataMemberPickerSheet(
    selectedIds: List<String>,
    multiple: Boolean,
    onSearch: suspend (String, Int) -> Result<TabDataMemberSearchPage>,
    onToggle: (TabDataDirectoryMember) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var members by remember { mutableStateOf<List<TabDataDirectoryMember>>(emptyList()) }
    var total by remember { mutableIntStateOf(0) }
    var isLoading by remember { mutableStateOf(false) }
    var loadingReset by remember { mutableStateOf(false) }
    var loadFailed by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var searchGeneration by remember { mutableIntStateOf(0) }
    val unnamedMemberLabel = stringResource(R.string.tabdata_member_unnamed)

    suspend fun load(reset: Boolean) {
        if (!reset && (
                isLoading ||
                    loadFailed ||
                    !TabDataUserFieldPolicy.canLoadMore(members.size, total)
                )
        ) {
            return
        }
        val generation = TabDataUserFieldPolicy.nextSearchGeneration(searchGeneration)
        searchGeneration = generation
        loadingReset = reset
        isLoading = true
        if (reset) {
            loadFailed = false
            errorMessage = null
        }
        val offset = TabDataUserFieldPolicy.searchOffset(reset, members.size)
        val result = try {
            onSearch(query, offset)
        } catch (cancelled: CancellationException) {
            throw cancelled
        }
        if (!TabDataUserFieldPolicy.shouldApplySearchResponse(generation, searchGeneration)) {
            return
        }
        result
            .onSuccess { page ->
                members = TabDataUserFieldPolicy.mergeSearchPage(members, page.members, reset)
                total = page.total
                errorMessage = null
                loadFailed = false
            }
            .onFailure { error ->
                if (error is CancellationException) throw error
                errorMessage = error.message
                loadFailed = true
            }
        if (TabDataUserFieldPolicy.shouldApplySearchResponse(generation, searchGeneration)) {
            isLoading = false
        }
    }

    LaunchedEffect(query) {
        kotlinx.coroutines.delay(300)
        load(reset = true)
    }

    val canLoadMore = TabDataUserFieldPolicy.canLoadMore(members.size, total)
    val showLoadMoreFooter = isLoading && members.isNotEmpty() && !loadingReset

    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(),
    ) {
        TTSheetColumn(
            scrollable = false,
            modifier = Modifier
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                Text(
                    text = stringResource(R.string.tabdata_member_picker_title),
                    style = MaterialTheme.typography.titleMedium,
                )
                TabSearchField(
                    query = query,
                    onQueryChange = { query = it },
                    placeholder = stringResource(R.string.tabdata_member_search_hint),
                    modifier = Modifier.fillMaxWidth(),
                    showCancelOnFocus = false,
                )
                Box(modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 360.dp)) {
                    when {
                        isLoading && members.isEmpty() -> Box(
                            Modifier.fillMaxWidth().padding(TTSpacing.xl),
                            contentAlignment = Alignment.Center,
                        ) { CircularProgressIndicator() }

                        errorMessage != null && members.isEmpty() -> Text(
                            text = errorMessage ?: stringResource(R.string.tabdata_member_picker_error),
                            style = TTFonts.body,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().padding(TTSpacing.lg),
                        )

                        members.isEmpty() -> Text(
                            text = stringResource(R.string.tabdata_member_picker_empty),
                            style = TTFonts.body,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().padding(TTSpacing.lg),
                        )

                        else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                            items(members, key = { it.userId }) { member ->
                                val checked = member.userId in selectedIds
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            onToggle(member)
                                            if (!multiple) onDismiss()
                                        }
                                        .padding(vertical = TTSpacing.sm),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                                ) {
                                    val memberLabel = member.displayName.trim()
                                        .ifEmpty { unnamedMemberLabel }
                                    IdentityColorAvatar(
                                        name = memberLabel,
                                        seed = IdentityAvatar.colorSeed(member.userId, memberLabel),
                                        imageUrl = member.avatarUrl,
                                        size = 32.dp,
                                    )
                                    Text(
                                        memberLabel,
                                        style = TTFonts.body,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (checked) {
                                        Icon(Icons.Default.Check, contentDescription = null)
                                    }
                                }
                            }
                            if (errorMessage != null && loadFailed) {
                                item(key = "member-picker-load-error") {
                                    Text(
                                        text = errorMessage
                                            ?: stringResource(R.string.tabdata_member_picker_error),
                                        style = TTFonts.caption,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(vertical = TTSpacing.sm),
                                    )
                                }
                            } else if (canLoadMore) {
                                item(key = "member-picker-load-more-${members.size}") {
                                    LaunchedEffect(members.size, total) {
                                        load(reset = false)
                                    }
                                    if (showLoadMoreFooter) {
                                        Row(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(vertical = TTSpacing.md),
                                            horizontalArrangement = Arrangement.Center,
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            CircularProgressIndicator(
                                                modifier = Modifier
                                                    .padding(end = TTSpacing.sm)
                                                    .size(18.dp),
                                                strokeWidth = 2.dp,
                                            )
                                            Text(
                                                text = stringResource(
                                                    R.string.tabdata_member_picker_loading_more,
                                                ),
                                                style = TTFonts.caption,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if (multiple) {
                    Button(
                        onClick = onDismiss,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.common_done), style = TTFonts.bodyMedium)
                    }
                }
            }
        }
    }
}
