package com.tabtin.mobile.features.capabilities

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.adb.AdbConnectionState
import com.tabtin.mobile.data.adb.AdbConnectionManager
import com.tabtin.mobile.data.adb.OemDetector
import com.tabtin.mobile.data.adb.PairingCodeExtractor
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import com.tabtin.mobile.data.privileged.PrivilegedProcessState
import com.tabtin.mobile.data.websocket.AutoRecoverState
import com.tabtin.mobile.util.DeviceRuntimeDescriptor
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

public data class PermissionItem(
    val key: String,
    val labelRes: Int,
    val permission: String?,
    val isSpecial: Boolean = false,
    val granted: Boolean = false,
)

public data class CapabilitiesUiState(
    val l1Permissions: List<PermissionItem> = emptyList(),
    val l2Supported: Boolean = false,
    val adbState: AdbConnectionState = AdbConnectionState.DISCONNECTED,
    val privilegedState: PrivilegedProcessState = PrivilegedProcessState.STOPPED,
    val privilegedError: String? = null,
    val adbError: String? = null,
    val oemBrand: String = "",
    val setupGuide: OemDetector.SetupGuide? = null,
    val isOperating: Boolean = false,
    val hasPreviouslyPaired: Boolean = false,
    val autoRecoverState: AutoRecoverState = AutoRecoverState.Idle,
    val autoPairingInProgress: Boolean = false,
    val xiaomiDeveloperWaitDays: Int? = null,
    val requiresSpecialBackgroundSettings: Boolean = false,
)

@HiltViewModel
public class CapabilitiesViewModel @Inject constructor(
    application: Application,
    private val adbConnectionManager: AdbConnectionManager,
    private val privilegedProcessManager: PrivilegedProcessManager,
    private val oemDetector: OemDetector,
    private val webSocketService: com.tabtin.mobile.data.websocket.WebSocketService,
    private val pairingCodeExtractor: PairingCodeExtractor,
) : AndroidViewModel(application) {

    private val _refreshTrigger = MutableStateFlow(0)
    private val _isOperating = MutableStateFlow(false)
    private val _autoPairingInProgress = MutableStateFlow(false)

    init {
        viewModelScope.launch {
            pairingCodeExtractor.pairingDetected.collect { info ->
                if (_isOperating.value) return@collect
                if (adbConnectionManager.isConnected) return@collect
                if (!_isOperating.compareAndSet(expect = false, update = true)) return@collect
                Log.i("CapabilitiesVM", "Auto-pairing with detected pairing code")
                _autoPairingInProgress.value = true
                try {
                    val paired = adbConnectionManager.pair(info.code, info.port)
                    if (!paired) return@collect
                    val connected = adbConnectionManager.connect()
                    if (connected) {
                        privilegedProcessManager.start()
                    }
                } finally {
                    _isOperating.value = false
                    _autoPairingInProgress.value = false
                }
            }
        }
    }

    private data class SubsystemInfo<S>(val state: S, val error: String?)

    private val l1Permissions = _refreshTrigger.map { buildL1Permissions() }

    private val adbInfo = combine(
        adbConnectionManager.state, adbConnectionManager.lastError,
    ) { state, error -> SubsystemInfo(state, error) }

    private val privilegedInfo = combine(
        privilegedProcessManager.state, privilegedProcessManager.lastError,
    ) { state, error -> SubsystemInfo(state, error) }

    public val uiState: StateFlow<CapabilitiesUiState> = combine(
        combine(l1Permissions, adbInfo, privilegedInfo) { perms, adb, priv -> Triple(perms, adb, priv) },
        _isOperating,
        webSocketService.autoRecoverState,
        _autoPairingInProgress,
    ) { (perms, adb, priv), isOperating, autoRecover, autoPairing ->
        CapabilitiesUiState(
            l1Permissions = perms,
            l2Supported = oemDetector.supportsWirelessDebugging,
            adbState = adb.state,
            privilegedState = priv.state,
            privilegedError = localizeError(priv.error),
            adbError = localizeError(adb.error),
            oemBrand = oemDetector.brand.name.lowercase()
                .replaceFirstChar { it.uppercase() },
            setupGuide = oemDetector.getSetupGuide(),
            isOperating = isOperating,
            hasPreviouslyPaired = adbConnectionManager.hasPreviouslyPaired,
            autoRecoverState = autoRecover,
            autoPairingInProgress = autoPairing,
            xiaomiDeveloperWaitDays = oemDetector.xiaomiDeveloperWaitDays,
            requiresSpecialBackgroundSettings = oemDetector.requiresSpecialBackgroundSettings,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), CapabilitiesUiState())

    public fun refreshPermissions() {
        _refreshTrigger.value++
        webSocketService.reportCapabilitiesChanged()
    }

    public fun pairAndConnect(pairingCode: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        if (!_isOperating.compareAndSet(expect = false, update = true)) return
        viewModelScope.launch {
            try {
                val paired = adbConnectionManager.pair(pairingCode)
                if (!paired) return@launch
                val connected = adbConnectionManager.connect()
                if (connected) {
                    privilegedProcessManager.start()
                }
            } finally {
                _isOperating.value = false
            }
        }
    }

    public fun connectOnly() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        if (!_isOperating.compareAndSet(expect = false, update = true)) return
        viewModelScope.launch {
            try {
                val connected = adbConnectionManager.connect()
                if (connected) {
                    privilegedProcessManager.start()
                }
            } finally {
                _isOperating.value = false
            }
        }
    }

    public fun startPrivilegedProcess() {
        if (!_isOperating.compareAndSet(expect = false, update = true)) return
        viewModelScope.launch {
            try {
                privilegedProcessManager.start()
            } finally {
                _isOperating.value = false
            }
        }
    }

    public fun stopPrivilegedProcess() {
        if (!_isOperating.compareAndSet(expect = false, update = true)) return
        viewModelScope.launch {
            try {
                privilegedProcessManager.stop()
                adbConnectionManager.disconnect()
            } finally {
                _isOperating.value = false
            }
        }
    }

    public fun isNotificationListenerEnabled(): Boolean {
        val flat = Settings.Secure.getString(
            getApplication<Application>().contentResolver,
            "enabled_notification_listeners",
        ) ?: return false
        return flat.contains(getApplication<Application>().packageName)
    }

    private fun buildL1Permissions(): List<PermissionItem> {
        val ctx = getApplication<Application>()
        return listOf(
            PermissionItem(
                key = "contacts",
                labelRes = com.tabtin.mobile.R.string.capabilities_contacts,
                permission = Manifest.permission.READ_CONTACTS,
                granted = hasPermission(ctx, Manifest.permission.READ_CONTACTS),
            ),
            PermissionItem(
                key = "sms_read",
                labelRes = com.tabtin.mobile.R.string.capabilities_sms,
                permission = Manifest.permission.READ_SMS,
                granted = hasPermission(ctx, Manifest.permission.READ_SMS),
            ),
            PermissionItem(
                key = "sms_send",
                labelRes = com.tabtin.mobile.R.string.capabilities_sms_send,
                permission = Manifest.permission.SEND_SMS,
                granted = hasPermission(ctx, Manifest.permission.SEND_SMS),
            ),
            PermissionItem(
                key = "call_log",
                labelRes = com.tabtin.mobile.R.string.capabilities_call_log,
                permission = Manifest.permission.READ_CALL_LOG,
                granted = hasPermission(ctx, Manifest.permission.READ_CALL_LOG),
            ),
            PermissionItem(
                key = "phone_call",
                labelRes = com.tabtin.mobile.R.string.capabilities_phone,
                permission = Manifest.permission.CALL_PHONE,
                granted = hasPermission(ctx, Manifest.permission.CALL_PHONE),
            ),
            PermissionItem(
                key = "calendar",
                labelRes = com.tabtin.mobile.R.string.capabilities_calendar,
                permission = Manifest.permission.READ_CALENDAR,
                granted = hasPermission(ctx, Manifest.permission.READ_CALENDAR),
            ),
            PermissionItem(
                key = "location",
                labelRes = com.tabtin.mobile.R.string.capabilities_location,
                permission = Manifest.permission.ACCESS_FINE_LOCATION,
                granted = hasPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ||
                    hasPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION),
            ),
            PermissionItem(
                key = "media_read",
                labelRes = R.string.capabilities_media,
                permission = DeviceRuntimeDescriptor.MEDIA_PERMISSION,
                granted = hasPermission(ctx, DeviceRuntimeDescriptor.MEDIA_PERMISSION),
            ),
        ).let { base ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                base + listOf(
                    PermissionItem(
                        key = "media_read_video",
                        labelRes = R.string.capabilities_media_video,
                        permission = DeviceRuntimeDescriptor.VIDEO_MEDIA_PERMISSION,
                        granted = hasPermission(ctx, DeviceRuntimeDescriptor.VIDEO_MEDIA_PERMISSION),
                    ),
                    // Android 13+ 的应用通知是运行时权限，不是 Notification Listener
                    // 特殊授权。两者混用会把用户带到错误的系统页面。
                    PermissionItem(
                        key = "notification_runtime",
                        labelRes = R.string.capabilities_notification,
                        permission = Manifest.permission.POST_NOTIFICATIONS,
                        granted = hasPermission(ctx, Manifest.permission.POST_NOTIFICATIONS),
                    ),
                )
            } else base
        } + listOf(
            PermissionItem(
                key = "notification_listener",
                labelRes = com.tabtin.mobile.R.string.capabilities_notification_listener,
                permission = null,
                isSpecial = true,
                granted = isNotificationListenerEnabled(),
            ),
        )
    }

    private val errorLocalizations: List<Pair<String, String>> by lazy {
        val ctx = getApplication<Application>()
        listOf(
            "Could not discover ADB pairing" to ctx.getString(R.string.capabilities_error_discover_pairing),
            "Could not discover" to ctx.getString(R.string.capabilities_error_discover_wireless),
            "Invalid pairing code" to ctx.getString(R.string.capabilities_error_invalid_pairing_code),
            "Pairing failed" to ctx.getString(R.string.capabilities_error_pairing_failed),
            "Pairing code may have expired" to ctx.getString(R.string.capabilities_error_pairing_expired),
            "Pairing not supported" to ctx.getString(R.string.capabilities_error_pairing_unsupported),
            "Privileged process response timed out" to ctx.getString(R.string.capabilities_error_privileged_timeout),
            "Not connected to privileged process" to ctx.getString(R.string.capabilities_error_privileged_not_connected),
            "Max reconnect attempts exceeded" to ctx.getString(R.string.capabilities_error_max_reconnect),
            "Requires Android 11+" to ctx.getString(R.string.capabilities_error_requires_android11),
            "Connection failed" to ctx.getString(R.string.capabilities_error_connection_failed),
            "Communication error" to ctx.getString(R.string.capabilities_error_communication),
            "Shell command failed" to ctx.getString(R.string.capabilities_error_shell_failed),
        )
    }

    private fun localizeError(error: String?): String? {
        if (error == null) return null
        errorLocalizations.forEach { (pattern, localized) ->
            if (error.contains(pattern, ignoreCase = true)) return localized
        }
        return error
    }

    private fun hasPermission(ctx: android.content.Context, permission: String): Boolean {
        return ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED
    }
}
