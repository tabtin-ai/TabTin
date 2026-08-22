package com.tabtin.mobile.features.version

import android.content.Context
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.data.api.VersionApi
import com.tabtin.mobile.data.model.VersionGateDecision
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import javax.inject.Inject

/**
 * 移动端版本门禁：冷启动查询后端，按 build 号决定是否强制/推荐更新。
 *
 * - 匿名请求，登录前就能拦；
 * - **失败放行 / 绝不因网络问题变砖**：强更（不可关闭）**只认本次会话实时拿到的服务端
 *   决策**（[isDecisionLive]），缓存里的 force 一律不用于拦截。冷启动断网/超时 → 无实时
 *   决策 → 放行进入 App；后端停用策略后用户在线即可被救援，不会被旧 force 缓存卡死；
 * - **缓存仅服务软提示连续性**：成功决策持久化到 SharedPreferences，离线时可沿用上次的
 *   soft 提示（可关闭、无变砖风险），并保留「稍后」去重记忆；
 * - 由后端算出 action，客户端只执行不自比版本。
 */
@HiltViewModel
public class VersionGateViewModel @Inject constructor(
    private val versionApi: VersionApi,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    private companion object {
        const val TAG = "VersionGate"
        const val PREFS = "version_gate"
        const val KEY_LAST_DECISION = "last_decision"
        const val KEY_DISMISSED_SOFT_BUILD = "dismissed_soft_build"
    }

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    private val _decision = MutableStateFlow(loadCachedDecision())
    public val decision: StateFlow<VersionGateDecision?> = _decision.asStateFlow()

    /**
     * 当前 [decision] 是否来自本次会话的实时成功请求（而非缓存）。
     * 强更拦截严格要求实时决策：缓存的 force 不得拦人，避免离线/后端已停用时变砖。
     */
    private val _isDecisionLive = MutableStateFlow(false)
    public val isDecisionLive: StateFlow<Boolean> = _isDecisionLive.asStateFlow()

    /**
     * 已被用户点「稍后」关闭过的软提示 latestBuild；持久化，跨冷启动生效。
     * 后端下发更高的 latestBuild（更新的版本）时才会再次提示。
     */
    private val _dismissedSoftBuild = MutableStateFlow(prefs.getInt(KEY_DISMISSED_SOFT_BUILD, 0))
    public val dismissedSoftBuild: StateFlow<Int> = _dismissedSoftBuild.asStateFlow()

    init {
        refresh()
    }

    public fun refresh() {
        viewModelScope.launch {
            try {
                val envelope = versionApi.checkVersionGate(build = BuildConfig.VERSION_CODE)
                val result = envelope.data
                if (envelope.success && result != null) {
                    _decision.value = result
                    _isDecisionLive.value = true
                    cacheDecision(result)
                }
            } catch (e: Exception) {
                // 失败放行：不把缓存决策升级为实时；强更绝不因接口不可用触发。
                Log.w(TAG, "version gate check failed: ${e.message}")
            }
        }
    }

    /** 用户对当前软提示点了「稍后」/「去更新」：记住这个 latestBuild，不再重复弹。 */
    public fun dismissSoftPrompt() {
        val decision = _decision.value ?: return
        if (!decision.isSoft) return
        val next = maxOf(_dismissedSoftBuild.value, decision.latestBuild)
        _dismissedSoftBuild.value = next
        prefs.edit().putInt(KEY_DISMISSED_SOFT_BUILD, next).apply()
    }

    private fun loadCachedDecision(): VersionGateDecision? {
        val raw = prefs.getString(KEY_LAST_DECISION, null) ?: return null
        return try {
            json.decodeFromString(VersionGateDecision.serializer(), raw)
        } catch (_: Exception) {
            null
        }
    }

    private fun cacheDecision(decision: VersionGateDecision) {
        try {
            prefs.edit()
                .putString(KEY_LAST_DECISION, json.encodeToString(VersionGateDecision.serializer(), decision))
                .apply()
        } catch (_: Exception) {
            // 缓存失败不影响主流程
        }
    }
}
