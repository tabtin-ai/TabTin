package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.features.conversation.cards.ChatCardTokens
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor

/**
 * Wave 6 A6 — @提及候选弹窗。
 *
 * 对标 Electron `MentionPopover.tsx` + iOS 弱 @ 识别（尚无独立 popover）。移动端做简化：
 *  - 窄屏体验不做 Electron 的两级分类导航（TabData / TabDoc / field）；直接展示"资源列表"，
 *    支持文本过滤（按 title 包含）。
 *  - 数据源复用 `WorkbenchViewModel` 已加载的 Space 资源——当前 Space 的 tabdata/tabdoc/
 *    tabslide/tabsite/tabtracker 通过 `SpaceResourceRepository.getResources` 已经就绪。
 *  - 字段级（field）mention 暂缓：iOS Wave 6-iOS 也未实现；桌面场景高频，移动端低频，记入
 *    Wave 7+ polish。
 *  - 选中后经由 `ResourceReference.from(SpaceResource)` → `activeResourceRefs` 复用
 *    `sendWithReferences` / `toMessageBlock` 链路上传 `{table_id | doc_id, preview}` 给后端
 *    （与 iOS 完全一致）。
 *
 * 用法：
 *   - 父 Composable 通过检测 inputText 里光标前是否有 `@query` 计算 [query]；命中则 open=true。
 *   - [onSelect] 收到选中的 SpaceResource → 父层负责从文本里删除 @query 片段 + 把资源加入 refs。
 *   - [onDismiss] 点外部 / 输入空格取消 / ESC 用。
 */
@Composable
internal fun MentionPopover(
    open: Boolean,
    query: String,
    resources: List<SpaceResource>,
    onSelect: (SpaceResource) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    // Wave 6 产品/用户 Review P0-1：区分"资源正在加载"与"Space 真的没资源"。之前
    // Workbench 还没加载完时 popover 会直接显示"暂无可引用的资源"——用户关掉
    // 过几秒再 @ 资源才出来，像一个间歇 bug。现在 loading=true 时展示"加载中…"，
    // 避免在未确定状态时给出肯定性文案。
    isLoading: Boolean = false,
) {
    if (!open) return

    val trimmed = query.trim()
    // Wave 6 跨端协议验证 P1-Q1：动态放行——以 `ResourceReference.toMessageBlock() != null`
    // 为白名单。原写法（写死 tabdata/tabdoc）即使 ResourceReference 已支持 7 类
    // (slide/design/video/site/folder/...) 用户也选不到，与 iOS 行为分裂。
    // 现在 ResourceReference 扩展新类型时，popover 自动放行，避免遗漏。
    //
    // 注意：每个候选 SpaceResource 临时构造 ResourceReference 仅用于读 toMessageBlock
    // 是否为 null —— 这条判定纯函数、与 from() 等价的冷计算，列表数量级 < 几十，开销
    // 可忽略。`remember(resources)` 锁定列表引用，Compose 重组时不重算。
    val referenceable = remember(resources) {
        resources.filter { ResourceReference.from(it).toMessageBlock() != null }
    }
    val filtered = remember(referenceable, trimmed) {
        if (trimmed.isEmpty()) {
            referenceable.take(MENTION_MAX_DISPLAY)
        } else {
            val lower = trimmed.lowercase()
            referenceable.asSequence()
                .filter { it.title.lowercase().contains(lower) || it.typeLabel.lowercase().contains(lower) }
                .take(MENTION_MAX_DISPLAY)
                .toList()
        }
    }
    // 截断提示：命中数量等于 MAX_DISPLAY 时明确告诉用户"列表被截断"，避免用户
    // 以为 Space 里就这些（产品 Review P1）。
    val truncated = filtered.size >= MENTION_MAX_DISPLAY

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs)
            .shadow(4.dp, RoundedCornerShape(8.dp))
            .clip(RoundedCornerShape(8.dp))
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .border(0.5.dp, ChatCardTokens.borderDefault(), RoundedCornerShape(8.dp))
            .heightIn(max = 280.dp),
    ) {
        // Header: 查询文本 + 搜索图标
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.Search,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = ChatCardTokens.textMuted(),
            )
            Spacer(Modifier.width(TTSpacing.xs))
            Text(
                text = trimmed.ifEmpty { stringResource(R.string.chat_mention_title) },
                style = TTFonts.caption,
                color = ChatCardTokens.textMuted(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }

        if (filtered.isEmpty()) {
            val message = when {
                isLoading -> stringResource(R.string.chat_mention_loading)
                trimmed.isEmpty() -> stringResource(R.string.chat_mention_empty_category)
                else -> stringResource(R.string.chat_mention_no_match)
            }
            Text(
                text = message,
                style = TTFonts.caption,
                color = ChatCardTokens.textMuted(),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.md, vertical = TTSpacing.md),
            )
            return@Column
        }

        LazyColumn(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            items(
                items = filtered,
                key = { "${it.normalizedType}:${it.resourceId}" },
            ) { resource ->
                MentionRow(resource = resource, onClick = { onSelect(resource) })
            }
            if (truncated) {
                item(key = "__truncation_hint__") {
                    Text(
                        text = stringResource(
                            R.string.chat_mention_truncated_hint,
                            MENTION_MAX_DISPLAY,
                        ),
                        style = TTFonts.caption,
                        color = ChatCardTokens.textMuted(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.xs),
                    )
                }
            }
        }
    }
}

@Composable
private fun MentionRow(resource: SpaceResource, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ContextResourceIcon(resource = resource, size = 16.dp)
        Spacer(Modifier.width(TTSpacing.xs))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = resource.displayTitle,
                style = TTFonts.caption,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(TTSpacing.xs))
        Text(
            text = resource.typeLabel,
            style = TTFonts.caption,
            color = ChatCardTokens.textMuted(),
            modifier = Modifier.widthIn(max = 80.dp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private const val MENTION_MAX_DISPLAY = 30

/**
 * Wave 6 A6 — 在输入文本里检测 @提及触发态。
 *
 * 规则（对齐 Electron `MentionPopover` 触发逻辑）：
 *  - 文本末尾有 `@`（或 `@` 后跟若干非空白字符），触发 popover；
 *  - 空格 / 换行 / 中文标点等终止；
 *  - `@` 必须在词首（行首 / 前一字符为空白 / 前一字符为中英文标点），避免邮箱里的 @ 误触发。
 *
 * 返回：
 *   - null：不在 mention 态
 *   - (query, atIndex)：当前 query + `@` 在 text 中的字符下标，选中后父层用 `text.removeRange(atIndex..cursor)`
 *     清理触发片段。
 */
internal fun detectMentionTrigger(text: String, cursor: Int = text.length): MentionTrigger? {
    if (cursor <= 0 || cursor > text.length) return null
    val upto = text.substring(0, cursor)
    var atIdx = -1
    // 从光标前向左扫描，遇到空格/换行/控制字符即停止。
    for (i in upto.length - 1 downTo 0) {
        val c = upto[i]
        if (c == '@') { atIdx = i; break }
        if (c.isWhitespace() || c == '\n' || c == '\r') return null
    }
    if (atIdx < 0) return null
    // 校验 @ 前必须是词首。
    if (atIdx > 0) {
        val prev = upto[atIdx - 1]
        if (!prev.isWhitespace() && prev !in MENTION_PREV_ALLOWED) return null
    }
    val query = upto.substring(atIdx + 1)
    // query 本身不允许包含空白（上面循环已保证），长度 > 40 视为误触发（避免 @ 后长段文本）。
    if (query.length > 40) return null
    return MentionTrigger(query = query, atIndex = atIdx)
}

/** @-提及触发的位置 + 查询串。 */
internal data class MentionTrigger(val query: String, val atIndex: Int)

/** @ 前置允许的词首"分隔字符"。补上中文常见标点，避免"他说:@tab"不触发。 */
private val MENTION_PREV_ALLOWED = setOf(
    '(', '[', '{', '"', '\'',
    '\u3010', '\u300c', '\u300e', // 【「『
    '\u00ab', // «
    '\uff08', '\uff3b', // （［
    '\uff1a', '\uff1b', '\uff0c', '\u3002', // ：；，。
)
