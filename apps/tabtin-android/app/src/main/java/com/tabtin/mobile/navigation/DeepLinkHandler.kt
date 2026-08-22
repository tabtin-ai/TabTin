package com.tabtin.mobile.navigation

import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class DeepLinkHandler @Inject constructor(
    private val tokenManager: TokenManager,
) {
    private val _pendingInviteToken = MutableStateFlow<String?>(null)
    public val pendingInviteToken: StateFlow<String?> = _pendingInviteToken.asStateFlow()

    /**
     * Wave 3 (X3) — rich_content resource_ref 点击 → tabtin://resource/<type>/<id>
     * 的"目标资源"事件。
     *
     * **冷启动事件丢失问题**（独立验证发现）：原实现用 `MutableSharedFlow(replay=0,
     * extraBufferCapacity=1)`，外部（浏览器/聊天复制粘贴）冷启动 app 时，
     * `MainActivity.onCreate → handleIntent → emit` 发生在 `setContent { AppNavigation }`
     * 之前；emit 进 buffer 后 `replay=0` 不回放给晚到的 collector，导致用户看不到任何反馈。
     *
     * **修复（与 invite token 同模式）**：改成 `StateFlow<ResourceTarget?>`，发后置值，
     * 处理后由消费者调 `consumeResourceNavigation()` 复位为 `null`。三个理由：
     *   1. **冷启动安全**：StateFlow 保留 last value，晚到 collector 立刻拿到
     *   2. **Compose 友好**：`collectAsState` + `LaunchedEffect(target)` 一步解决，无需
     *      `LaunchedEffect(Unit) { collect { ... } }` 套路
     *   3. **去重合理**：StateFlow distinctUntilChanged 让同 target 连点两次 + 中间
     *      `null` 复位 → 最终只一次 Toast；与三视角 Review 标的"连续 Toast 重叠 🟡"
     *      诉求一致（之前 SharedFlow 会重叠）
     *
     * 不持久化（不像 invite 需要跨 process restart）——用户主动 tap 是 UI 即时事件，
     * 进程死了再起就丢，符合直觉。
     */
    private val _pendingResourceNavigation = MutableStateFlow<ResourceTarget?>(null)
    public val pendingResourceNavigation: StateFlow<ResourceTarget?> =
        _pendingResourceNavigation.asStateFlow()

    /**
     *  远程推送点击 → 跳转目标会话。PushService 解析系统推送数据负载里的
     * ext JSON（workspace_id，兼容旧 space_id）后
     * 调 emitConversationNavigation，由 AppNavigation 消费导航到 ChatSessionRoute，
     * 与 iOS PushService.handleNotificationExt → MainRouter.openConversation 对齐。
     *
     * 用 StateFlow 而非 SharedFlow 的理由同 resource 导航：冷启动（点推送拉起进程）时
     * emit 发生在 AppNavigation 组装之前，StateFlow 保留 last value 让晚到 collector 拿到。
     */
    private val _pendingConversationNavigation = MutableStateFlow<ConversationTarget?>(null)
    public val pendingConversationNavigation: StateFlow<ConversationTarget?> =
        _pendingConversationNavigation.asStateFlow()

    private val _pendingImConversationNavigation = MutableStateFlow<ImConversationTarget?>(null)
    public val pendingImConversationNavigation: StateFlow<ImConversationTarget?> =
        _pendingImConversationNavigation.asStateFlow()

    init {
        tokenManager.pendingInviteToken?.let { persisted ->
            _pendingInviteToken.value = persisted
        }
    }

    public fun setPendingToken(token: String) {
        _pendingInviteToken.value = token
        tokenManager.pendingInviteToken = token
    }

    public fun consumeInviteToken(): String? {
        val token = _pendingInviteToken.value
        _pendingInviteToken.value = null
        tokenManager.pendingInviteToken = null
        return token
    }

    /**
     * 由 MainActivity 在收到 tabtin://resource/<type>/<id> 时调用。
     * 直接覆盖 value——重复 emit 同一 target 时 distinctUntilChanged 会合并，
     * 但只要消费者在 LaunchedEffect 里处理完调 consumeResourceNavigation()
     * 复位为 null，下一次 emit 同 target 还是会触发（null → T(a) 是变化）。
     */
    public fun emitResourceNavigation(
        resourceType: String,
        resourceId: String,
        title: String? = null,
        locationHint: String? = null,
        spaceId: String? = null,
        organizationId: String? = null,
    ) {
        _pendingResourceNavigation.value = ResourceTarget(
            resourceType = resourceType,
            resourceId = resourceId,
            title = title,
            locationHint = locationHint,
            spaceId = spaceId,
            organizationId = organizationId,
        )
    }

    /**
     * 由 AppNavigation 的 LaunchedEffect 在 Toast 显示完后调用，复位 StateFlow
     * 防止后续重组重复触发。`pendingResourceNavigation` 是 hot StateFlow，没有
     * "已消费"内置语义，需要应用层显式复位。
     */
    public fun consumeResourceNavigation() {
        _pendingResourceNavigation.value = null
    }

    /** 由 PushService 在解析出推送 ext 的会话目标后调用。 */
    public fun emitConversationNavigation(
        workspaceId: String,
        organizationId: String,
        sessionId: String? = null,
        projectId: String? = null,
    ) {
        _pendingConversationNavigation.value = ConversationTarget(
            workspaceId = workspaceId,
            organizationId = organizationId,
            sessionId = sessionId,
            projectId = projectId,
        )
    }

    /** 由 AppNavigation 的 LaunchedEffect 在导航后调用，复位防重复触发。 */
    public fun consumeConversationNavigation() {
        _pendingConversationNavigation.value = null
    }

    public fun emitImConversationNavigation(
        conversationId: String,
        organizationId: String,
    ) {
        _pendingImConversationNavigation.value = ImConversationTarget(
            conversationId = conversationId,
            organizationId = organizationId,
        )
    }

    public fun consumeImConversationNavigation() {
        _pendingImConversationNavigation.value = null
    }
}

/**
 * ：推送点击的会话跳转目标。session_id 可空——后端可能只给到 Workspace 级
 * （首个/最近会话由目标屏兜底），与 iOS ConversationTarget 语义一致。
 */
public data class ConversationTarget(
    val workspaceId: String,
    val organizationId: String,
    val sessionId: String? = null,
    val projectId: String? = null,
)

public data class ImConversationTarget(
    val conversationId: String,
    val organizationId: String,
)

/**
 * Wave 3 (X3)：资源跳转目标载体。当前仅 type + id；未来若需要带 query / source space
 * 等额外参数可在此扩展，不影响 emit 端调用形态。
 */
public data class ResourceTarget(
    val resourceType: String,
    val resourceId: String,
    val title: String? = null,
    val locationHint: String? = null,
    val spaceId: String? = null,
    val organizationId: String? = null,
)
