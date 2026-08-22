package com.tabtin.mobile.features.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.SpaceResource

/**
 * 工作台表面：统一内容宿主（overview / AppHome / Web 同层切换）+ 可挂反馈层。
 *
 * - [WorkbenchPresentation.MODAL]：overview 等由内容体按需包 [com.tabtin.mobile.ui.components.TTBottomSheet]
 * - [WorkbenchPresentation.EMBEDDED]：宽屏侧栏内嵌（[com.tabtin.mobile.features.conversation.TaskSurfaceHost]）
 * - [WorkbenchPresentation.TASK_PANE]：会话内全屏工作面（非 sheet）
 *
 * [WorkbenchSheet] 仅为 MODAL 深链入口的薄适配；任务路径请直接组合本 Surface。
 */
@Composable
public fun WorkbenchSurface(
    organizationId: String,
    spaceId: String?,
    /** false 时仅保活状态；内部页面不得抢占当前可见对话的系统返回。 */
    backHandlingEnabled: Boolean = true,
    initialOpenRequest: WorkbenchResourceOpenRequest? = null,
    onInitialOpenRequestConsumed: (WorkbenchResourceOpenRequest) -> Unit = {},
    onFocusChanged: (WorkbenchFocusTarget) -> Unit = {},
    onDismiss: () -> Unit,
    onDelegateToAgent: (SpaceResource) -> Unit,
    onResourceOpen: (SpaceResource) -> Unit = {},
    onSendReference: ((ResourceReference) -> Unit)? = null,
    /**
     * 任务对话宿主注入：点「交给 Agent」时把提示语填进 composer 并回对话面。
     * 深链 / 非对话入口保持 null，退回 Toast 提示。
     */
    onRequestApp: ((TaskWorkbenchApp) -> Unit)? = null,
    /** 当前会话消息，用于投影「本任务产出」（对齐 iOS TaskWorkbenchProjector）。 */
    conversationMessages: List<ChatMessage> = emptyList(),
    presentation: WorkbenchPresentation = WorkbenchPresentation.MODAL,
    /** 任务页进入资源/App 子页面时，让宿主隐藏「对话 / 工作台」切换。 */
    onTaskPaneDetailVisibilityChanged: (Boolean) -> Unit = {},
    /**
     * 与内容同层的后置 overlay（胶囊 / snackbar 等）。
     * 始终可组合，不随 Web/AppHome/Overview 切换被 early-return 卸掉。
     */
    feedbackOverlay: @Composable BoxScope.() -> Unit = {},
    viewModel: WorkbenchViewModel,
) {
    var lastFocus by remember { mutableStateOf<WorkbenchFocusTarget?>(null) }

    val hostModifier = if (presentation.isFullscreenTaskPane()) {
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface)
    } else {
        Modifier
    }

    Box(modifier = hostModifier) {
        WorkbenchContentHost(
            organizationId = organizationId,
            spaceId = spaceId,
            backHandlingEnabled = backHandlingEnabled,
            initialOpenRequest = initialOpenRequest,
            onInitialOpenRequestConsumed = onInitialOpenRequestConsumed,
            onDismiss = onDismiss,
            onDelegateToAgent = onDelegateToAgent,
            onResourceOpen = onResourceOpen,
            activeConversationSink = onSendReference,
            onRequestApp = onRequestApp,
            conversationMessages = conversationMessages,
            onFocusChanged = { focus ->
                if (focus != lastFocus) {
                    lastFocus = focus
                    onFocusChanged(focus)
                }
            },
            presentation = presentation,
            onTaskPaneDetailVisibilityChanged = onTaskPaneDetailVisibilityChanged,
            viewModel = viewModel,
        )
        feedbackOverlay()
    }

    LaunchedEffect(Unit) {
        if (lastFocus == null) {
            onFocusChanged(WorkbenchFocusTarget.fromPane(WorkbenchNavigationPane.Overview))
        }
    }
}
