package com.tabtin.mobile.features.version

import android.content.Context
import com.tabtin.mobile.data.api.VersionApi
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.VersionGateDecision
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.IOException

/**
 * 回归：强更绝不因缓存 / 网络失败把 App 变砖。
 * 强更（不可关闭）只认本次会话实时拿到的 force 决策；缓存里的 force 不得拦人。
 */
@RunWith(RobolectricTestRunner::class)
class VersionGateViewModelTest {

    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val json = Json { ignoreUnknownKeys = true }

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        // 清掉可能残留的缓存，保证用例独立。
        context.getSharedPreferences("version_gate", Context.MODE_PRIVATE)
            .edit().clear().commit()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        context.getSharedPreferences("version_gate", Context.MODE_PRIVATE)
            .edit().clear().commit()
    }

    private fun seedCachedDecision(decision: VersionGateDecision) {
        context.getSharedPreferences("version_gate", Context.MODE_PRIVATE)
            .edit()
            .putString("last_decision", json.encodeToString(VersionGateDecision.serializer(), decision))
            .commit()
    }

    /** 离线（请求抛异常）：任何决策都不实时。 */
    private class OfflineApi : VersionApi {
        override suspend fun checkVersionGate(platform: String, build: Int): ApiEnvelope<VersionGateDecision> =
            throw IOException("offline")
    }

    /** 在线返回 force。 */
    private class ForceApi : VersionApi {
        override suspend fun checkVersionGate(platform: String, build: Int): ApiEnvelope<VersionGateDecision> =
            ApiEnvelope(success = true, data = VersionGateDecision(action = "force", latestBuild = 200))
    }

    /**
     * 核心回归：缓存里是 force + 离线 → 决策虽从缓存恢复，但 isDecisionLive=false，
     * 强更弹窗不应展示（AppNavigation 条件为 isForce && isDecisionLive）。
     * 否则服务端停用策略 / 用户离线时，曾拿过一次 force 的旧客户端会永久变砖。
     */
    @Test
    fun `cached force offline does not become live gate`() {
        seedCachedDecision(VersionGateDecision(action = "force", title = "必须更新", latestBuild = 200))

        val vm = VersionGateViewModel(OfflineApi(), context)

        assertTrue("决策从缓存恢复", vm.decision.value?.isForce == true)
        assertFalse("缓存 force 不应升级为实时（否则离线/停用后变砖）", vm.isDecisionLive.value)
    }

    /** 在线实时拿到 force：isDecisionLive=true，允许强更拦截。 */
    @Test
    fun `live force marks decision live`() {
        val vm = VersionGateViewModel(ForceApi(), context)

        assertTrue(vm.isDecisionLive.value)
        assertTrue(vm.decision.value?.isForce == true)
    }

    /** 冷启动无缓存 + 离线：无决策、不实时，一律放行。 */
    @Test
    fun `no cache offline means no gate`() {
        val vm = VersionGateViewModel(OfflineApi(), context)

        assertFalse(vm.isDecisionLive.value)
        assertTrue(vm.decision.value == null)
    }
}
