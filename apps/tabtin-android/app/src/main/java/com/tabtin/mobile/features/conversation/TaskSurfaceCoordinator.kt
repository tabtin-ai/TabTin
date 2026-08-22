package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.features.workbench.WorkbenchPresentation

/**
 * 移动端工作台工作面 UI；底层挂载与导航代码始终保留，可用本开关临时隐藏入口。
 * 对齐 iOS [ConversationWorkbenchUIPolicy]。
 */
public object ConversationWorkbenchUIPolicy {
    public const val showsSurfaceSwitcher: Boolean = true
}

/**
 * ≥[TaskSurfaceCoordinator.REGULAR_WIDTH_DP] 启用三态；窄屏双态映射为 chat-focus / app-focus（切面，非 Modal）。
 * 工作台 / 对话组合树 keep-alive，供 P3 几何 ghost 使用。
 */
public enum class TaskSurfaceMode {
    /** 对话占满；工作台收起（可 keep-alive 挂载） */
    CHAT_FOCUS,
    /** 双栏并排（仅宽屏） */
    SPLIT,
    /** 工作台占满；对话收起为胶囊（对话可 keep-alive） */
    APP_FOCUS,
}

public data class TaskSurfaceLayout(
    val widthDp: Int,
    val workbenchOpen: Boolean,
    val preferAppFocus: Boolean = false,
)

/** 窄屏顶部切换的两个独立 presentation；overlay 的最高档不等于完整对话页。 */
internal enum class CompactConversationPresentation {
    WORKBENCH_OVERLAY,
    DIRECT_CONVERSATION,
}

/** [ChatSessionScreen] 直接消费的窄屏渲染计划，避免 UI 再从 layer detent 猜 presentation。 */
internal data class CompactConversationRenderPlan(
    val composeDirectConversation: Boolean,
    val composeOverlayHost: Boolean,
    val conversationContentVisible: Boolean,
    val capsuleVisible: Boolean,
    val pickerWorkbenchSelected: Boolean,
)

/**
 * 布局模式解析与 keep-alive 契约。
 *
 * ## 759 / 760 边界（[REGULAR_WIDTH_DP]）
 * - **759dp 及以下**：双态 — `workbenchOpen` → [TaskSurfaceMode.APP_FOCUS]；
 *   `preferAppFocus` 不生效；无 [TaskSurfaceMode.SPLIT]。
 * - **760dp 及以上**：三态 — 关闭 → CHAT_FOCUS；打开且非 app 优先 → SPLIT；
 *   打开且 [TaskSurfaceLayout.preferAppFocus] → APP_FOCUS。
 *
 * ## Reduce Motion 验收（宿主 + Morph）
 * `ANIMATOR_DURATION_SCALE == 0` 时 [TaskSurfaceMorphCoordinator.beginTransition] 返回 null、
 * 清 ghost；焦点立即跟 mode。真机清单：759/760 手感、中途反向无残层、Reduce Motion 焦点正确。
 */
public object TaskSurfaceCoordinator {
    /** 宽屏三态门槛（dp）。759 双态 / 760 三态，见类 kdoc。 */
    public const val REGULAR_WIDTH_DP: Int = 760

    public fun resolveMode(layout: TaskSurfaceLayout): TaskSurfaceMode {
        val regular = layout.widthDp >= REGULAR_WIDTH_DP
        return when {
            !layout.workbenchOpen -> TaskSurfaceMode.CHAT_FOCUS
            regular && layout.preferAppFocus -> TaskSurfaceMode.APP_FOCUS
            regular -> TaskSurfaceMode.SPLIT
            // 窄屏：「对话 | 工作台」切面 → 工作台全屏 = app-focus（非 Modal sheet）
            else -> TaskSurfaceMode.APP_FOCUS
        }
    }

    /** 工作台首次打开后保持组合树/WebView 存活。 */
    public fun keepsWorkbenchAlive(everOpened: Boolean): Boolean = everOpened

    public fun conversationVisible(mode: TaskSurfaceMode): Boolean =
        mode == TaskSurfaceMode.CHAT_FOCUS || mode == TaskSurfaceMode.SPLIT

    /**
     * 对话内容面是否可见（keep-alive 时仍可组合，仅显隐/命中）。
     * 窄屏工作台打开 → [APP_FOCUS] → 不可见；宽屏跟 [conversationVisible]。
     */
    public fun conversationContentVisible(
        mode: TaskSurfaceMode,
        widthDp: Int,
        workbenchOpen: Boolean,
    ): Boolean {
        if (widthDp < REGULAR_WIDTH_DP) {
            return !workbenchOpen
        }
        return conversationVisible(mode)
    }

    /**
     * 胶囊布局是否允许显示。
     * 窄屏：工作台切面打开时显示；宽屏：仅 App 聚焦态（对齐 iOS / Electron）。
     */
    public fun capsuleLayoutAllows(
        mode: TaskSurfaceMode,
        widthDp: Int,
        workbenchOpen: Boolean,
    ): Boolean {
        if (widthDp < REGULAR_WIDTH_DP) {
            // 与 resolveMode 窄屏 app-focus / 切面一致
            return workbenchOpen
        }
        return mode == TaskSurfaceMode.APP_FOCUS
    }

    /**
     * 窄屏 overlay：只有完全收起时对话内容才不可见。半屏与扩展档都算可见——
     * 半屏下用户确实能同时看到两层，这也是「不打断」的关键。
     */
    internal fun conversationContentVisibleCompact(detent: ConversationLayerDetent): Boolean =
        detent != ConversationLayerDetent.COLLAPSED

    /** 胶囊是层的把手：层一离开收起态就交棒给层顶抓手，避免两个把手并存。 */
    internal fun capsuleVisibleCompact(detent: ConversationLayerDetent): Boolean =
        detent == ConversationLayerDetent.COLLAPSED

    /**
     * direct 与 overlay 由 presentation 决定，不再借 layer 的最高档冒充完整对话页。
     * 这个计划被真实 Compose 分支消费，也作为两个 presentation 的回归测试缝。
     */
    internal fun compactConversationRenderPlan(
        presentation: CompactConversationPresentation,
        overlayDetent: ConversationLayerDetent,
    ): CompactConversationRenderPlan = when (presentation) {
        CompactConversationPresentation.WORKBENCH_OVERLAY -> CompactConversationRenderPlan(
            composeDirectConversation = false,
            composeOverlayHost = true,
            conversationContentVisible = conversationContentVisibleCompact(overlayDetent),
            capsuleVisible = capsuleVisibleCompact(overlayDetent),
            pickerWorkbenchSelected = true,
        )
        CompactConversationPresentation.DIRECT_CONVERSATION -> CompactConversationRenderPlan(
            composeDirectConversation = true,
            composeOverlayHost = false,
            conversationContentVisible = true,
            capsuleVisible = false,
            pickerWorkbenchSelected = false,
        )
    }

    /**
     * 窄屏总览保留「对话 | 工作台」切换。打开 App / 资源后藏掉，把高度留给内容；
     * 回对话走 App 内返回，不靠顶栏切换。对齐 iOS `ConversationTaskSurfaceSwitcherPolicy`。
     */
    @Suppress("UNUSED_PARAMETER")
    internal fun compactSurfaceSwitcherVisible(
        regularWidth: Boolean,
        showsWorkbenchChrome: Boolean,
        compactPresentationAvailable: Boolean,
        showWorkbench: Boolean,
        detailRequestsSwitcherHidden: Boolean,
    ): Boolean {
        if (regularWidth || !showsWorkbenchChrome) return false
        if (showWorkbench && detailRequestsSwitcherHidden) return false
        return true
    }

    /** 顶部「对话」切换 direct presentation；重复点击 direct 为空操作。 */
    internal fun conversationPickerTargetCompact(
        presentation: CompactConversationPresentation,
    ): CompactConversationPresentation? =
        if (presentation == CompactConversationPresentation.DIRECT_CONVERSATION) {
            null
        } else {
            CompactConversationPresentation.DIRECT_CONVERSATION
        }

    /** 胶囊是轻量入口，只从收起态升到半屏，不复用分段器的 direct 语义。 */
    internal fun capsuleTapTargetCompact(
        detent: ConversationLayerDetent,
    ): ConversationLayerDetent? =
        if (detent == ConversationLayerDetent.COLLAPSED) ConversationLayerDetent.SHEET else null

    /** 层外背景按层级退档；收起态不挂透明命中层，让工作台正常接收事件。 */
    internal fun conversationBackdropTargetCompact(
        detent: ConversationLayerDetent,
    ): ConversationLayerDetent? = when (detent) {
        ConversationLayerDetent.COLLAPSED -> null
        ConversationLayerDetent.SHEET -> ConversationLayerDetent.COLLAPSED
        ConversationLayerDetent.EXPANDED -> ConversationLayerDetent.SHEET
    }

    public fun workbenchPaneVisible(mode: TaskSurfaceMode, workbenchOpen: Boolean): Boolean =
        when (mode) {
            TaskSurfaceMode.CHAT_FOCUS -> false
            TaskSurfaceMode.SPLIT, TaskSurfaceMode.APP_FOCUS -> workbenchOpen
        }

    /**
     * 只有工作台是当前可见工作面时，内部详情才可以接管系统返回。
     * keep-alive 的透明工作台仍在 Compose 树中，不能仅靠 alpha 判断交互归属。
     */
    public fun workbenchBackHandlingEnabled(
        mode: TaskSurfaceMode,
        workbenchOpen: Boolean,
    ): Boolean = workbenchPaneVisible(mode, workbenchOpen)

    /**
     * 窄屏对话层升起后，返回应先逐档收起对话层；切到 direct 对话时工作台也只保活。
     * 仅「工作台 + 收起胶囊」这一顶层状态允许详情消费系统返回。
     */
    internal fun compactWorkbenchBackHandlingEnabled(
        workbenchOpen: Boolean,
        presentation: CompactConversationPresentation,
        detent: ConversationLayerDetent,
    ): Boolean = workbenchOpen &&
        presentation == CompactConversationPresentation.WORKBENCH_OVERLAY &&
        detent == ConversationLayerDetent.COLLAPSED

    /**
     * ≥760dp：chat-focus 下若曾打开过，仍组合工作台（width/alpha=0），避免卸载 WebView。
     * 窄屏工作台由 [ChatSessionScreen] TASK_PANE 切面宿主组合，此处不组合以免双实例。
     */
    public fun shouldComposeWorkbench(
        mode: TaskSurfaceMode,
        everOpened: Boolean,
        workbenchOpen: Boolean,
        widthDp: Int = REGULAR_WIDTH_DP,
    ): Boolean {
        if (widthDp < REGULAR_WIDTH_DP) return false
        if (workbenchOpen) return true
        return when (mode) {
            TaskSurfaceMode.CHAT_FOCUS -> everOpened
            TaskSurfaceMode.SPLIT, TaskSurfaceMode.APP_FOCUS -> everOpened || workbenchOpen
        }
    }

    /** 窄屏 TASK_PANE：曾打开或当前打开则挂载（opacity/zIndex 显隐，对齐 iOS shouldMountWorkbench）。 */
    public fun shouldComposeWorkbenchCompact(
        everOpened: Boolean,
        workbenchOpen: Boolean,
    ): Boolean = everOpened || workbenchOpen

    /** 对话始终组合一次（app-focus 下隐藏但保活，供反向 morph）。 */
    @Suppress("UNUSED_PARAMETER")
    public fun shouldComposeConversation(
        mode: TaskSurfaceMode,
        everOpened: Boolean,
    ): Boolean = true

    /**
     * 会话内工作台呈现：≥[REGULAR_WIDTH_DP] → [WorkbenchPresentation.EMBEDDED]（TaskSurfaceHost）；
     * 窄屏 → [WorkbenchPresentation.TASK_PANE]（切面，非 MODAL sheet）。
     */
    public fun sessionWorkbenchPresentation(widthDp: Int): WorkbenchPresentation =
        if (widthDp >= REGULAR_WIDTH_DP) {
            WorkbenchPresentation.EMBEDDED
        } else {
            WorkbenchPresentation.TASK_PANE
        }
}
