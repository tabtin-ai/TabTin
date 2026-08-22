package com.tabtin.mobile.debug

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.tabtin.mobile.features.conversation.ComposerReadingCollapsePolicy
import com.tabtin.mobile.features.conversation.ComposerTopScrimHeight
import com.tabtin.mobile.features.conversation.ComposerTopScrimReadableOverlap
import com.tabtin.mobile.features.conversation.ComposerView
import com.tabtin.mobile.features.conversation.ConversationTypography
import com.tabtin.mobile.features.conversation.MessageListScrollState
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.TabTinTheme
import com.tabtin.mobile.ui.theme.ttColor

/**
 * 「阅读时 Composer 收敛」的确定性视觉夹具，不依赖登录、后端或执行设备。
 *
 * 启动：
 * ```
 * adb shell am start -n com.tabtin.mobile/com.tabtin.mobile.debug.ComposerReadingCollapseReviewActivity
 * ```
 * 用于逐轮验证：滑动消息 → 输入区收成悬浮胶囊；回到最新 → 自然展开；点胶囊 → 展开并聚焦。
 */
public class ComposerReadingCollapseReviewActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            TabTinTheme {
                ComposerReadingCollapseReviewScreen()
            }
        }
    }
}

private data class ReviewRow(val id: String, val isUser: Boolean, val text: String)

private val reviewRows: List<ReviewRow> = (1..14).flatMap { round ->
    listOf(
        ReviewRow("u-$round", true, "第 $round 轮：帮我看看这块的实现思路。"),
        ReviewRow(
            "a-$round",
            false,
            "第 $round 轮回复：先把链路拆成「输入 → 变换 → 渲染」三段，再定位分叉点。" +
                "这里多写几行是为了把列表撑高，好让夹具能真的滚起来，验证输入区在阅读时" +
                "的收敛与回到底部后的展开。",
        ),
    )
}

@Composable
private fun ComposerReadingCollapseReviewScreen() {
    var text by remember { mutableStateOf("") }
    var collapsedForReading by remember { mutableStateOf(false) }
    var hasSettledInitialPosition by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    // 复刻真实会话的进入姿态：先贴底看最新，再开始判定收敛。
    LaunchedEffect(Unit) {
        listState.scrollToItem(reviewRows.lastIndex)
        hasSettledInitialPosition = true
    }

    LaunchedEffect(listState) {
        snapshotFlow {
            if (!hasSettledInitialPosition) {
                MessageListScrollState.SETTLED_AT_BOTTOM
            } else {
                MessageListScrollState(
                    isUserScrolling = listState.isScrollInProgress,
                    isAtBottom = !listState.canScrollForward,
                )
            }
        }.collect { collapsedForReading = ComposerReadingCollapsePolicy.scrollWantsCollapse(it) }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ttColor(TTColors.Background, TTColors.Dark.Background))
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                state = listState,
                verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
                contentPadding = PaddingValues(
                    start = TTSpacing.lg,
                    end = TTSpacing.lg,
                    top = TTSpacing.md,
                    // 夹具底边有羽化 overlay；多留可读重叠，与会话列表同口径。
                    bottom = TTSpacing.md + ComposerTopScrimReadableOverlap,
                ),
            ) {
                items(reviewRows, key = { it.id }) { row ->
                    Text(
                        text = row.text,
                        modifier = Modifier.fillMaxWidth(),
                        style = ConversationTypography.body,
                        color = if (row.isUser) {
                            ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
                        } else {
                            ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary)
                        },
                    )
                }
            }
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(ComposerTopScrimHeight)
                    .background(
                        Brush.verticalGradient(
                            listOf(
                                Color.Transparent,
                                ttColor(TTColors.Background, TTColors.Dark.Background)
                                    .copy(alpha = 0.9f),
                            ),
                        ),
                    ),
            )
        }

        ComposerView(
            text = text,
            onTextChange = { text = it },
            isSending = false,
            isStreaming = false,
            workspaceName = "2026-06-07-17-33-35",
            onPickImages = {},
            onPickFiles = {},
            onCamera = {},
            onSend = {},
            onCancel = {},
            currentMode = "agent",
            currentApprovalMode = "always_ask",
            currentAgentName = "小豆子",
            collapsedForReading = collapsedForReading,
        )
    }
}
