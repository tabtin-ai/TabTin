package com.tabtin.mobile.features.profile

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.data.api.resolveEffectiveApiBaseUrl
import com.tabtin.mobile.data.api.resolveEffectiveCentrifugoWsUrl
import com.tabtin.mobile.data.api.resolveEffectiveWebBaseUrl
import com.tabtin.mobile.data.api.resolveEffectiveWsBaseUrl
import com.tabtin.mobile.data.model.PendingInvitation
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.OrganizationRole
import com.tabtin.mobile.data.repository.AuthRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.ui.theme.AppLanguage
import com.tabtin.mobile.ui.theme.LanguageManager
import com.tabtin.mobile.ui.theme.TTColorSchemeId
import com.tabtin.mobile.ui.theme.ThemeManager
import com.tabtin.mobile.ui.theme.ThemeMode
import com.tabtin.mobile.util.TokenManager
import com.tabtin.mobile.sentry.SentryReporter
import com.tabtin.mobile.data.api.UploadScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.net.URI
import javax.inject.Inject

public data class ProfileUiState(
    val userId: String? = null,
    val nickname: String? = null,
    val username: String? = null,
    val phone: String? = null,
    val email: String? = null,
    val avatar: String? = null,
    val deviceId: String = "",
    val bio: String? = null,
    val dateJoined: String? = null,
    val lastLogin: String? = null,
    val loginCount: Int? = null,
    val isVerifiedEmail: Boolean? = null,
    val isVerifiedPhone: Boolean? = null,
)

public object ProfileUpdateBus {
    private val _updates = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    public val updates: SharedFlow<Unit> = _updates.asSharedFlow()
    public fun notifyUpdate() { _updates.tryEmit(Unit) }
}

public data class DebugEnvironmentUiState(
    val preset: String = "development",
    val customBaseUrl: String = "",
    val advancedEnabled: Boolean = false,
    val advancedApiUrl: String = "",
    val advancedWsUrl: String = "",
    val advancedWebUrl: String = "",
    val advancedCentrifugoUrl: String = "",
    val effectiveApiUrl: String = BuildConfig.API_BASE_URL,
    val effectiveImApiUrl: String = BuildConfig.API_BASE_URL,
    val effectiveWsUrl: String = BuildConfig.WS_BASE_URL,
    val effectiveWebUrl: String = BuildConfig.WEB_BASE_URL,
    val effectiveCentrifugoUrl: String = BuildConfig.CENTRIFUGO_WS_URL,
    val sentryDsn: String = "",
)

/** Debug 面板提交的整组环境配置，四条网络链路同一次切换，避免前后端环境串线。 */
public data class DebugEnvironmentDraft(
    val preset: String,
    val customBaseUrl: String,
    val advancedEnabled: Boolean,
    val advancedApiUrl: String,
    val advancedWsUrl: String,
    val advancedWebUrl: String,
    val advancedCentrifugoUrl: String,
    val sentryDsn: String,
)

@HiltViewModel
public class ProfileViewModel @Inject constructor(
    private val themeManager: ThemeManager,
    private val languageManager: LanguageManager,
    private val tokenManager: TokenManager,
    private val authRepository: AuthRepository,
    private val organizationRepository: OrganizationRepository,
    private val ossUploadService: com.tabtin.mobile.data.api.OSSUploadService,
) : ViewModel() {

    public val themeMode: StateFlow<ThemeMode> = themeManager.themeMode
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), ThemeMode.SYSTEM)
    public val colorSchemeId: StateFlow<TTColorSchemeId> = themeManager.colorSchemeId
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), themeManager.initialColorSchemeId)

    public val organizations: StateFlow<List<Organization>> = organizationRepository.organizations
    public val selectedOrganization: StateFlow<Organization?> = organizationRepository.selectedOrganization
    public val isOrganizationLoading: StateFlow<Boolean> = organizationRepository.isLoading
    public val organizationError: StateFlow<String?> = organizationRepository.error

    public var isSwitchingOrganization: String? by mutableStateOf<String?>(null)
        private set

    public var isCreatingOrganization: Boolean by mutableStateOf(false)
        private set

    public var pendingInvitations: List<PendingInvitation> by mutableStateOf<List<PendingInvitation>>(emptyList())
        private set

    public var respondingInvitationId: String? by mutableStateOf<String?>(null)
        private set

    public var currentLanguage: AppLanguage by mutableStateOf(languageManager.currentLanguage)
        private set

    public var currentOrganizationRole: OrganizationRole? by mutableStateOf(null)
        private set

    public var profileState: ProfileUiState by mutableStateOf(loadUserInfo())
        private set

    public var isLoading: Boolean by mutableStateOf(false)
        private set

    public var error: String? by mutableStateOf<String?>(null)
        private set

    public var debugEnvironment: DebugEnvironmentUiState by mutableStateOf(loadDebugEnvironment())
        private set

    init {
        fetchProfile()
        loadOrganizations()
        loadPendingInvitations()
        observeProfileUpdates()
        observeInvitationUpdates()
        observeSelectedOrganizationRole()
    }

    public fun clearError() { error = null }

    public fun applyDebugEnvironment(draft: DebugEnvironmentDraft): Boolean {
        if (!SentryReporter.applyDsn(draft.sentryDsn)) {
            error = "Sentry DSN 无效"
            return false
        }
        val current = debugEnvironment
        val networkChanged = draft.preset != current.preset ||
            draft.customBaseUrl != current.customBaseUrl ||
            draft.advancedEnabled != current.advancedEnabled ||
            draft.advancedApiUrl != current.advancedApiUrl ||
            draft.advancedWsUrl != current.advancedWsUrl ||
            draft.advancedWebUrl != current.advancedWebUrl ||
            draft.advancedCentrifugoUrl != current.advancedCentrifugoUrl
        if (!networkChanged) {
            debugEnvironment = loadDebugEnvironment()
            return true
        }
        val endpoints = resolveDebugEndpoints(draft) ?: return false
        tokenManager.saveDebugNetworkOverrides(
            apiBaseUrl = endpoints.api.takeUnless { it == BuildConfig.API_BASE_URL },
            wsBaseUrl = endpoints.websocket.takeUnless { it == BuildConfig.WS_BASE_URL },
            webBaseUrl = endpoints.web.takeUnless { it == BuildConfig.WEB_BASE_URL },
            centrifugoWsUrl = endpoints.centrifugo.takeUnless { it == BuildConfig.CENTRIFUGO_WS_URL },
        )
        tokenManager.saveDebugEnvironmentSettings(
            preset = draft.preset,
            customBaseUrl = draft.customBaseUrl,
            advancedEnabled = draft.advancedEnabled,
            advancedApiUrl = draft.advancedApiUrl,
            advancedWsUrl = draft.advancedWsUrl,
            advancedWebUrl = draft.advancedWebUrl,
            advancedCentrifugoUrl = draft.advancedCentrifugoUrl,
        )
        debugEnvironment = loadDebugEnvironment()
        viewModelScope.launch {
            kotlinx.coroutines.delay(350)
            kotlin.system.exitProcess(0)
        }
        return true
    }

    public fun resetDebugEnvironment() {
        SentryReporter.applyDsn("")
        tokenManager.saveDebugNetworkOverrides(
            apiBaseUrl = null,
            wsBaseUrl = null,
            webBaseUrl = null,
            centrifugoWsUrl = null,
        )
        tokenManager.clearDebugEnvironmentSettings()
        tokenManager.clearLegacyDebugNetworkOverridesIfNeeded()
        debugEnvironment = loadDebugEnvironment()
        viewModelScope.launch {
            kotlinx.coroutines.delay(350)
            kotlin.system.exitProcess(0)
        }
    }

    public fun setThemeMode(mode: ThemeMode) {
        viewModelScope.launch { themeManager.setThemeMode(mode) }
    }

    public fun setColorSchemeId(schemeId: TTColorSchemeId) {
        viewModelScope.launch { themeManager.setColorSchemeId(schemeId) }
    }

    public fun setLanguage(language: AppLanguage) {
        languageManager.setLanguage(language)
        currentLanguage = language
    }

    public fun refreshProfile() {
        fetchProfile()
        loadOrganizations()
        loadPendingInvitations()
    }

    public fun switchOrganization(organization: Organization) {
        if (isSwitchingOrganization != null) return
        isSwitchingOrganization = organization.id
        viewModelScope.launch {
            organizationRepository.selectOrganization(organization)
            isSwitchingOrganization = null
        }
    }

    public fun createOrganization(name: String, description: String, onSuccess: () -> Unit) {
        if (isCreatingOrganization || name.isBlank()) return
        isCreatingOrganization = true
        error = null
        viewModelScope.launch {
            try {
                val created = organizationRepository.createOrganization(
                    name = name.trim(),
                    description = description.trim().ifBlank { null },
                )
                organizationRepository.selectOrganization(created)
                onSuccess()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "创建组织失败"
            } finally {
                isCreatingOrganization = false
            }
        }
    }

    private fun loadOrganizations() {
        viewModelScope.launch {
            organizationRepository.loadOrganizations()
        }
    }

    private fun loadPendingInvitations() {
        viewModelScope.launch {
            organizationRepository.getMyPendingInvitations()
                .onSuccess { pendingInvitations = it }
        }
    }

    private fun observeInvitationUpdates() {
        viewModelScope.launch {
            organizationRepository.invitationUpdates.collect {
                loadPendingInvitations()
            }
        }
    }

    private fun observeSelectedOrganizationRole() {
        viewModelScope.launch {
            organizationRepository.selectedOrganization.collect { organization ->
                currentOrganizationRole = null
                val organizationId = organization?.id?.takeIf { it.isNotBlank() } ?: return@collect
                val userId = tokenManager.userId?.takeIf { it.isNotBlank() } ?: return@collect
                try {
                    val members = organizationRepository.loadMembers(organizationId)
                    currentOrganizationRole = members.firstOrNull { it.userId == userId }?.role
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    currentOrganizationRole = null
                }
            }
        }
    }

    public fun respondToInvitation(invitationId: String, accept: Boolean) {
        viewModelScope.launch {
            respondingInvitationId = invitationId
            organizationRepository.respondToInvitation(invitationId, accept)
                .onSuccess {
                    pendingInvitations = pendingInvitations.filter { it.id != invitationId }
                    respondingInvitationId = null
                    if (accept) {
                        loadOrganizations()
                    }
                }
                .onFailure { e ->
                    val msg = e.message ?: ""
                    if (msg.contains("INVITATION_INVALID") || msg.contains("INVITATION_NOT_FOUND") || msg.contains("INVITATION_EXPIRED")) {
                        pendingInvitations = pendingInvitations.filter { it.id != invitationId }
                        loadPendingInvitations()
                    } else {
                        error = msg
                    }
                    respondingInvitationId = null
                }
        }
    }

    public fun uploadAvatar(
        uri: android.net.Uri,
        resolver: android.content.ContentResolver,
        onComplete: (Boolean, String?) -> Unit = { _, _ -> },
    ) {
        viewModelScope.launch {
            try {
                // fileSize 必须是真实字节数：presign 配额校验和 PUT 的 Content-Length 都依赖它，
                // 传 0 会导致直传体长不匹配失败（历史 bug）。
                val fileSize = resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
                if (fileSize <= 0) {
                    onComplete(false, "无法读取图片文件")
                    return@launch
                }
                val contentType = resolver.getType(uri) ?: "image/jpeg"
                val ext = when (contentType) {
                    "image/png" -> "png"
                    "image/webp" -> "webp"
                    else -> "jpg"
                }
                val userId = tokenManager.userId.orEmpty()
                // 对齐 Electron UserAvatarUploader：module=user + context=avatar/userId，
                // 后端 UAVTR 按这组键管理头像 FileUsage 生命周期。
                val result = ossUploadService.directUploadFromUri(
                    uri = uri,
                    fileSize = fileSize,
                    fileName = "user-$userId-${System.currentTimeMillis()}.$ext",
                    contentType = contentType,
                    folder = "user-avatars",
                    scope = UploadScope(
                        module = "user",
                        contextType = "avatar",
                        contextId = userId,
                        organizationId = organizationRepository.selectedOrganization.value?.id.orEmpty(),
                        isPublic = true,
                    ),
                )
                authRepository.updateProfile(avatarFileId = result.fileId)
                    .onSuccess {
                        profileState = loadUserInfo()
                        ProfileUpdateBus.notifyUpdate()
                        onComplete(true, null)
                    }
                    .onFailure { onComplete(false, it.message) }
            } catch (e: Exception) {
                onComplete(false, e.message)
            }
        }
    }

    public fun updateProfile(
        nickname: String?,
        username: String?,
        bio: String?,
        onComplete: (Boolean, String?) -> Unit = { _, _ -> },
    ) {
        viewModelScope.launch {
            authRepository.updateProfile(nickname = nickname, username = username, bio = bio)
                .onSuccess {
                    profileState = loadUserInfo()
                    ProfileUpdateBus.notifyUpdate()
                    onComplete(true, null)
                }
                .onFailure {
                    onComplete(false, it.message)
                }
        }
    }

    private fun observeProfileUpdates() {
        viewModelScope.launch {
            ProfileUpdateBus.updates.collect {
                profileState = loadUserInfo()
            }
        }
    }

    private fun fetchProfile() {
        viewModelScope.launch {
            isLoading = true
            error = null
            authRepository.fetchProfile()
                .onSuccess { profileState = loadUserInfo() }
                .onFailure { error = it.message }
            isLoading = false
        }
    }

    private fun loadUserInfo(): ProfileUiState = ProfileUiState(
        userId = tokenManager.userId,
        nickname = tokenManager.userNickname,
        username = tokenManager.userUsername,
        phone = tokenManager.userPhone,
        email = tokenManager.userEmail,
        avatar = tokenManager.userAvatar,
        deviceId = tokenManager.deviceId,
        bio = tokenManager.userBio,
        dateJoined = tokenManager.userDateJoined,
        lastLogin = tokenManager.userLastLogin,
        loginCount = tokenManager.userLoginCount,
        isVerifiedEmail = tokenManager.userIsVerifiedEmail,
        isVerifiedPhone = tokenManager.userIsVerifiedPhone,
    )

    private fun loadDebugEnvironment(): DebugEnvironmentUiState {
        val api = resolveEffectiveApiBaseUrl(tokenManager)
        val ws = resolveEffectiveWsBaseUrl(tokenManager)
        val web = resolveEffectiveWebBaseUrl(tokenManager)
        val centrifugo = resolveEffectiveCentrifugoWsUrl(tokenManager)
        val storedPreset = tokenManager.debugEnvironmentPreset
        val inferredPreset = when {
            api == PRODUCTION_API_BASE_URL && ws == PRODUCTION_WS_BASE_URL -> PRESET_PRODUCTION
            api == DEVELOPMENT_API_BASE_URL && ws == DEVELOPMENT_WS_BASE_URL -> PRESET_DEVELOPMENT
            else -> PRESET_CUSTOM
        }
        return DebugEnvironmentUiState(
            preset = storedPreset ?: inferredPreset,
            customBaseUrl = tokenManager.debugCustomBaseUrl
                ?: api.removeSuffix("/api").takeIf { inferredPreset == PRESET_CUSTOM }.orEmpty(),
            advancedEnabled = tokenManager.debugAdvancedEnabled,
            advancedApiUrl = tokenManager.debugAdvancedApiUrl.orEmpty(),
            advancedWsUrl = tokenManager.debugAdvancedWsUrl.orEmpty(),
            advancedWebUrl = tokenManager.debugAdvancedWebUrl.orEmpty(),
            advancedCentrifugoUrl = tokenManager.debugAdvancedCentrifugoUrl.orEmpty(),
            effectiveApiUrl = api,
            effectiveImApiUrl = api,
            effectiveWsUrl = ws,
            effectiveWebUrl = web,
            effectiveCentrifugoUrl = centrifugo,
            sentryDsn = SentryReporter.storedDsn(),
        )
    }

    private fun resolveDebugEndpoints(draft: DebugEnvironmentDraft): DebugEndpoints? {
        val automatic = when (draft.preset) {
            PRESET_PRODUCTION -> productionEndpoints
            PRESET_DEVELOPMENT -> developmentEndpoints
            PRESET_CUSTOM -> endpointsFromCustomBase(draft.customBaseUrl) ?: run {
                error = "自定义基础地址无效"
                return null
            }
            else -> {
                error = "请选择环境"
                return null
            }
        }
        if (!draft.advancedEnabled) return automatic

        val overrides = listOf(
            Triple("API", draft.advancedApiUrl, setOf("http", "https")),
            Triple("任务 WebSocket", draft.advancedWsUrl, setOf("ws", "wss")),
            Triple("Web", draft.advancedWebUrl, setOf("http", "https")),
            Triple("消息实时连接", draft.advancedCentrifugoUrl, setOf("ws", "wss")),
        )
        for ((name, value, schemes) in overrides) {
            if (value.isNotBlank() && !isValidUrl(value, schemes)) {
                error = "$name 地址无效"
                return null
            }
        }
        return automatic.copy(
            api = draft.advancedApiUrl.trim().ifBlank { automatic.api },
            websocket = draft.advancedWsUrl.trim().ifBlank { automatic.websocket },
            web = draft.advancedWebUrl.trim().ifBlank { automatic.web },
            centrifugo = draft.advancedCentrifugoUrl.trim().ifBlank { automatic.centrifugo },
        )
    }

    private fun endpointsFromCustomBase(raw: String): DebugEndpoints? {
        val web = normalizedHttpBase(raw) ?: return null
        val httpScheme = URI(web).scheme.lowercase()
        val ws = web.replaceFirst(httpScheme, if (httpScheme == "https") "wss" else "ws")
        return DebugEndpoints(
            api = "$web/api",
            websocket = "$ws/ws/v1/gateway",
            web = web,
            centrifugo = "$ws/connection/websocket",
        )
    }

    private fun normalizedHttpBase(raw: String): String? = try {
        val uri = URI(raw.trim())
        val scheme = uri.scheme?.lowercase()
        if (scheme !in setOf("http", "https") || uri.rawAuthority.isNullOrBlank()) return null
        val path = uri.rawPath.orEmpty().trimEnd('/')
        "$scheme://${uri.rawAuthority}$path"
    } catch (_: Exception) {
        null
    }

    private fun isValidUrl(raw: String, schemes: Set<String>): Boolean = try {
        val uri = URI(raw.trim())
        uri.scheme?.lowercase() in schemes && !uri.host.isNullOrBlank()
    } catch (_: Exception) {
        false
    }

    private companion object {
        private const val PRESET_PRODUCTION = "production"
        private const val PRESET_DEVELOPMENT = "development"
        private const val PRESET_CUSTOM = "custom"
        private const val PRODUCTION_API_BASE_URL = "https://api.example.com/api"
        private const val PRODUCTION_WS_BASE_URL = "wss://api.example.com/ws/v1/gateway"
        private const val PRODUCTION_WEB_BASE_URL = "https://web.example.com"
        private const val PRODUCTION_CENTRIFUGO_WS_URL = "wss://centrifugo.example.com/connection/websocket"
        private const val DEVELOPMENT_API_BASE_URL = "https://api-test.example.com/api"
        private const val DEVELOPMENT_WS_BASE_URL = "wss://api-test.example.com/ws/v1/gateway"
        private const val DEVELOPMENT_WEB_BASE_URL = "https://web-test.example.com"
        private const val DEVELOPMENT_CENTRIFUGO_WS_URL = "wss://centrifugo-test.example.com/connection/websocket"

        private val productionEndpoints = DebugEndpoints(
            api = PRODUCTION_API_BASE_URL,
            websocket = PRODUCTION_WS_BASE_URL,
            web = PRODUCTION_WEB_BASE_URL,
            centrifugo = PRODUCTION_CENTRIFUGO_WS_URL,
        )
        private val developmentEndpoints = DebugEndpoints(
            api = DEVELOPMENT_API_BASE_URL,
            websocket = DEVELOPMENT_WS_BASE_URL,
            web = DEVELOPMENT_WEB_BASE_URL,
            centrifugo = DEVELOPMENT_CENTRIFUGO_WS_URL,
        )
    }

    private data class DebugEndpoints(
        val api: String,
        val websocket: String,
        val web: String,
        val centrifugo: String,
    )
}
