package com.tabtin.mobile.util

import android.app.Application
import android.content.Context
import com.tabtin.mobile.data.LegacyEncryptedPrefsMigration
import com.tabtin.mobile.data.SecureStorage
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Wave A1（2026-05-04）SecureStorage / LegacyEncryptedPrefsMigration 单测，
 * 镜像 iOS Wave 0 `testLegacyKeychainAccessData_canBeReadByNewKeychain` 5 case
 *
 * **关心的产品事故防线**：老用户从 deprecated `EncryptedSharedPreferences` 升级
 * 到新 [SecureStorage] 后，access_token / refresh_token / expires_at / device_id /
 * organizationId 5 类核心 key **全部能读出**——任何一个丢失 = 用户被强制登出 =
 * 产品事故。
 *
 * **测试架构**：
 * - 用 [RobolectricTestRunner] 拿到真实 [Application] / [SharedPreferences]
 * - 用 `@Config(application = Application::class)` **不**拉起 `TabTinApp`
 *   （避免 Hilt 注入链触发 W A0.2 反思 §3 的 KeyStoreException）
 * - SecureStorage 通过 internal 构造器注入 in-memory SecretKey，避开真实
 *   AndroidKeyStore（Robolectric 4.14 对 KeyGenParameterSpec.Builder 支持脆弱）
 * - "legacy EncryptedSharedPreferences" 用真实 [SharedPreferences] 模拟
 *   （EncryptedSharedPreferences 的对外接口就是 SharedPreferences；我们关心
 *   的是 [LegacyEncryptedPrefsMigration.migrateFromLegacyEncryptedPrefs] 这条
 *   路径，不必真跑 Tink 加密）
 *
 * **5 case 列表**（与 W0 镜像一一对应）：
 * 1. testAccessToken_legacyToNew
 * 2. testRefreshToken_legacyToNew
 * 3. testExpiresAt_legacyToNew（Long 类型）
 * 4. testDeviceId_legacyToNew
 * 5. testOrganizationId_legacyToNew
 *
 * 另加 3 case 覆盖 SecureStorage 自身契约和迁移规则：
 * - testRoundTrip_allTypes
 * - testNewValueWins_doesNotOverwrite
 * - testEncryptedAtRest（落盘 prefs 里**不是**明文）
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class TokenManagerSecureStorageMigrationTest {

    private lateinit var context: Context
    private lateinit var inMemoryKey: SecretKey

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        inMemoryKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        // 每个测试用一份干净的 prefs。Robolectric 在测试间共享 ApplicationProvider
        // 但 Application 实例每个测试新建，对应的 prefs 文件也独立——但保险起见
        // 还是显式清一下（不依赖 Robolectric 内部行为）。
        context.getSharedPreferences(LegacyEncryptedPrefsMigration.LEGACY_PREFS_NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
        context.getSharedPreferences(TokenManager.NEW_PREFS_NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
    }

    private fun newSecureStorage(): SecureStorage =
        SecureStorage(context, TokenManager.NEW_PREFS_NAME, inMemoryKey)

    /**
     * 模拟"旧 EncryptedSharedPreferences 已经写过的数据"。
     *
     * EncryptedSharedPreferences 对外暴露的 [SharedPreferences] 接口在 [getAll]
     * 时返回**解密后的明文 entries**——这是 Tink 的契约。所以从迁移代码视角
     * 看，"legacy" 跟"普通 SharedPreferences"是同构的；用普通 SP 模拟测试
     * 是有效的（关心的是 [LegacyEncryptedPrefsMigration.migrateFromLegacyEncryptedPrefs]
     * 把入参里的 entries 正确搬到 SecureStorage）。
     */
    private fun seedLegacyEntry(key: String, value: Any) {
        val legacy = context.getSharedPreferences(
            LegacyEncryptedPrefsMigration.LEGACY_PREFS_NAME,
            Context.MODE_PRIVATE,
        )
        val editor = legacy.edit()
        when (value) {
            is String -> editor.putString(key, value)
            is Long -> editor.putLong(key, value)
            is Int -> editor.putInt(key, value)
            is Boolean -> editor.putBoolean(key, value)
            else -> error("unsupported type ${value::class.java.name}")
        }
        editor.commit()
    }

    private fun runMigration(target: SecureStorage): Int {
        val legacy = context.getSharedPreferences(
            LegacyEncryptedPrefsMigration.LEGACY_PREFS_NAME,
            Context.MODE_PRIVATE,
        )
        return LegacyEncryptedPrefsMigration.migrateFromLegacyEncryptedPrefs(legacy, target)
    }

    // ─── 5 case 数据迁移测试（W0 镜像） ──────────────────────────────

    @Test
    fun `legacy access_token migrates to new SecureStorage`() {
        seedLegacyEntry("auth_token", "legacy-access-token-abc")
        val target = newSecureStorage()

        val migrated = runMigration(target)

        assertTrue("at least 1 entry should be migrated", migrated >= 1)
        assertEquals(
            "Wave A1: access_token must survive migration (产品事故防线 #1)",
            "legacy-access-token-abc",
            target.getString("auth_token"),
        )
    }

    @Test
    fun `legacy refresh_token migrates to new SecureStorage`() {
        seedLegacyEntry("refresh_token", "legacy-refresh-xyz-789")
        val target = newSecureStorage()

        runMigration(target)

        assertEquals(
            "Wave A1: refresh_token must survive migration (产品事故防线 #2)",
            "legacy-refresh-xyz-789",
            target.getString("refresh_token"),
        )
    }

    @Test
    fun `legacy access_token_expires_at (Long) migrates to new SecureStorage`() {
        val expiresAt = 1_731_000_000_000L
        seedLegacyEntry("access_token_expires_at", expiresAt)
        val target = newSecureStorage()

        runMigration(target)

        assertEquals(
            "Wave A1: expires_at (Long) must survive migration with type fidelity (产品事故防线 #3)",
            expiresAt,
            target.getLong("access_token_expires_at"),
        )
    }

    @Test
    fun `legacy device_id migrates to new SecureStorage`() {
        seedLegacyEntry("device_id", "android-legacydev123")
        val target = newSecureStorage()

        runMigration(target)

        assertEquals(
            "Wave A1: device_id must survive migration—丢了等于 unique-device 标识被重置 (产品事故防线 #4)",
            "android-legacydev123",
            target.getString("device_id"),
        )
    }

    @Test
    fun `legacy organization_id migrates to new SecureStorage`() {
        seedLegacyEntry("workspace_id", "wt-legacy-987")
        val target = newSecureStorage()

        runMigration(target)

        assertEquals(
            "Wave A1: organizationId (key=workspace_id) must survive migration (产品事故防线 #5)",
            "wt-legacy-987",
            target.getString("workspace_id"),
        )
    }

    // ─── SecureStorage 自身契约 ────────────────────────────────────

    @Test
    fun `round-trip works for String Long Int Boolean`() {
        val storage = newSecureStorage()
        storage.putString("s_key", "hello")
        storage.putLong("l_key", 42L)
        storage.putInt("i_key", 7)
        storage.putBoolean("b_key", true)

        assertEquals("hello", storage.getString("s_key"))
        assertEquals(42L, storage.getLong("l_key"))
        assertEquals(7, storage.getInt("i_key"))
        assertTrue(storage.getBoolean("b_key"))
    }

    @Test
    fun `migration does not overwrite values already in new storage`() {
        // 用户清了 app data 又重装的边界场景：legacy 还残留旧值，新 storage
        // 已经有用户重新登录的 fresh 值——迁移**绝对不能**覆盖 fresh 值。
        seedLegacyEntry("auth_token", "STALE_LEGACY_TOKEN")
        val target = newSecureStorage()
        target.putString("auth_token", "fresh-after-relogin")

        runMigration(target)

        assertEquals(
            "迁移必须保护 SecureStorage 已有的 fresh 值；否则用户重登后立即被踢回旧会话",
            "fresh-after-relogin",
            target.getString("auth_token"),
        )
    }

    @Test
    fun `value at rest in raw SharedPreferences does not contain plaintext bytes`() {
        // 加密生效的事实校验。Wave A1 review 优雅 #1：把"contains 子串"改成
        // byte-subarray 检查——子串检查对短 plaintext / 巧合 base64 字母会假阳性，
        // 但 plaintext UTF-8 bytes 出现在 ciphertext 原始 bytes 里 = AES 真坏了。
        val storage = newSecureStorage()
        val plaintext = "Some-User-Token-2026"
        storage.putString("auth_token", plaintext)

        val raw = context.getSharedPreferences(TokenManager.NEW_PREFS_NAME, Context.MODE_PRIVATE)
            .getString("auth_token", null)

        assertNotNull("encrypted value should be persisted", raw)
        val rawBytes = java.util.Base64.getDecoder().decode(raw!!)
        val plaintextBytes = plaintext.toByteArray(Charsets.UTF_8)
        assertFalse(
            "原文 UTF-8 bytes 出现在 ciphertext raw bytes 中 = 加密失败",
            containsSubArray(rawBytes, plaintextBytes),
        )
        assertEquals(
            "解密回来必须等于原值",
            plaintext,
            storage.getString("auth_token"),
        )
    }

    @Test
    fun `same plaintext encrypted twice produces different ciphertext (random IV)`() {
        // Wave A1 review 优雅 #1：GCM 安全的关键是每次新 IV——同 plaintext + 同 key
        // 多次加密**必须**产生不同 ciphertext。否则未来若有人误改成静态 IV（如为
        // deterministic 测试方便），安全性偷偷打破而无人察觉。
        val storage = newSecureStorage()
        val rawPrefs = context.getSharedPreferences(TokenManager.NEW_PREFS_NAME, Context.MODE_PRIVATE)

        storage.putString("k", "same-value")
        val raw1 = rawPrefs.getString("k", null)
        storage.putString("k", "same-value")
        val raw2 = rawPrefs.getString("k", null)

        assertNotNull(raw1)
        assertNotNull(raw2)
        org.junit.Assert.assertNotEquals(
            "两次加密同一 plaintext 应产生不同 ciphertext（IV 必须随机）",
            raw1, raw2,
        )
    }

    @Test
    fun `decrypt failure returns default value not crash (fail-soft)`() {
        // Wave A1 review 风险 2 必修：getString 解密失败时**不**抛 throw，返回
        // defaultValue。否则 TokenManager 21 个 getter 全部成为 crash 入口。
        // 模拟 corruption：直接往底层 SharedPreferences 写一段不可解的 base64。
        val rawPrefs = context.getSharedPreferences(TokenManager.NEW_PREFS_NAME, Context.MODE_PRIVATE)
        rawPrefs.edit().putString("auth_token", "AAAAAAAAAAAAAAAAAAAAAAAA").commit()

        val storage = newSecureStorage()
        val result = storage.getString("auth_token", "default-fallback")

        assertEquals(
            "解密失败应 fail-soft 返回 defaultValue（不抛异常 = 用户重登而非 App 崩溃）",
            "default-fallback",
            result,
        )
    }

    /**
     * 检查 [rawBytes] 是否包含 [needle] 作为子序列。用于 encrypt-at-rest 测试
     * 验证原文 bytes 不出现在 ciphertext bytes 中。
     */
    private fun containsSubArray(rawBytes: ByteArray, needle: ByteArray): Boolean {
        if (needle.isEmpty() || rawBytes.size < needle.size) return false
        outer@ for (i in 0..(rawBytes.size - needle.size)) {
            for (j in needle.indices) {
                if (rawBytes[i + j] != needle[j]) continue@outer
            }
            return true
        }
        return false
    }

    @Test
    fun `migration returns 0 when legacy is empty`() {
        val target = newSecureStorage()
        assertEquals(0, runMigration(target))
        assertNull(target.getString("auth_token"))
    }

    @Test
    fun `clear wipes legacy prefs file to prevent token resurrection`() {
        // Wave A1 review 风险 1 必修：手机共享场景 + 用户登出后力退 + 重启的真实
        // 隐私事故路径——A 账号登出 + B 登录登出 + 重启 → A 会话复活。
        //
        // 修复验收：[TokenManager.clear] 直接清 legacy prefs 文件（绕过 Tink），
        // 这样下次 [LegacyEncryptedPrefsMigration.migrateFromLegacyEncryptedPrefs]
        // 看到的 legacy.all 是空的 → migration 0 entry → 不复活老 token。
        //
        // 注：本测试**不**依赖 TokenManager init 块的真实 EncryptedSharedPreferences
        // 路径（Robolectric 下 KeyStoreException 风险），只验证 clear() 副作用。
        // init 块在 Robolectric 下因 KeyStoreException 静默跳过 = 失败语义已验证。

        // 步骤 0：seed legacy prefs（用 plain SP 模拟，与其它 5 case 测试一致）
        val legacyFile = context.getSharedPreferences(
            LegacyEncryptedPrefsMigration.LEGACY_PREFS_NAME, Context.MODE_PRIVATE,
        )
        legacyFile.edit()
            .putString("auth_token", "ghost-token-from-old-account")
            .putString("workspace_id", "ghost-organization")
            .commit()
        assertEquals("ghost-token-from-old-account", legacyFile.getString("auth_token", null))

        // 步骤 1：用户登出 = TokenManager.clear()
        val tm = TokenManager(context)
        tm.clear()

        // 步骤 2：验证 legacy 文件被清空
        assertNull(
            "Wave A1 风险 1：clear() 必须清 legacy prefs 的 auth_token；" +
                "残留 = 重启后 migration 复活老 token = 手机共享场景下 A 账号会话泄露给 B",
            legacyFile.getString("auth_token", null),
        )
        assertNull(
            "Wave A1 风险 1：clear() 必须清 legacy prefs 的 workspace_id；" +
                "残留 = 用户重登时挂到老 organization 上",
            legacyFile.getString("workspace_id", null),
        )

        // 步骤 3：等价验证 —— 用 migrateFromLegacyEncryptedPrefs 模拟"重启后 init 块"，
        // 应该 0 条迁移
        val targetAfterRestart = newSecureStorage()
        val migrated = LegacyEncryptedPrefsMigration.migrateFromLegacyEncryptedPrefs(
            legacyFile, targetAfterRestart,
        )
        assertEquals(
            "重启后再次 migration 应迁移 0 条（legacy 已被 clear 清空）",
            0, migrated,
        )
        assertNull(
            "重启后 SecureStorage 应不含被复活的 token",
            targetAfterRestart.getString("auth_token"),
        )
    }

    @Test
    fun `clear removes session but preserves selected network environment`() {
        val storage = newSecureStorage()
        storage.putString("auth_token", "session-token")
        storage.putString("refresh_token", "refresh-token")
        storage.putString("daemon_api_base_url", "https://api-test.example.com/api")
        storage.putString("debug_environment_preset", "development")
        storage.putBoolean("debug_entry_unlocked", true)

        TokenManager.clearSessionStorage(storage, preserveLegacyDebugOverrides = true)

        assertNull(storage.getString("auth_token"))
        assertNull(storage.getString("refresh_token"))
        assertEquals("https://api-test.example.com/api", storage.getString("daemon_api_base_url"))
        assertEquals("development", storage.getString("debug_environment_preset"))
        assertTrue(storage.getBoolean("debug_entry_unlocked"))
    }

    @Test
    fun `migration migrates all 5 critical keys in one pass`() {
        // W0 testLegacyKeychainAccessData 镜像的端到端集成版本：5 类 key 同时 seed，
        // 一次迁移全部到位。
        seedLegacyEntry("auth_token", "tok-A")
        seedLegacyEntry("refresh_token", "tok-R")
        seedLegacyEntry("access_token_expires_at", 1_700_000_000_000L)
        seedLegacyEntry("device_id", "dev-X")
        seedLegacyEntry("workspace_id", "wt-Y")

        val target = newSecureStorage()
        val migrated = runMigration(target)

        assertEquals("应迁移 5 entry", 5, migrated)
        assertEquals("tok-A", target.getString("auth_token"))
        assertEquals("tok-R", target.getString("refresh_token"))
        assertEquals(1_700_000_000_000L, target.getLong("access_token_expires_at"))
        assertEquals("dev-X", target.getString("device_id"))
        assertEquals("wt-Y", target.getString("workspace_id"))
    }
}
