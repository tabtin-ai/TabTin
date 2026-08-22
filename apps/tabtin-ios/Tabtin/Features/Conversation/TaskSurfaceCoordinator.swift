import Foundation

// MARK: - Electron-aligned task view mode

/// 对齐 Electron `TaskViewMode`：`chat-focus` / `split` / `app-focus`。
/// 仅在 iPad regular 宽屏（见 ``ConversationTaskWorkspaceLayoutPolicy``）使用；
/// compact 仍走 ``ConversationTaskSurface`` 双态。
enum TaskViewMode: String, CaseIterable, Identifiable, Codable, Sendable {
    case chatFocus = "chat-focus"
    case split = "split"
    case appFocus = "app-focus"

    var id: Self { self }

    /// 与 Electron `TaskViewModeSwitch` 标签一致。
    var title: String {
        switch self {
        case .chatFocus: return "对话聚焦"
        case .split: return "分屏"
        case .appFocus: return "应用聚焦"
        }
    }

    var systemImage: String {
        switch self {
        case .chatFocus: return "sidebar.right"
        case .split: return "rectangle.split.2x1"
        case .appFocus: return "sidebar.left"
        }
    }
}

/// iPad regular 应用聚焦上的临时对话小窗；与三态工作面、compact overlay 档位相互独立。
enum RegularFloatingConversationPresentation: Equatable, Sendable {
    case closed
    case floating
}

/// regular 浮窗属于哪个展示现场。根工作面的 App Focus 与系统全屏 App
/// 是两个独立 hosting context，不能用底层 `viewMode` 猜测所有权。
enum RegularFloatingConversationOwner: Equatable, Sendable {
    case rootAppFocus
    case presentedPage
}

/// Compact（iPhone / 窄宽）双工作面。
enum ConversationTaskSurface: String, CaseIterable, Identifiable, Hashable, Sendable {
    case conversation
    case workbench

    var id: Self { self }

    var title: String {
        switch self {
        case .conversation: return "对话"
        case .workbench: return "工作台"
        }
    }

    var icon: String {
        switch self {
        case .conversation: return "bubble.left"
        case .workbench: return "square.grid.2x2"
        }
    }
}

/// 顶部“对话 / 工作台”切换器的展示策略。原生 App / 资源 sheet 会在自己的
/// hosting controller 内接管同款 Picker；底层根视图必须隐藏，避免两份控件并存。
enum ConversationTaskSurfaceSwitcherPolicy {
    static func hides(
        featureEnabled: Bool,
        isRegularLayout: Bool,
        hasPresentedPage: Bool,
        hasEmbeddedAppHome: Bool,
        hasEmbeddedPath: Bool
    ) -> Bool {
        !featureEnabled
            || hasPresentedPage
            || (isRegularLayout && (hasEmbeddedAppHome || hasEmbeddedPath))
    }
}

/// iPhone 窄屏下的工作台对话 overlay 档位。独立全屏对话由
/// ``ConversationTaskSurface.conversation`` 表达，不复用 overlay detent。
enum ConversationLayerDetent: CaseIterable, Equatable, Sendable {
    case collapsed
    case sheet
    case expanded
}

enum ConversationLayerGeometry {
    static let collapsedTopRatio: CGFloat = 1
    static let sheetTopRatio: CGFloat = 0.52
    static let expandedTopRatio: CGFloat = 0.09
    static let flingPointsPerMillisecond: CGFloat = 0.55

    static func topRatio(for detent: ConversationLayerDetent) -> CGFloat {
        switch detent {
        case .collapsed: return collapsedTopRatio
        case .sheet: return sheetTopRatio
        case .expanded: return expandedTopRatio
        }
    }

    static func clamp(_ topRatio: CGFloat) -> CGFloat {
        min(collapsedTopRatio, max(expandedTopRatio, topRatio))
    }

    static func settle(
        topRatio: CGFloat,
        velocityPointsPerMillisecond: CGFloat,
        allowsExpanded: Bool
    ) -> ConversationLayerDetent {
        let position = clamp(topRatio)
        if abs(velocityPointsPerMillisecond) > flingPointsPerMillisecond {
            if velocityPointsPerMillisecond < 0 {
                return allowsExpanded && position <= sheetTopRatio ? .expanded : .sheet
            }
            return position >= sheetTopRatio ? .collapsed : .sheet
        }
        let candidates: [ConversationLayerDetent] = allowsExpanded
            ? ConversationLayerDetent.allCases
            : [.collapsed, .sheet]
        return candidates.min {
            abs(self.topRatio(for: $0) - position) < abs(self.topRatio(for: $1) - position)
        } ?? .collapsed
    }

    static func progress(topRatio: CGFloat) -> CGFloat {
        let travel = collapsedTopRatio - expandedTopRatio
        guard travel > 0 else { return 0 }
        return min(1, max(0, (collapsedTopRatio - clamp(topRatio)) / travel))
    }

    /// 可见区高度要把 Home Indicator 的安全区纳入不透明 surface；收起态仍保持零高度。
    static func visibleHeight(
        viewportHeight: CGFloat,
        bottomSafeAreaInset: CGFloat,
        topRatio: CGFloat
    ) -> CGFloat {
        let position = clamp(topRatio)
        guard position < collapsedTopRatio else { return 0 }
        let contentHeight = max(0, viewportHeight) * (1 - position)
        return contentHeight + max(0, bottomSafeAreaInset)
    }

    /// 稳定档位下，对话树本身按可见 surface 高度布局。
    /// 这与只把 full-height 内容从底部裁出来不同：消息列表与 Composer 会收到真实可用高度。
    static func steadyContentLayoutHeight(
        viewportHeight: CGFloat,
        bottomSafeAreaInset: CGFloat,
        detent: ConversationLayerDetent
    ) -> CGFloat {
        visibleHeight(
            viewportHeight: viewportHeight,
            bottomSafeAreaInset: bottomSafeAreaInset,
            topRatio: topRatio(for: detent)
        )
    }

    /// 拖动时固定给重型对话树 expanded 档位的布局提案，只让外层裁剪跟手；
    /// 手势结束后再一次切回目标稳定档位的真实高度。
    static func contentLayoutHeight(
        viewportHeight: CGFloat,
        bottomSafeAreaInset: CGFloat,
        detent: ConversationLayerDetent,
        isDragging: Bool
    ) -> CGFloat {
        steadyContentLayoutHeight(
            viewportHeight: viewportHeight,
            bottomSafeAreaInset: bottomSafeAreaInset,
            detent: isDragging ? .expanded : detent
        )
    }
}

/// Size-class 分桶：分屏比例等本地偏好按桶持久化，避免 iPhone↔iPad 互相覆盖。
enum TaskSurfaceSizeClassBucket: String, Sendable {
    case compact
    case regular

    static func resolve(isRegularWidth: Bool) -> Self {
        isRegularWidth ? .regular : .compact
    }
}

/// 分屏几何常量（与 Electron / 审计方案对齐）。
enum TaskSurfaceSplitMetrics {
    static let defaultWorkbenchFraction: Double = 0.4
    static let minWorkbenchFraction: Double = 0.25
    static let maxWorkbenchFraction: Double = 0.55
    static let minWorkbenchWidth: CGFloat = 320
    static let maxWorkbenchWidth: CGFloat = 480
    /// 分隔条触达宽度（视觉线更细，命中区满足 44pt 高度、足够水平拖拽）。
    static let dividerHitWidth: CGFloat = 16

    static func workbenchWidth(
        availableWidth: CGFloat,
        fraction: Double
    ) -> CGFloat {
        let clampedFraction = min(
            maxWorkbenchFraction,
            max(minWorkbenchFraction, fraction)
        )
        let ideal = availableWidth * CGFloat(clampedFraction)
        let upper = min(maxWorkbenchWidth, availableWidth * CGFloat(maxWorkbenchFraction))
        return min(upper, max(minWorkbenchWidth, ideal))
    }

    static func appStorageKey(for bucket: TaskSurfaceSizeClassBucket) -> String {
        "tt.taskSurface.workbenchFraction.\(bucket.rawValue)"
    }
}

/// 胶囊呈现形态。移动端屏幕小，空闲时收成辅助触控式小圆环而不是整条占位。
enum AgentCapsulePresentation: Equatable, Sendable {
    /// 当前布局不该出现胶囊（对话面、iPad 分屏等）。
    case hidden
    /// 微缩态：浮在内容之上的小圆环，不占布局，仅保留「回对话 / 语音」入口。
    case mini
    /// 完整态：底部状态条，展示阶段文案、副标题与待办进度。
    case full
}

/// Agent 胶囊可见性信息。视图层只消费，不各自判定布局/运行态。
struct AgentCapsuleVisibilityInfo: Equatable, Sendable {
    let presentation: AgentCapsulePresentation
    let agentName: String
    /// 与 Electron / 我的 Agent 共用的 `avatar_key`；优先于 URL。
    let avatarKey: String?
    let avatarURL: String?
    let runState: AgentRunPresentationState
    let completedTodoCount: Int
    let totalTodoCount: Int
    let pendingApproval: Bool
    let pendingAnswer: Bool

    /// 当前布局 + 运行态下是否有任何形态的胶囊。
    var shouldShow: Bool { presentation != .hidden }

    init(
        presentation: AgentCapsulePresentation,
        agentName: String,
        avatarKey: String? = nil,
        avatarURL: String? = nil,
        runState: AgentRunPresentationState,
        completedTodoCount: Int,
        totalTodoCount: Int,
        pendingApproval: Bool = false,
        pendingAnswer: Bool = false
    ) {
        self.presentation = presentation
        self.agentName = agentName
        self.avatarKey = avatarKey
        self.avatarURL = avatarURL
        self.runState = runState
        self.completedTodoCount = completedTodoCount
        self.totalTodoCount = totalTodoCount
        self.pendingApproval = pendingApproval
        self.pendingAnswer = pendingAnswer
    }
}

/// 胶囊运行态门闩：委托跨端 TaskCapsule 视觉决策。
///
/// 仅 `ready` → mini；未读 `complete`、`paused` 及其余活跃/终态 → full。
/// 移动端遮挡代价高，故待命收成小圆环，但**不隐藏**——否则工作台无回对话/语音入口。
enum AgentCapsuleRunStateGate {
    static func presentation(
        for runState: AgentRunPresentationState,
        pendingApproval: Bool = false,
        pendingAnswer: Bool = false
    ) -> AgentCapsulePresentation {
        let status = TaskCapsuleStatus.resolve(
            TaskCapsuleStatus.input(
                from: runState,
                queuedCount: runState.queuedCount,
                pendingApproval: pendingApproval,
                pendingAnswer: pendingAnswer
            )
        )
        switch TaskCapsuleStatus.resolveVisual(status) {
        case .mini: return .mini
        case .full: return .full
        case .hidden: return .hidden
        }
    }
}

/// 语音输入请求来源：胶囊直发 vs Composer 填入。
enum VoiceInputRequest: Equatable, Sendable {
    case capsule
    case composer

    var prefersDirectSend: Bool {
        switch self {
        case .capsule: return true
        case .composer: return false
        }
    }
}

// MARK: - Coordinator

/// Per-session 跨工作面共享状态。由 ``ConversationScreen`` 持有并通过 `.environment` 注入。
///
/// 并行协作契约：工作台侧（胶囊 / 加入对话等）只读本类型，不要在 Screen 里另造平行状态机。
@MainActor
@Observable
final class TaskSurfaceCoordinator {
    /// 持久化作用域（通常为 sessionId；草稿期为 `draft:<workspaceId>`）。
    private(set) var persistenceKey: String

    /// iPad regular 三态。
    private(set) var viewMode: TaskViewMode

    /// iPad regular app-focus 上的临时对话呈现；不参与持久化。
    private(set) var regularFloatingConversationPresentation: RegularFloatingConversationPresentation
    private(set) var regularFloatingConversationOwner: RegularFloatingConversationOwner?

    /// iPhone / compact 双态。
    private(set) var compactSurface: ConversationTaskSurface

    /// compact 进入过工作台后，对话由连续层位置承载；档位与连续位置分开保存，拖动中不抢胶囊手势。
    private(set) var conversationLayerDetent: ConversationLayerDetent
    private(set) var conversationLayerTopRatio: CGFloat
    private(set) var conversationLayerIsDragging = false
    private var conversationLayerDragStartTopRatio: CGFloat?
    private var conversationLayerDragOriginDetent: ConversationLayerDetent?

    /// 是否曾经挂载过工作台（懒加载门闩，对齐 compact 既有语义）。
    private(set) var hasPresentedWorkbench: Bool

    /// 「回到对话并定位到某轮次」的挂起意图；Screen 消费后应 ``clearPendingFocusMessageId()``。
    private(set) var pendingFocusMessageId: String?

    /// Composer 兼容路径请求语音 sheet；胶囊真·按住说话不再走此入口。
    private(set) var voiceInputRequest: VoiceInputRequest?
    /// 最近一次语音指令派发回执（已保存 / 已排队 / 已送达 / 阻断）。
    private(set) var lastVoiceDispatchReceipt: QueuedSendReceipt?
    /// 等待 ACK 推进到「已送达」的队列项；与胶囊回执绑定。
    private(set) var pendingVoiceQueueId: String?
    /// 当前工作台 Focus 投影缓存；发送时由 Screen 冻结进队列。
    private(set) var currentFocusSnapshot: FocusSnapshot?

    /// morph ghost 播放期间隐藏实体胶囊，避免与 ghost 重叠。
    private(set) var hidesCapsuleForMorph = false

    /// 兼容旧 Bool 观察点。
    var wantsVoiceInput: Bool { voiceInputRequest != nil }

    /// 与 ``ConversationTaskWorkspace`` 当前布局桶对齐（宽屏不足 760 时仍视为 compact）。
    private(set) var isCompactLayout = true

    // MARK: Capsule feed（由 Screen 根据 ViewModel 刷新）

    private(set) var capsuleAgentName: String = "Agent"
    private(set) var capsuleAvatarKey: String?
    private(set) var capsuleAvatarURL: String?
    private(set) var capsuleRunState: AgentRunPresentationState = .idle
    private(set) var completedTodoCount: Int = 0
    private(set) var totalTodoCount: Int = 0
    /// HITL 细分：工作台聚焦时胶囊需区分 needsApproval / needsAnswer。
    private(set) var capsulePendingApproval = false
    private(set) var capsulePendingAnswer = false

    private static let viewModeDefaultsPrefix = "tt.taskSurface.viewMode."

    init(persistenceKey: String) {
        self.persistenceKey = persistenceKey
        self.viewMode = Self.loadViewMode(for: persistenceKey) ?? .chatFocus
        self.regularFloatingConversationPresentation = .closed
        self.regularFloatingConversationOwner = nil
        self.compactSurface = .conversation
        self.conversationLayerDetent = .collapsed
        self.conversationLayerTopRatio = ConversationLayerGeometry.collapsedTopRatio
        self.hasPresentedWorkbench = false
    }

    var isConversationLayerActive: Bool {
        isCompactLayout && hasPresentedWorkbench && compactSurface == .workbench
    }

    /// 所有 overlay 档位都仍属于工作台；只有独立全屏工作面选中「对话」。
    var compactPickerSurface: ConversationTaskSurface {
        compactSurface
    }

    // MARK: Persistence key

    func updatePersistenceKey(_ key: String) {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != persistenceKey else { return }
        persistenceKey = trimmed
        closeRegularFloatingConversation()
        if let stored = Self.loadViewMode(for: trimmed) {
            viewMode = stored
        }
    }

    // MARK: Layout mutations

    func openRegularFloatingConversation() {
        guard !isCompactLayout, viewMode == .appFocus else { return }
        regularFloatingConversationPresentation = .floating
        regularFloatingConversationOwner = .rootAppFocus
    }

    /// full-screen App/detail 自己承载的对话浮窗。它不能改写底层 split/app-focus，
    /// 否则关闭 App 后用户会被带到错误的工作面。
    func openRegularPresentedPageFloatingConversation() {
        guard !isCompactLayout else { return }
        regularFloatingConversationPresentation = .floating
        regularFloatingConversationOwner = .presentedPage
    }

    func collapseRegularFloatingConversation() {
        closeRegularFloatingConversation()
    }

    func collapseRegularPresentedPageFloatingConversation() {
        guard regularFloatingConversationOwner == .presentedPage else { return }
        closeRegularFloatingConversation()
    }

    func collapseRegularRootFloatingConversation() {
        guard regularFloatingConversationOwner == .rootAppFocus else { return }
        closeRegularFloatingConversation()
    }

    func isRegularFloatingConversationPresented(
        in owner: RegularFloatingConversationOwner
    ) -> Bool {
        regularFloatingConversationPresentation == .floating
            && regularFloatingConversationOwner == owner
    }

    func backToSplitFromRegularFloatingConversation() {
        collapseRegularFloatingConversation()
        setViewMode(.split)
    }

    func setViewMode(_ mode: TaskViewMode) {
        if mode != .appFocus,
           regularFloatingConversationOwner == .rootAppFocus {
            closeRegularFloatingConversation()
        }
        if mode == .split || mode == .appFocus {
            hasPresentedWorkbench = true
        }
        viewMode = mode
        Self.persistViewMode(mode, for: persistenceKey)
        // 与 compact 表面粗同步：分屏不强制改 compact（旋转到窄屏仍默认对话更安全）。
        switch mode {
        case .chatFocus:
            compactSurface = .conversation
        case .appFocus:
            compactSurface = .workbench
        case .split:
            break
        }
    }

    func selectCompactSurface(_ surface: ConversationTaskSurface) {
        switch surface {
        case .workbench:
            hasPresentedWorkbench = true
            compactSurface = .workbench
            moveConversationLayer(to: .collapsed)
        case .conversation:
            // Picker 切换的是独立工作面；overlay 先归位，完整对话由根视图直接承载。
            compactSurface = .conversation
            moveConversationLayer(to: .collapsed)
        }
    }

    /// 统一入口：compact 改双态；regular（可分屏）映射到三态。
    /// - compact 上看工作台 → `.workbench`
    /// - regular 上看工作台 → 进入 `.split`（比直接 app-focus 更安全，见审计 §5.4）
    /// - 回对话 → compact `.conversation` / regular `.chatFocus`
    func selectSurface(_ surface: ConversationTaskSurface, isRegularSplitCapable: Bool) {
        if isRegularSplitCapable {
            switch surface {
            case .conversation:
                setViewMode(.chatFocus)
            case .workbench:
                if viewMode == .appFocus {
                    setViewMode(.appFocus)
                } else {
                    setViewMode(.split)
                }
            }
        } else {
            selectCompactSurface(surface)
        }
    }

    /// 打开工作台。
    /// - Parameters:
    ///   - isRegularSplitCapable: 当前是否处于可三态的 regular 宽屏；false 时只推进 compact 双态。
    ///   - preferringAppFocus: regular 下直接进应用聚焦（默认进分屏）。
    func presentWorkbench(
        isRegularSplitCapable: Bool,
        preferringAppFocus: Bool = false
    ) {
        hasPresentedWorkbench = true
        compactSurface = .workbench
        moveConversationLayer(to: .collapsed)
        guard isRegularSplitCapable else { return }
        if preferringAppFocus {
            setViewMode(.appFocus)
        } else if viewMode == .chatFocus {
            setViewMode(.split)
        }
        // 已在 split / appFocus：保持，仅确保 hasPresentedWorkbench。
    }

    /// 回到对话；可选定位到消息 row id（与 ``ConversationScreen`` 的 scroll/highlight 对齐）。
    func returnToConversation(focusingMessageId: String? = nil) {
        if viewMode == .appFocus || viewMode == .split {
            setViewMode(.chatFocus)
        } else {
            // 已在 chatFocus：仍持久化一次无妨
            viewMode = .chatFocus
            Self.persistViewMode(viewMode, for: persistenceKey)
        }
        if isCompactLayout, hasPresentedWorkbench {
            compactSurface = .workbench
            moveConversationLayer(to: .sheet)
        } else {
            compactSurface = .conversation
        }
        pendingFocusMessageId = focusingMessageId
    }

    // MARK: Compact conversation layer

    func moveConversationLayer(to detent: ConversationLayerDetent) {
        conversationLayerIsDragging = false
        conversationLayerDragStartTopRatio = nil
        conversationLayerDragOriginDetent = nil
        conversationLayerDetent = detent
        conversationLayerTopRatio = ConversationLayerGeometry.topRatio(for: detent)
    }

    func dragConversationLayer(by deltaPoints: CGFloat, viewportHeight: CGFloat) {
        guard isConversationLayerActive, viewportHeight > 1 else { return }
        if !conversationLayerIsDragging {
            conversationLayerDragOriginDetent = conversationLayerDetent
        }
        conversationLayerDragStartTopRatio = nil
        conversationLayerIsDragging = true
        conversationLayerTopRatio = ConversationLayerGeometry.clamp(
            conversationLayerTopRatio + deltaPoints / viewportHeight
        )
    }

    /// 抓手传累计 translation，避免 SwiftUI 视图随层移动后在本地坐标里重复累计位移。
    func dragConversationLayer(
        toTranslation translationPoints: CGFloat,
        viewportHeight: CGFloat
    ) {
        guard isConversationLayerActive, viewportHeight > 1 else { return }
        if conversationLayerDragStartTopRatio == nil {
            conversationLayerDragStartTopRatio = conversationLayerTopRatio
            conversationLayerDragOriginDetent = conversationLayerDetent
        }
        conversationLayerIsDragging = true
        conversationLayerTopRatio = ConversationLayerGeometry.clamp(
            (conversationLayerDragStartTopRatio ?? conversationLayerTopRatio)
                + translationPoints / viewportHeight
        )
    }

    @discardableResult
    func settleConversationLayer(velocityPointsPerSecond: CGFloat) -> ConversationLayerDetent {
        let allowsExpanded = (conversationLayerDragOriginDetent ?? conversationLayerDetent) != .collapsed
        let target = ConversationLayerGeometry.settle(
            topRatio: conversationLayerTopRatio,
            velocityPointsPerMillisecond: velocityPointsPerSecond / 1_000,
            allowsExpanded: allowsExpanded
        )
        moveConversationLayer(to: target)
        return target
    }

    func conversationLayerCollapseTarget() -> ConversationLayerDetent? {
        switch conversationLayerDetent {
        case .expanded: return .sheet
        case .sheet: return .collapsed
        case .collapsed: return nil
        }
    }

    func conversationLayerExpandTarget() -> ConversationLayerDetent? {
        switch conversationLayerDetent {
        case .collapsed: return .sheet
        case .sheet: return .expanded
        case .expanded: return nil
        }
    }

    /// 层外背景是回程门：半屏一步收起；expanded card 先退半屏。
    func collapseConversationLayerFromBackdrop() {
        guard let target = conversationLayerCollapseTarget() else { return }
        moveConversationLayer(to: target)
    }

    func clearPendingFocusMessageId() {
        pendingFocusMessageId = nil
    }

    func requestVoiceInput(_ request: VoiceInputRequest = .capsule) {
        voiceInputRequest = request
    }

    func clearVoiceInputRequest() {
        voiceInputRequest = nil
    }

    func updateFocusSnapshot(_ snapshot: FocusSnapshot?) {
        currentFocusSnapshot = snapshot
    }

    func recordVoiceDispatchReceipt(_ receipt: QueuedSendReceipt) {
        lastVoiceDispatchReceipt = receipt
        pendingVoiceQueueId = receipt.queueId
    }

    /// ACK 后把同一条胶囊指令的回执推进到已送达 / 失败。
    func advanceVoiceDispatchReceipt(queueId: String, to receipt: QueuedSendReceipt) {
        guard pendingVoiceQueueId == queueId else { return }
        lastVoiceDispatchReceipt = receipt
        switch receipt {
        case .accepted, .failed, .blocked:
            pendingVoiceQueueId = nil
        case .persisted, .queued:
            pendingVoiceQueueId = receipt.queueId
        }
    }

    func clearVoiceDispatchReceipt() {
        lastVoiceDispatchReceipt = nil
        pendingVoiceQueueId = nil
    }

    /// 由 ``ConversationTaskWorkspace`` 在几何变化时回写，供胶囊可见性与布局桶一致。
    func updateLayoutContext(isCompactLayout: Bool) {
        let wasCompact = self.isCompactLayout
        self.isCompactLayout = isCompactLayout
        if isCompactLayout {
            closeRegularFloatingConversation()
        }
        guard isCompactLayout, !wasCompact, hasPresentedWorkbench else { return }
        moveConversationLayer(to: .collapsed)
    }

    private func closeRegularFloatingConversation() {
        regularFloatingConversationPresentation = .closed
        regularFloatingConversationOwner = nil
    }

    // MARK: Visibility

    func shouldMountWorkbench(isCompactLayout: Bool) -> Bool {
        if isCompactLayout {
            return hasPresentedWorkbench || compactSurface == .workbench
        }
        switch viewMode {
        case .chatFocus:
            // 保活：曾打开过则挂载但隐藏（对齐 compact opacity 策略）；否则不挂载。
            return hasPresentedWorkbench
        case .split, .appFocus:
            return true
        }
    }

    func isWorkbenchVisible(isCompactLayout: Bool) -> Bool {
        if isCompactLayout {
            if hasPresentedWorkbench { return compactSurface == .workbench }
            return compactSurface == .workbench
        }
        switch viewMode {
        case .chatFocus: return false
        case .split, .appFocus: return true
        }
    }

    func isConversationVisible(isCompactLayout: Bool) -> Bool {
        if isCompactLayout {
            if hasPresentedWorkbench, compactSurface == .workbench {
                return conversationLayerDetent != .collapsed
            }
            return compactSurface == .conversation
        }
        switch viewMode {
        case .chatFocus, .split: return true
        case .appFocus: return false
        }
    }

    /// 胶囊呈现形态。
    /// - compact：仅工作台面（含资源详情；对话面已有 HITL/composer，不重复）
    /// - regular split：隐藏（对话栏并排，胶囊纯属遮挡）
    /// - regular app-focus：显示
    /// - 形态由运行态决定：见 ``AgentCapsuleRunStateGate``
    func capsuleVisibility(
        isCompactLayout: Bool,
        forcesWorkbenchVisibility: Bool = false
    ) -> AgentCapsuleVisibilityInfo {
        let layoutAllows: Bool
        if !isCompactLayout, regularFloatingConversationPresentation == .floating {
            // regular app-focus 里小窗与胶囊二选一，顶层强制宿主也不能重复显示。
            layoutAllows = false
        } else if forcesWorkbenchVisibility {
            // 系统 sheet 已盖住 regular split 的对话栏；顶层仍必须保留胶囊。
            layoutAllows = true
        } else if isCompactLayout {
            layoutAllows = hasPresentedWorkbench
                ? compactSurface == .workbench && conversationLayerDetent == .collapsed
                : compactSurface == .workbench
        } else {
            layoutAllows = viewMode == .appFocus
        }
        let presentation: AgentCapsulePresentation = layoutAllows
            ? AgentCapsuleRunStateGate.presentation(
                for: capsuleRunState,
                pendingApproval: capsulePendingApproval,
                pendingAnswer: capsulePendingAnswer
            )
            : .hidden
        return AgentCapsuleVisibilityInfo(
            presentation: presentation,
            agentName: capsuleAgentName,
            avatarKey: capsuleAvatarKey,
            avatarURL: capsuleAvatarURL,
            runState: capsuleRunState,
            completedTodoCount: completedTodoCount,
            totalTodoCount: totalTodoCount,
            pendingApproval: capsulePendingApproval,
            pendingAnswer: capsulePendingAnswer
        )
    }

    /// 使用最近一次 ``updateLayoutContext`` 的布局桶。
    func capsuleVisibility(forcesWorkbenchVisibility: Bool = false) -> AgentCapsuleVisibilityInfo {
        capsuleVisibility(
            isCompactLayout: isCompactLayout,
            forcesWorkbenchVisibility: forcesWorkbenchVisibility
        )
    }

    // MARK: Capsule feed

    func updateCapsuleFeed(
        agentName: String,
        avatarKey: String? = nil,
        avatarURL: String? = nil,
        runState: AgentRunPresentationState,
        completedTodoCount: Int,
        totalTodoCount: Int,
        pendingApproval: Bool = false,
        pendingAnswer: Bool = false
    ) {
        capsuleAgentName = agentName
        capsuleAvatarKey = avatarKey
        capsuleAvatarURL = avatarURL
        capsuleRunState = runState
        self.completedTodoCount = completedTodoCount
        self.totalTodoCount = totalTodoCount
        capsulePendingApproval = pendingApproval
        capsulePendingAnswer = pendingAnswer
    }

    func setHidesCapsuleForMorph(_ hide: Bool) {
        hidesCapsuleForMorph = hide
    }

    // MARK: UserDefaults (view mode per session)

    private static func viewModeKey(for persistenceKey: String) -> String {
        viewModeDefaultsPrefix + persistenceKey
    }

    private static func loadViewMode(for persistenceKey: String) -> TaskViewMode? {
        guard let raw = UserDefaults.standard.string(forKey: viewModeKey(for: persistenceKey)) else {
            return nil
        }
        return TaskViewMode(rawValue: raw)
    }

    private static func persistViewMode(_ mode: TaskViewMode, for persistenceKey: String) {
        UserDefaults.standard.set(mode.rawValue, forKey: viewModeKey(for: persistenceKey))
    }

    /// 测试辅助：清掉某 key 的持久化，避免用例互相污染。
    static func resetPersistence(for persistenceKey: String) {
        UserDefaults.standard.removeObject(forKey: viewModeKey(for: persistenceKey))
    }
}
