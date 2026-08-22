package com.tabtin.mobile.features.space

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.api.UserPortraitApi
import com.tabtin.mobile.data.api.UserPortraitApiException
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.DistillStatus
import com.tabtin.mobile.data.model.SubmitHintRequest
import com.tabtin.mobile.data.model.UserPortrait
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import retrofit2.HttpException
import javax.inject.Inject

/**
 * UserPortraitViewModel —— 严格对齐 Electron `useUserPortrait.ts` 的状态机
 *
 * 轮询规则（与 Electron 一致）：
 *  - 触发 hint / distill 成功后，每 [POLL_INTERVAL_MS] 毫秒 GET 一次画像
 *  - 最多 [POLL_MAX_ATTEMPTS] 次（默认 12 × 3s = 36s）
 *  - 期间 portrait.lastDistillStatus == PENDING 继续
 *  - 后端返回非 PENDING 时立刻停轮询
 *  - 超时进入 isStillDistilling = true 软状态（轮询已停，UI 提示用户手动刷新）
 *
 * (organizationId, agentId) 变化会重置全部状态并重拉，画像严格按 AI 分身隔离。
 *
 * 错误语义两套独立：
 *  - loadError：GET 失败（网络 / 5xx），UI 用独立 banner 展示并提供"重试"按钮
 *  - 蒸馏失败：portrait.lastDistillStatus == FAILED + portrait.lastDistillError，
 *    UI 另一个 banner 展示并提供"重试蒸馏"
 *
 * 提交 hint 失败：rethrow 让 HintInput 走失败分支（P0-3：保留用户输入文字）。
 */
@HiltViewModel
public class UserPortraitViewModel @Inject constructor(
    private val api: UserPortraitApi,
) : ViewModel() {

    public companion object {
        internal const val POLL_INTERVAL_MS: Long = 3_000L
        internal const val POLL_MAX_ATTEMPTS: Int = 12
    }

    private val _uiState = MutableStateFlow(UserPortraitUiState())
    public val uiState: StateFlow<UserPortraitUiState> = _uiState.asStateFlow()

    private var currentScope: UserPortraitScope = UserPortraitScope.EMPTY
    private var pollingJob: Job? = null

    // ── 加载 ──────────────────────────────────────────────

    /**
     * organizationId 变化时调（外部通过 LaunchedEffect 触发）：
     * 重置状态、清空旧画像、停掉旧轮询，然后拉新画像。
     */
    public fun bind(organizationId: String, agentId: String) {
        val scope = UserPortraitScope(organizationId, agentId)
        if (scope == currentScope) return
        currentScope = scope
        stopPolling()
        _uiState.value = UserPortraitUiState()
        if (scope.isValid) {
            refresh(scope)
        }
    }

    /** 重新加载画像（用户点"重试"或外部调用）。 */
    public fun refresh(organizationId: String, agentId: String) {
        refresh(UserPortraitScope(organizationId, agentId))
    }

    private fun refresh(scope: UserPortraitScope) {
        if (scope != currentScope || !scope.isValid) return
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, loadError = null) }
            try {
                val portrait = api.getMyPortrait(scope.organizationId, scope.agentId).unwrap()
                if (scope != currentScope) return@launch
                _uiState.update { it.copy(portrait = portrait, isLoading = false) }
                // 如果服务端返回非 pending，停掉之前可能在跑的轮询
                if (portrait.lastDistillStatus != DistillStatus.PENDING) {
                    stopPolling()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (scope != currentScope) return@launch
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        loadError = e.toUserMessage(),
                        isDistilling = false,
                        isStillDistilling = false,
                    )
                }
                stopPolling()
            }
        }
    }

    // ── 提交 hint ─────────────────────────────────────────

    /**
     * 提交 hint。
     * 成功返回 [UserPortrait]；失败抛 [UserPortraitApiException]（让 HintInput 保留用户输入）。
     * 调度成功（distill_dispatched != false）会启动轮询。
     */
    public suspend fun submitHint(organizationId: String, agentId: String, text: String): UserPortrait {
        val scope = UserPortraitScope(organizationId, agentId)
        try {
            val portrait = api.submitHint(
                organizationId,
                agentId,
                SubmitHintRequest(text = text),
            ).unwrap()
            if (scope != currentScope) return portrait
            _uiState.update { it.copy(portrait = portrait) }
            if (portrait.distillDispatched != false) {
                startPolling(scope)
            }
            return portrait
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw e.toApiException()
        }
    }

    // ── 主动触发蒸馏 ──────────────────────────────────────

    /**
     * 主动触发蒸馏。
     * 成功调度（accepted != false）后启动轮询；
     * 失败抛 [UserPortraitApiException]。
     */
    public suspend fun triggerDistill(organizationId: String, agentId: String): UserPortrait {
        val scope = UserPortraitScope(organizationId, agentId)
        try {
            val portrait = api.triggerDistill(organizationId, agentId).unwrap()
            if (scope != currentScope) return portrait
            _uiState.update { it.copy(portrait = portrait) }
            if (portrait.accepted != false) {
                startPolling(scope)
            }
            return portrait
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw e.toApiException()
        }
    }

    // ── 轮询 ──────────────────────────────────────────────

    private fun startPolling(scope: UserPortraitScope) {
        stopPolling()
        _uiState.update { it.copy(isDistilling = true, isStillDistilling = false) }
        pollingJob = viewModelScope.launch {
            var attempts = 0
            try {
                while (attempts < POLL_MAX_ATTEMPTS) {
                    delay(POLL_INTERVAL_MS)
                    if (scope != currentScope) return@launch
                    attempts += 1
                    val portrait = try {
                        api.getMyPortrait(scope.organizationId, scope.agentId).unwrap()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // 轮询过程中单次失败不抛错，等下一次或最终超时
                        continue
                    }
                    if (scope != currentScope) return@launch
                    _uiState.update { it.copy(portrait = portrait) }
                    if (portrait.lastDistillStatus != DistillStatus.PENDING) {
                        // 完成（成功 / 失败）：停掉 isDistilling
                        _uiState.update { it.copy(isDistilling = false, isStillDistilling = false) }
                        return@launch
                    }
                }
                // 超时：转入 isStillDistilling 软状态
                _uiState.update { it.copy(isDistilling = false, isStillDistilling = true) }
            } catch (e: CancellationException) {
                throw e
            }
        }
    }

    private fun stopPolling() {
        pollingJob?.cancel()
        pollingJob = null
        // 不在这里清 isDistilling —— 由调用方按场景决定（refresh 失败要清；
        // 轮询正常完成由协程自己 update；organizationId 切换由 bind 重置整个 state）
    }

    override fun onCleared() {
        super.onCleared()
        stopPolling()
    }

    // ── 错误转换 ──────────────────────────────────────────

    private fun Throwable.toUserMessage(): String = when (this) {
        is UserPortraitApiException -> message ?: errorCode ?: "Request failed"
        is HttpException -> "HTTP ${code()}"
        is AppError.RequestFailed -> serverMessage ?: "Request failed"
        is AppError -> message ?: javaClass.simpleName
        else -> message ?: javaClass.simpleName
    }

    private fun Throwable.toApiException(): UserPortraitApiException {
        if (this is UserPortraitApiException) return this
        return when (this) {
            is HttpException -> UserPortraitApiException(
                statusCode = code(),
                errorCode = null,
                message = message ?: "HTTP ${code()}",
                cause = this,
            )
            is AppError.RequestFailed -> UserPortraitApiException(
                statusCode = 0,
                errorCode = null,
                message = serverMessage ?: "Request failed",
                cause = this,
            )
            else -> UserPortraitApiException(
                statusCode = 0,
                errorCode = null,
                message = message ?: javaClass.simpleName,
                cause = this,
            )
        }
    }
}

public data class UserPortraitUiState(
    val portrait: UserPortrait? = null,
    val isLoading: Boolean = false,
    /** 加载 / 网络错误（独立于"蒸馏失败"） */
    val loadError: String? = null,
    /** 蒸馏中：刚触发或轮询期间 */
    val isDistilling: Boolean = false,
    /** 轮询超时但后端可能仍在处理（软状态） */
    val isStillDistilling: Boolean = false,
)

public data class UserPortraitScope(
    val organizationId: String,
    val agentId: String,
) {
    public companion object {
        public val EMPTY: UserPortraitScope = UserPortraitScope("", "")
    }

    public val isValid: Boolean get() = organizationId.isNotBlank() && agentId.isNotBlank()
}

// ── 工具函数：解析 5 段 markdown ──────────────────────────
//
// 严格照搬 Electron parsePortraitSections（apps/tabtin-electron/src/renderer/src/
// services/userPortraitApi.ts:198-219）：按 ## 分段，每段第一行作 title，余下作 body。

public data class PortraitSection(val title: String, val body: String)

public fun parsePortraitSections(contentMd: String): List<PortraitSection> {
    if (contentMd.isBlank()) return emptyList()
    // Electron 用 /^##\s+/m 分割（多行模式）—— Kotlin 用 ^## 然后注意手动加 MULTILINE flag
    val regex = Regex("^##\\s+", RegexOption.MULTILINE)
    val parts = contentMd.split(regex).filter { it.isNotEmpty() }
    return parts.map { part ->
        val newlineIdx = part.indexOf('\n')
        if (newlineIdx < 0) {
            PortraitSection(part.trim(), "")
        } else {
            PortraitSection(
                title = part.substring(0, newlineIdx).trim(),
                body = part.substring(newlineIdx + 1).trim(),
            )
        }
    }
}
