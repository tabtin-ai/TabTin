package com.tabtin.mobile.util

import android.content.Context
import com.tabtin.mobile.data.LegacyEncryptedPrefsMigration
import com.tabtin.mobile.data.SecureStorage
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class TokenManager @Inject constructor(
    @ApplicationContext context: Context,
) {
    /**
     * Wave A1 产品 review 必修 #1：[clear] 同时擦除 legacy prefs 用得到的
     * application context 引用。否则用户登出后力退 + 重启时，[init] 块的
     * 双读迁移会把 legacy prefs 里残留的旧 token 复活——是真实事故路径
     * （手机共享场景下还会泄露上一个账号的会话）。
     */
    private val appContext: Context = context.applicationContext

    /**
     * Wave A1（2026-05-04）：从 deprecated `androidx.security.crypto`
     * (`EncryptedSharedPreferences`) 替换为 [SecureStorage]。
     *
     * 新 prefsName `tabtin_secure_prefs_v2` 与旧 [LegacyEncryptedPrefsMigration.LEGACY_PREFS_NAME]
     * (`tabtin_secure_prefs`) **故意分开**——两套加密格式不兼容（旧 Tink，新 AES/GCM
     * + base64），共用一个 prefsName 会导致旧 entry 被 Tink "解密失败" 抛 throw。
     *
     * **迁移路径**：[init] 块在 `TokenManager` 单例首次创建时跑一次双读迁移
     * （legacy → v2）；同 key 已存在的不覆盖（保护新格式 fresh value）。后续
     * 的 get/set 都走新 [SecureStorage]，旧 prefs 文件保留作回滚备份。
     *
     * **prefsName 不可变约束**：旧 `tabtin_secure_prefs` 一旦改名等于宣布所有
     * 老用户重登（与 iOS Wave 0 service name `com.tabtin.mobile` 不可变同款）；
     * 新 `tabtin_secure_prefs_v2` 一旦确定生产用了，也不能再改。
     */
    private val prefs: SecureStorage = SecureStorage(context, NEW_PREFS_NAME)

    init {
        // 双读迁移：从老 EncryptedSharedPreferences 把所有 entry 搬到新 SecureStorage。
        // legacy reader 失败时整体跳过（不阻塞 App 启动）；详 LegacyEncryptedPrefsMigration。
        // 这是产品事故防线（老用户升级后不丢 token），删除前必须先确认所有用户已迁移
        // （harness #L19 双读清理时机由用户后续发版规划决定）。
        LegacyEncryptedPrefsMigration.openLegacyPrefsOrNull(context)?.let { legacy ->
            LegacyEncryptedPrefsMigration.migrateFromLegacyEncryptedPrefs(legacy, prefs)
        }
    }

    public var accessToken: String?
        get() = prefs.getString(KEY_ACCESS_TOKEN, null)
        set(value) { prefs.putString(KEY_ACCESS_TOKEN, value) }

    public var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH_TOKEN, null)
        set(value) { prefs.putString(KEY_REFRESH_TOKEN, value) }

    /** access_token 过期时间戳（毫秒），0 表示未知 */
    public var accessTokenExpiresAt: Long
        get() = prefs.getLong(KEY_EXPIRES_AT, 0L)
        set(value) { prefs.putLong(KEY_EXPIRES_AT, value) }

    public var organizationId: String?
        get() = prefs.getString(KEY_WORKSPACE_ID, null)
        set(value) { prefs.putString(KEY_WORKSPACE_ID, value) }

    public var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(value) { prefs.putString(KEY_USER_ID, value) }

    public val deviceId: String
        get() {
            synchronized(this) {
                val existing = prefs.getString(KEY_DEVICE_ID, null)
                if (existing != null) return existing
                val newId = "android-${java.util.UUID.randomUUID().toString().take(12)}"
                prefs.putString(KEY_DEVICE_ID, newId)
                return newId
            }
        }

    public var userNickname: String?
        get() = prefs.getString(KEY_USER_NICKNAME, null)
        set(value) { prefs.putString(KEY_USER_NICKNAME, value) }

    public var userUsername: String?
        get() = prefs.getString(KEY_USER_USERNAME, null)
        set(value) { prefs.putString(KEY_USER_USERNAME, value) }

    public var userPhone: String?
        get() = prefs.getString(KEY_USER_PHONE, null)
        set(value) { prefs.putString(KEY_USER_PHONE, value) }

    public var userEmail: String?
        get() = prefs.getString(KEY_USER_EMAIL, null)
        set(value) { prefs.putString(KEY_USER_EMAIL, value) }

    public var userAvatar: String?
        get() = prefs.getString(KEY_USER_AVATAR, null)
        set(value) { prefs.putString(KEY_USER_AVATAR, value) }

    public var userBio: String?
        get() = prefs.getString(KEY_USER_BIO, null)
        set(value) { prefs.putString(KEY_USER_BIO, value) }

    public var userDateJoined: String?
        get() = prefs.getString(KEY_USER_DATE_JOINED, null)
        set(value) { prefs.putString(KEY_USER_DATE_JOINED, value) }

    // ─── Daemon 模式 ─────────────────────────────────────

    /** daemon 模式下后端接口的基础 URL（覆盖 BuildConfig） */
    public var apiBaseUrl: String?
        get() = prefs.getString(KEY_API_BASE_URL, null)
        set(value) { prefs.putString(KEY_API_BASE_URL, value) }

    /** daemon 模式下 WebSocket 基础 URL（覆盖 BuildConfig） */
    public var wsBaseUrl: String?
        get() = prefs.getString(KEY_WS_BASE_URL, null)
        set(value) { prefs.putString(KEY_WS_BASE_URL, value) }

    /** Debug 环境下 REST API 基础 URL；与 Daemon 的连接地址严格隔离。 */
    public var debugApiBaseUrl: String?
        get() = prefs.getString(KEY_DEBUG_API_BASE_URL, null)
        set(value) { prefs.putString(KEY_DEBUG_API_BASE_URL, value) }

    /** Debug 环境下任务网关 WebSocket 地址；与 Daemon 的连接地址严格隔离。 */
    public var debugWsBaseUrl: String?
        get() = prefs.getString(KEY_DEBUG_WS_BASE_URL, null)
        set(value) { prefs.putString(KEY_DEBUG_WS_BASE_URL, value) }

    /** 解锁调试入口后，内嵌 Web 使用的基础 URL。 */
    public var webBaseUrl: String?
        get() = prefs.getString(KEY_DEBUG_WEB_BASE_URL, null)
        set(value) { prefs.putString(KEY_DEBUG_WEB_BASE_URL, value) }

    /** 解锁调试入口后，TabChat Centrifugo 使用的实时连接地址。 */
    public var centrifugoWsUrl: String?
        get() = prefs.getString(KEY_DEBUG_CENTRIFUGO_WS_URL, null)
        set(value) { prefs.putString(KEY_DEBUG_CENTRIFUGO_WS_URL, value) }

    public var debugEnvironmentPreset: String?
        get() = prefs.getString(KEY_DEBUG_ENVIRONMENT_PRESET, null)
        set(value) { putOrRemoveString(KEY_DEBUG_ENVIRONMENT_PRESET, value) }

    public var debugCustomBaseUrl: String?
        get() = prefs.getString(KEY_DEBUG_CUSTOM_BASE_URL, null)
        set(value) { putOrRemoveString(KEY_DEBUG_CUSTOM_BASE_URL, value) }

    public var debugAdvancedEnabled: Boolean
        get() = prefs.getBoolean(KEY_DEBUG_ADVANCED_ENABLED, false)
        set(value) { prefs.putBoolean(KEY_DEBUG_ADVANCED_ENABLED, value) }

    public var debugAdvancedApiUrl: String?
        get() = prefs.getString(KEY_DEBUG_ADVANCED_API_URL, null)
        set(value) { putOrRemoveString(KEY_DEBUG_ADVANCED_API_URL, value) }

    public var debugAdvancedWsUrl: String?
        get() = prefs.getString(KEY_DEBUG_ADVANCED_WS_URL, null)
        set(value) { putOrRemoveString(KEY_DEBUG_ADVANCED_WS_URL, value) }

    public var debugAdvancedWebUrl: String?
        get() = prefs.getString(KEY_DEBUG_ADVANCED_WEB_URL, null)
        set(value) { putOrRemoveString(KEY_DEBUG_ADVANCED_WEB_URL, value) }

    public var debugAdvancedCentrifugoUrl: String?
        get() = prefs.getString(KEY_DEBUG_ADVANCED_CENTRIFUGO_URL, null)
        set(value) { putOrRemoveString(KEY_DEBUG_ADVANCED_CENTRIFUGO_URL, value) }

    public var isDebugEntryUnlocked: Boolean
        get() = prefs.getBoolean(KEY_DEBUG_ENTRY_UNLOCKED, false)
        set(value) { prefs.putBoolean(KEY_DEBUG_ENTRY_UNLOCKED, value) }

    public fun saveDebugNetworkOverrides(
        apiBaseUrl: String?,
        wsBaseUrl: String?,
        webBaseUrl: String? = null,
        centrifugoWsUrl: String? = null,
    ) {
        prefs.edit().also { editor ->
            if (apiBaseUrl.isNullOrBlank()) editor.remove(KEY_DEBUG_API_BASE_URL)
            else editor.putString(KEY_DEBUG_API_BASE_URL, apiBaseUrl.trim())
            if (wsBaseUrl.isNullOrBlank()) editor.remove(KEY_DEBUG_WS_BASE_URL)
            else editor.putString(KEY_DEBUG_WS_BASE_URL, wsBaseUrl.trim())
            if (webBaseUrl.isNullOrBlank()) editor.remove(KEY_DEBUG_WEB_BASE_URL)
            else editor.putString(KEY_DEBUG_WEB_BASE_URL, webBaseUrl.trim())
            if (centrifugoWsUrl.isNullOrBlank()) editor.remove(KEY_DEBUG_CENTRIFUGO_WS_URL)
            else editor.putString(KEY_DEBUG_CENTRIFUGO_WS_URL, centrifugoWsUrl.trim())
        }.apply()
    }

    public fun saveDebugEnvironmentSettings(
        preset: String,
        customBaseUrl: String,
        advancedEnabled: Boolean,
        advancedApiUrl: String,
        advancedWsUrl: String,
        advancedWebUrl: String,
        advancedCentrifugoUrl: String,
    ) {
        prefs.edit().apply {
            putString(KEY_DEBUG_ENVIRONMENT_PRESET, preset)
            putOrRemoveString(KEY_DEBUG_CUSTOM_BASE_URL, customBaseUrl.trim().takeIf { it.isNotEmpty() })
            putBoolean(KEY_DEBUG_ADVANCED_ENABLED, advancedEnabled)
            putOrRemoveString(KEY_DEBUG_ADVANCED_API_URL, advancedApiUrl.trim().takeIf { it.isNotEmpty() })
            putOrRemoveString(KEY_DEBUG_ADVANCED_WS_URL, advancedWsUrl.trim().takeIf { it.isNotEmpty() })
            putOrRemoveString(KEY_DEBUG_ADVANCED_WEB_URL, advancedWebUrl.trim().takeIf { it.isNotEmpty() })
            putOrRemoveString(KEY_DEBUG_ADVANCED_CENTRIFUGO_URL, advancedCentrifugoUrl.trim().takeIf { it.isNotEmpty() })
        }.apply()
    }

    public fun clearDebugEnvironmentSettings() {
        prefs.edit().apply {
            remove(KEY_DEBUG_ENVIRONMENT_PRESET)
            remove(KEY_DEBUG_CUSTOM_BASE_URL)
            remove(KEY_DEBUG_ADVANCED_ENABLED)
            remove(KEY_DEBUG_ADVANCED_API_URL)
            remove(KEY_DEBUG_ADVANCED_WS_URL)
            remove(KEY_DEBUG_ADVANCED_WEB_URL)
            remove(KEY_DEBUG_ADVANCED_CENTRIFUGO_URL)
        }.apply()
    }

    /**
     * 兼容旧版 Debug 面板：它曾错误复用 Daemon key。只有当前并非 Daemon 时才清理，
     * 让「重置 Debug」恢复编译期默认，同时绝不删除真实 Daemon 的连接配置。
     */
    public fun clearLegacyDebugNetworkOverridesIfNeeded() {
        if (isDaemonMode) return
        prefs.edit().apply {
            remove(KEY_API_BASE_URL)
            remove(KEY_WS_BASE_URL)
        }.apply()
    }

    /** daemon 模式标记 */
    public var isDaemonMode: Boolean
        get() = prefs.getBoolean(KEY_IS_DAEMON_MODE, false)
        private set(value) { prefs.putBoolean(KEY_IS_DAEMON_MODE, value) }

    /**
     * daemon 激活后一次性写入所有凭证。
     * 与 [saveTokenPair] 不同，这里不需要 refreshToken，daemon JWT 过期后由 token/renew 续期。
     */
    public fun setDaemonCredentials(
        accessToken: String,
        organizationId: String?,
        apiBaseUrl: String? = null,
        wsBaseUrl: String? = null,
    ) {
        prefs.edit().apply {
            putString(KEY_ACCESS_TOKEN, accessToken)
            putLong(KEY_EXPIRES_AT, 0L)
            organizationId?.let { putString(KEY_WORKSPACE_ID, it) }
            apiBaseUrl?.let { putString(KEY_API_BASE_URL, it) }
            wsBaseUrl?.let { putString(KEY_WS_BASE_URL, it) }
            putBoolean(KEY_IS_DAEMON_MODE, true)
        }.apply()
    }

    public var pendingInviteToken: String?
        get() = prefs.getString(KEY_PENDING_INVITE_TOKEN, null)
        set(value) { prefs.putString(KEY_PENDING_INVITE_TOKEN, value) }

    public var userLastLogin: String?
        get() = prefs.getString(KEY_USER_LAST_LOGIN, null)
        set(value) { prefs.putString(KEY_USER_LAST_LOGIN, value) }

    public var userLoginCount: Int?
        get() = if (prefs.contains(KEY_USER_LOGIN_COUNT)) prefs.getInt(KEY_USER_LOGIN_COUNT, 0) else null
        set(value) {
            if (value != null) prefs.putInt(KEY_USER_LOGIN_COUNT, value)
            else prefs.remove(KEY_USER_LOGIN_COUNT)
        }

    public var userIsVerifiedEmail: Boolean?
        get() = if (prefs.contains(KEY_USER_IS_VERIFIED_EMAIL)) prefs.getBoolean(KEY_USER_IS_VERIFIED_EMAIL, false) else null
        set(value) {
            if (value != null) prefs.putBoolean(KEY_USER_IS_VERIFIED_EMAIL, value)
            else prefs.remove(KEY_USER_IS_VERIFIED_EMAIL)
        }

    public var userIsVerifiedPhone: Boolean?
        get() = if (prefs.contains(KEY_USER_IS_VERIFIED_PHONE)) prefs.getBoolean(KEY_USER_IS_VERIFIED_PHONE, false) else null
        set(value) {
            if (value != null) prefs.putBoolean(KEY_USER_IS_VERIFIED_PHONE, value)
            else prefs.remove(KEY_USER_IS_VERIFIED_PHONE)
        }

    public var userHasUsablePassword: Boolean?
        get() = if (prefs.contains(KEY_USER_HAS_USABLE_PASSWORD)) {
            prefs.getBoolean(KEY_USER_HAS_USABLE_PASSWORD, true)
        } else {
            null
        }
        set(value) {
            if (value != null) prefs.putBoolean(KEY_USER_HAS_USABLE_PASSWORD, value)
            else prefs.remove(KEY_USER_HAS_USABLE_PASSWORD)
        }

    public val isLoggedIn: Boolean
        get() = computeIsLoggedIn(accessToken, accessTokenExpiresAt)

    /** access_token 已过期但仍持有 refresh_token，可尝试恢复会话 */
    public val hasExpiredButRefreshableSession: Boolean
        get() = computeHasExpiredButRefreshableSession(accessToken, accessTokenExpiresAt, refreshToken)

    /** access_token 剩余有效期不足 5 分钟则视为即将过期 */
    public val isAccessTokenExpiringSoon: Boolean
        get() {
            val expiresAt = accessTokenExpiresAt
            if (expiresAt == 0L) return false
            return System.currentTimeMillis() > expiresAt - REFRESH_THRESHOLD_MS
        }

    /** 登录/刷新成功后一次性原子写入全部 Token 信息 */
    public fun saveTokenPair(accessToken: String, refreshToken: String?, expiresIn: Int?) {
        val expiresMs = (expiresIn ?: DEFAULT_EXPIRES_IN_SECONDS).toLong() * 1000
        prefs.edit().apply {
            putString(KEY_ACCESS_TOKEN, accessToken)
            refreshToken?.let { putString(KEY_REFRESH_TOKEN, it) }
            putLong(KEY_EXPIRES_AT, System.currentTimeMillis() + expiresMs)
        }.apply()
    }

    public fun saveUserProfile(
        nickname: String?,
        username: String?,
        phone: String?,
        email: String?,
        avatar: String?,
        bio: String?,
        dateJoined: String?,
        lastLogin: String?,
        loginCount: Int?,
        isVerifiedEmail: Boolean?,
        isVerifiedPhone: Boolean?,
        hasUsablePassword: Boolean?,
    ) {
        prefs.edit().apply {
            putOrRemoveString(KEY_USER_NICKNAME, nickname)
            putOrRemoveString(KEY_USER_USERNAME, username)
            putOrRemoveString(KEY_USER_PHONE, phone)
            putOrRemoveString(KEY_USER_EMAIL, email)
            putOrRemoveString(KEY_USER_AVATAR, avatar)
            putOrRemoveString(KEY_USER_BIO, bio)
            putOrRemoveString(KEY_USER_DATE_JOINED, dateJoined)
            putOrRemoveString(KEY_USER_LAST_LOGIN, lastLogin)
            if (loginCount != null) putInt(KEY_USER_LOGIN_COUNT, loginCount)
            else remove(KEY_USER_LOGIN_COUNT)
            if (isVerifiedEmail != null) putBoolean(KEY_USER_IS_VERIFIED_EMAIL, isVerifiedEmail)
            else remove(KEY_USER_IS_VERIFIED_EMAIL)
            if (isVerifiedPhone != null) putBoolean(KEY_USER_IS_VERIFIED_PHONE, isVerifiedPhone)
            else remove(KEY_USER_IS_VERIFIED_PHONE)
            if (hasUsablePassword != null) putBoolean(KEY_USER_HAS_USABLE_PASSWORD, hasUsablePassword)
            else remove(KEY_USER_HAS_USABLE_PASSWORD)
        }.apply()
    }

    private fun putOrRemoveString(key: String, value: String?) {
        if (value != null) prefs.putString(key, value) else prefs.remove(key)
    }

    private fun SecureStorage.Editor.putOrRemoveString(key: String, value: String?) {
        if (value != null) putString(key, value) else remove(key)
    }

    public fun clear() {
        clearSessionStorage(prefs, preserveLegacyDebugOverrides = !isDaemonMode)
        // Wave A1 产品 review 必修 #1：同时清 legacy prefs **文件本身**，防止用户
        // 登出后力退 + 重启时 init 块把旧 token 重新搬进新存储——是手机共享场景
        // 下的真实隐私事故路径（A 账号登出 → B 登录登出 → 重启 → A 会话复活）。
        //
        // 故意**不**走 [LegacyEncryptedPrefsMigration.openLegacyPrefsOrNull]
        // （即不走 `EncryptedSharedPreferences.create`），而是用 plain
        // [Context.getSharedPreferences] 直接清整个 prefs 文件：
        // - 不依赖 Tink master key 是否健在（设备重置擦了 alias 也能清）
        // - 不依赖 EncryptedSharedPreferences.create 不抛异常（Robolectric / 厂商 ROM 兼容）
        // - 我们要的就是 prefs 文件清空，不需要解密内容
        appContext.getSharedPreferences(
            LegacyEncryptedPrefsMigration.LEGACY_PREFS_NAME,
            Context.MODE_PRIVATE,
        ).edit().clear().apply()
    }

    public companion object {
        @JvmStatic
        public fun computeIsLoggedIn(accessToken: String?, expiresAtMs: Long): Boolean {
            if (accessToken.isNullOrBlank()) return false
            if (expiresAtMs != 0L && System.currentTimeMillis() > expiresAtMs) return false
            return true
        }

        @JvmStatic
        public fun computeHasExpiredButRefreshableSession(
            accessToken: String?,
            expiresAtMs: Long,
            refreshToken: String?,
        ): Boolean {
            if (accessToken.isNullOrBlank()) return false
            if (expiresAtMs == 0L || System.currentTimeMillis() <= expiresAtMs) return false
            return !refreshToken.isNullOrBlank()
        }

        /**
         * 新 prefsName。**故意与 [LegacyEncryptedPrefsMigration.LEGACY_PREFS_NAME] 不同**
         * 以隔离两套加密格式（详 [prefs] 字段说明）。生产投放后此名也不可改。
         */
        public const val NEW_PREFS_NAME: String = "tabtin_secure_prefs_v2"

        internal fun clearSessionStorage(
            prefs: SecureStorage,
            preserveLegacyDebugOverrides: Boolean,
        ) {
            val savedDeviceId = prefs.getString(KEY_DEVICE_ID, null)
            val environmentStringKeys = if (preserveLegacyDebugOverrides) {
                LEGACY_DEBUG_ENVIRONMENT_STRING_KEYS + DEBUG_ENVIRONMENT_STRING_KEYS
            } else {
                DEBUG_ENVIRONMENT_STRING_KEYS
            }
            val savedEnvironmentStrings = environmentStringKeys.mapNotNull { key ->
                prefs.getString(key, null)?.let { key to it }
            }
            val savedEnvironmentBooleans = ENVIRONMENT_BOOLEAN_KEYS.mapNotNull { key ->
                if (prefs.contains(key)) key to prefs.getBoolean(key, false) else null
            }
            prefs.edit().also { editor ->
                editor.clear()
                savedDeviceId?.let { editor.putString(KEY_DEVICE_ID, it) }
                savedEnvironmentStrings.forEach { (key, value) -> editor.putString(key, value) }
                savedEnvironmentBooleans.forEach { (key, value) -> editor.putBoolean(key, value) }
            }.apply()
        }

        private const val KEY_ACCESS_TOKEN = "auth_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_EXPIRES_AT = "access_token_expires_at"
        private const val KEY_WORKSPACE_ID = "workspace_id"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_USER_NICKNAME = "user_nickname"
        private const val KEY_USER_USERNAME = "user_username"
        private const val KEY_USER_PHONE = "user_phone"
        private const val KEY_USER_EMAIL = "user_email"
        private const val KEY_USER_AVATAR = "user_avatar"
        private const val KEY_USER_BIO = "user_bio"
        private const val KEY_USER_DATE_JOINED = "user_date_joined"
        private const val KEY_USER_LAST_LOGIN = "user_last_login"
        private const val KEY_USER_LOGIN_COUNT = "user_login_count"
        private const val KEY_USER_IS_VERIFIED_EMAIL = "user_is_verified_email"
        private const val KEY_USER_IS_VERIFIED_PHONE = "user_is_verified_phone"
        private const val KEY_USER_HAS_USABLE_PASSWORD = "user_has_usable_password"
        private const val KEY_PENDING_INVITE_TOKEN = "pending_invite_token"
        private const val KEY_API_BASE_URL = "daemon_api_base_url"
        private const val KEY_WS_BASE_URL = "daemon_ws_base_url"
        private const val KEY_DEBUG_API_BASE_URL = "debug_api_base_url"
        private const val KEY_DEBUG_WS_BASE_URL = "debug_ws_base_url"
        private const val KEY_DEBUG_WEB_BASE_URL = "debug_web_base_url"
        private const val KEY_DEBUG_CENTRIFUGO_WS_URL = "debug_centrifugo_ws_url"
        private const val KEY_DEBUG_ENVIRONMENT_PRESET = "debug_environment_preset"
        private const val KEY_DEBUG_CUSTOM_BASE_URL = "debug_custom_base_url"
        private const val KEY_DEBUG_ADVANCED_ENABLED = "debug_advanced_enabled"
        private const val KEY_DEBUG_ADVANCED_API_URL = "debug_advanced_api_url"
        private const val KEY_DEBUG_ADVANCED_WS_URL = "debug_advanced_ws_url"
        private const val KEY_DEBUG_ADVANCED_WEB_URL = "debug_advanced_web_url"
        private const val KEY_DEBUG_ADVANCED_CENTRIFUGO_URL = "debug_advanced_centrifugo_url"
        private const val KEY_IS_DAEMON_MODE = "is_daemon_mode"
        private const val KEY_DEBUG_ENTRY_UNLOCKED = "debug_entry_unlocked"

        private val LEGACY_DEBUG_ENVIRONMENT_STRING_KEYS = listOf(
            KEY_API_BASE_URL,
            KEY_WS_BASE_URL,
        )
        private val DEBUG_ENVIRONMENT_STRING_KEYS = listOf(
            KEY_DEBUG_API_BASE_URL,
            KEY_DEBUG_WS_BASE_URL,
            KEY_DEBUG_WEB_BASE_URL,
            KEY_DEBUG_CENTRIFUGO_WS_URL,
            KEY_DEBUG_ENVIRONMENT_PRESET,
            KEY_DEBUG_CUSTOM_BASE_URL,
            KEY_DEBUG_ADVANCED_API_URL,
            KEY_DEBUG_ADVANCED_WS_URL,
            KEY_DEBUG_ADVANCED_WEB_URL,
            KEY_DEBUG_ADVANCED_CENTRIFUGO_URL,
        )
        private val ENVIRONMENT_BOOLEAN_KEYS = listOf(
            KEY_DEBUG_ADVANCED_ENABLED,
            KEY_DEBUG_ENTRY_UNLOCKED,
        )

        private const val REFRESH_THRESHOLD_MS = 5 * 60 * 1000L
        private const val DEFAULT_EXPIRES_IN_SECONDS = 86400
    }
}
