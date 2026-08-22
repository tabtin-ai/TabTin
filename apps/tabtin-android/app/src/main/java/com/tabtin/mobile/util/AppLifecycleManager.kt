package com.tabtin.mobile.util

import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.tabtin.mobile.data.api.AuthEventBus
import com.tabtin.mobile.data.repository.AuthRepository
import com.tabtin.mobile.data.repository.DeviceRuntimeRepository
import com.tabtin.mobile.data.websocket.BillingEventHandler
import com.tabtin.mobile.data.websocket.ConnectionRecoveryManager
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.data.websocket.WsAuthInvalidAction
import com.tabtin.mobile.data.websocket.WsAuthInvalidPolicy
import com.tabtin.mobile.data.websocket.WsAuthInvalidStep
import com.tabtin.mobile.sentry.DiagnosticRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 进程级生命周期管理器，通过 ProcessLifecycleOwner 监听 App 前/后台切换。
 *
 * 职责：
 * 1. 切到后台 60 秒后断开 WebSocket（避免快速切换时频繁断连）
 * 2. 回到前台时：后台超过 30 秒则检查 Token 有效性；网络可用时重连 WS
 * 3. 网络恢复时自动触发 WS 重连
 */
@Singleton
public class AppLifecycleManager @Inject constructor(
    private val webSocketService: WebSocketService,
    private val networkMonitor: NetworkMonitor,
    private val tokenManager: TokenManager,
    private val authRepository: AuthRepository,
    private val deviceRuntimeRepository: DeviceRuntimeRepository,
    private val connectionRecoveryManager: ConnectionRecoveryManager,
    private val billingEventHandler: BillingEventHandler,
) : DefaultLifecycleObserver {

    public companion object {
        private const val TAG = "AppLifecycleManager"
        private const val BACKGROUND_WS_DISCONNECT_DELAY_MS = 60_000L
        private const val TOKEN_RECHECK_THRESHOLD_MS = 30_000L
        private val _memoUpdatedFlow = MutableSharedFlow<String>(extraBufferCapacity = 8)
        public val memoUpdatedFlow: SharedFlow<String> = _memoUpdatedFlow.asSharedFlow()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var backgroundTimestamp = 0L
    private var disconnectJob: Job? = null
    private var authInvalidJob: Job? = null
    private var refreshedTokenStillPendingAuth = false

    public fun initialize() {
        webSocketService.onAuthFailed = {
            if (authInvalidJob?.isActive == true) {
                Log.w(TAG, "WS auth invalid ignored; refresh already in flight")
            } else {
                authInvalidJob = scope.launch { handleGuiAuthInvalid() }
            }
        }
        scope.launch {
            webSocketService.connectionState.collect { state ->
                if (state is com.tabtin.mobile.data.websocket.WSConnectionState.Connected) {
                    refreshedTokenStillPendingAuth = false
                }
            }
        }
        scope.launch {
            networkMonitor.networkRestoredEvents.collect {
                val registered = deviceRuntimeRepository.ensureSelectedOrganizationDeviceRegistered()
                if (registered) {
                    Log.i(TAG, "Network restored, triggering WS reconnect")
                    webSocketService.ensureDeviceRuntimeReady()
                }
            }
        }
        networkMonitor.startMonitoring()
        connectionRecoveryManager.initialize()
        billingEventHandler.start()
        registerApprovalMemoHandler()
        Log.i(TAG, "Initialized")
    }

    private suspend fun handleGuiAuthInvalid() {
        val step = if (refreshedTokenStillPendingAuth) {
            WsAuthInvalidStep.AfterSuccessfulRefreshStillRejected
        } else {
            WsAuthInvalidStep.NeedRefresh
        }
        when (WsAuthInvalidPolicy.decide(step)) {
            WsAuthInvalidAction.STAY_DISCONNECTED -> {
                refreshedTokenStillPendingAuth = false
                Log.w(TAG, "WS auth invalid after refresh; keep session and stay disconnected")
                webSocketService.disconnect(manual = false)
            }
            WsAuthInvalidAction.LOGOUT -> {
                refreshedTokenStillPendingAuth = false
                Log.w(TAG, "WS auth failed after invalid refresh, logging out")
                AuthEventBus.emitLogoutRequired()
            }
            WsAuthInvalidAction.ATTEMPT_REFRESH -> {
                val result = authRepository.attemptTokenRefresh()
                when (WsAuthInvalidPolicy.decide(WsAuthInvalidStep.AfterRefresh(result))) {
                    WsAuthInvalidAction.RECONNECT -> {
                        refreshedTokenStillPendingAuth = true
                        Log.i(TAG, "WS auth invalid recovered by token refresh, reconnecting")
                        val registered = deviceRuntimeRepository.ensureSelectedOrganizationDeviceRegistered()
                        if (registered) {
                            webSocketService.reconnectAfterRecoveredAuth()
                        } else {
                            Log.w(TAG, "WS auth recovered but device not registered; keep session")
                            webSocketService.disconnect(manual = false)
                        }
                    }
                    WsAuthInvalidAction.LOGOUT -> {
                        refreshedTokenStillPendingAuth = false
                        Log.w(TAG, "WS auth failed, refresh token invalid, logging out")
                        AuthEventBus.emitLogoutRequired()
                    }
                    WsAuthInvalidAction.STAY_DISCONNECTED -> {
                        refreshedTokenStillPendingAuth = false
                        Log.w(
                            TAG,
                            "WS auth invalid; refresh ${result::class.simpleName}, keep session",
                        )
                        webSocketService.disconnect(manual = false)
                    }
                    WsAuthInvalidAction.ATTEMPT_REFRESH -> Unit
                }
            }
            WsAuthInvalidAction.RECONNECT -> Unit
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        DiagnosticRuntime.markRunning()
        disconnectJob?.cancel()
        disconnectJob = null

        //  推送在线抑制：回前台上报 foreground（socket 仍连着时生效；已断连则
        // 重连后服务端 auth 成功即标记前台，此帧被 notify 内部按未认证丢弃，与 iOS 一致）。
        notifyAppState("foreground")

        val bgDuration = System.currentTimeMillis() - backgroundTimestamp
        Log.i(TAG, "App foregrounded (bg duration: ${bgDuration}ms)")

        if (bgDuration > TOKEN_RECHECK_THRESHOLD_MS && tokenManager.isLoggedIn) {
            if (tokenManager.isAccessTokenExpiringSoon) {
                Log.i(TAG, "Token expiring soon after background, proactive refresh will handle it")
            }
        }

        scope.launch {
            val registered = deviceRuntimeRepository.ensureSelectedOrganizationDeviceRegistered()
            if (registered && networkMonitor.isConnected) {
                webSocketService.ensureDeviceRuntimeReady()
            }
        }
    }

    /**
     * 上报 App 前/后台状态给协作服务端（type=app_state）。
     * 服务端据此维护"用户是否在前台"，前台在线时抑制离线推送、后台时放行，
     * 与 iOS RealtimeGateway.notifyAppState 保持同一契约。notify 内部会在
     * 未认证/未连接时安全丢弃，无需在此重复判断。
     */
    private fun notifyAppState(state: String) {
        webSocketService.notify(
            type = "app_state",
            payload = buildJsonObject { put("state", state) },
        )
    }

    private fun registerApprovalMemoHandler() {
        webSocketService.onEnvelope("approval-memo-sync") { envelope ->
            if (envelope.type == "agent.action.approval_memo_updated") {
                val workspaceId = envelope.payloadString("workspace_id")
                Log.d(TAG, "approval_memo_updated received for workspace=$workspaceId")
                if (workspaceId != null) {
                    scope.launch { _memoUpdatedFlow.emit(workspaceId) }
                }
            }
        }
    }

    override fun onStop(owner: LifecycleOwner) {
        DiagnosticRuntime.markClean()
        backgroundTimestamp = System.currentTimeMillis()
        Log.i(TAG, "App backgrounded, scheduling WS disconnect in ${BACKGROUND_WS_DISCONNECT_DELAY_MS}ms")

        //  推送在线抑制：立即上报 background（socket 尚在 60s 断连宽限期内，帧能发出），
        // 让后端解除前台在线态，从而允许离线推送下发，与 iOS enterBackground 行为对齐。
        notifyAppState("background")

        disconnectJob = scope.launch {
            delay(BACKGROUND_WS_DISCONNECT_DELAY_MS)
            deviceRuntimeRepository.reportOffline()
            Log.i(TAG, "Disconnecting WS after background timeout")
            webSocketService.disconnect(manual = false)
        }
    }
}
