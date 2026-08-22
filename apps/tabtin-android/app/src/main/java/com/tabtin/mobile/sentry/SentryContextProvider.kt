package com.tabtin.mobile.sentry

import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.util.TokenManager
import io.sentry.Sentry
import io.sentry.protocol.User
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Sentry scope 的唯一写入点。
 *
 * 契约「每端一个 context provider」：字段随状态变化统一写入 scope，业务代码
 * （catch 块 / Compose UI）不直接调 `Sentry.setTag`。`organization_id` 被动订阅
 * [OrganizationRepository.selectedOrganization]（Hilt Singleton StateFlow，与
 * [com.tabtin.mobile.util.AppLifecycleManager] 同款 `CoroutineScope` 订阅手法）；
 * 用户态无对应 Flow（[TokenManager] 是命令式 SecureStorage 读写），改在
 * [com.tabtin.mobile.data.repository.AuthRepository] 的登录成功 / 登出处显式调用
 * [applyUser] / [clearUser]；`space_id` 由 `ConversationViewModel` 在
 * `loadSession`/`onCleared` 显式调用（对齐 iOS `startSession`/`stopSession`）。
 */
@Singleton
public class SentryContextProvider @Inject constructor(
    private val tokenManager: TokenManager,
    private val organizationRepository: OrganizationRepository,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val clientInstallId: String = tokenManager.deviceId
    private var organizationId: String? = null
    private var activeSpaceId: String? = null

    /** 在 [SentryReporter.init] 之后调用一次（`TabTinApp.onCreate`）。 */
    public fun start() {
        applyTabtinContext()

        // 冷启动持久化会话：TokenManager 已缓存上次登录的 user_id/昵称，不用等
        // fetchProfile() 网络返回才有 user context（[AuthRepository] 命令式读写，
        // 无登录态 Flow 可被动订阅，这里做一次 best-effort 补齐）。
        tokenManager.userId?.let { userId -> applyUser(userId, tokenManager.userNickname) }

        scope.launch {
            organizationRepository.selectedOrganization.collect { organization ->
                organizationId = organization?.id
                DiagnosticRuntime.updateOrganization(organizationId)
                applyTabtinContext()
            }
        }
    }

    /** 登录成功 / profile 拉取成功后调用，只上传内部 ID。 */
    public fun applyUser(userId: String, nickname: String?) {
        val user = User().apply {
            this.id = userId
        }
        Sentry.setUser(user)
    }

    /** 登出后调用（[com.tabtin.mobile.data.repository.AuthRepository.logout]）。 */
    public fun clearUser() {
        Sentry.setUser(null)
    }

    /** 进入会话所属 Space 时调用（`ConversationViewModel.loadSession`）。 */
    public fun setActiveSpace(spaceId: String?) {
        activeSpaceId = spaceId?.takeIf { it.isNotEmpty() }
        applyTabtinContext()
    }

    /** 离开会话时调用（`ConversationViewModel.onCleared`）。 */
    public fun clearActiveSpace() {
        setActiveSpace(null)
    }

    private fun applyTabtinContext() {
        val context = mutableMapOf(
            "client_install_id" to clientInstallId,
            "app_version" to BuildConfig.VERSION_NAME,
            "build_number" to BuildConfig.VERSION_CODE.toString(),
            "platform" to "android",
        )
        BuildConfig.TABTIN_GIT_SHA.takeIf { it.isNotEmpty() }?.let { context["git_sha"] = it }
        organizationId?.let { context["organization_id"] = it }
        activeSpaceId?.let { context["space_id"] = it }
        Sentry.configureScope { sentryScope -> sentryScope.setContexts("tabtin", context) }
    }
}
