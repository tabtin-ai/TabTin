package com.tabtin.mobile.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES/GCM 加密的 SharedPreferences 包装器。
 *
 * Wave A1（2026-05-04）：替换 deprecated 的 `androidx.security.crypto:1.1.0-alpha06`
 * （EncryptedSharedPreferences）。设计选型与 iOS Wave 0 `Keychain.swift` 镜像：
 * 用 SDK 一等公民 API（AndroidKeyStore + Cipher）自实现轻量加密层，避免被
 * 上游 alpha 包的发布周期 / 漏洞修补节奏绑架。
 *
 * **加密格式**：每个 value 先转成 UTF-8 bytes，用 AES/GCM/NoPadding 加密，
 * 输出 = `iv (12 bytes) || ciphertext` 拼接后 Base64 编码，存到底层
 * `SharedPreferences` 的 String entry。这与 EncryptedSharedPreferences 的
 * 内部格式不兼容（它走 Tink），所以新旧不能共用同一个 prefsName。
 *
 * **Prefs key 明文（与 EncryptedSharedPreferences 的语义差异）**：本实现**不加密**
 * entry key，直接用 String key 存到底层 SharedPreferences；EncryptedSharedPreferences
 * 默认走 `PrefKeyEncryptionScheme.AES256_SIV` 把 key 编成不可读 base64。
 * 此处选不加密 key 的理由：
 * - TabTin 的 prefs key 名都是技术常量（`auth_token` / `device_id` 等），不含 PII
 * - `/data/data/<app>/shared_prefs/<name>.xml` 在非 root 设备上不可读，root 用户已经能
 *   绕过任何应用层加密，加密 key 提供的边际价值低
 * - SIV 确定性加密需独立 key + 复杂度，不值得
 *
 * 若未来某 key 名本身敏感，请**先讨论**再决定升级到加密 key 方案。
 *
 * **类型策略**：所有类型（String / Long / Int / Boolean）统一序列化为 String
 * 后加密，避免 Tink-style 的 byte-level type tag。简化到能跟 SharedPreferences
 * API 表面一一对应即可。
 *
 * **密钥管理**：master key 存 AndroidKeyStore（硬件支持的设备走 TEE / StrongBox），
 * alias 固定 `tabtin_master_key`，由 [SecureStorage] 实例 lazy 初始化（首次
 * 用户操作时生成；幂等）。`setUserAuthenticationRequired(false)` 因为 token
 * 持久化不该绑定锁屏密码（卸载-重装才丢，跟 EncryptedSharedPreferences 的
 * 行为对齐）。
 *
 * **线程安全**：内部 [lock] 把所有读写串行化。AES/GCM Cipher 不是 thread-safe，
 * 所以**不能**让多 thread 直接用同一个 Cipher 实例；每个加解密都获取一次新
 * Cipher（`Cipher.getInstance` 是 thread-safe 的工厂方法）。
 *
 * **API 形状**对齐 `androidx.security.crypto.EncryptedSharedPreferences`，调用方
 * 替换成本最小化。
 *
 * 老用户从 `EncryptedSharedPreferences` 迁移见 [LegacyEncryptedPrefsMigration]；
 * `TokenManager` 在 init 块调用一次性迁移。
 */
public class SecureStorage(
    context: Context,
    prefsName: String,
    /**
     * **Test-only**：注入预生成的 SecretKey 跳过 AndroidKeyStore 初始化。
     * 生产路径调用方传 null（或省略，走默认值），由 [loadOrCreateMasterKey]
     * 走 AndroidKeyStore + AES/GCM 真实路径；单测用内存 [KeyGenerator.getInstance("AES")]
     * 生成的 256-bit key 走纯 JVM Cipher，避开 W A0.2 反思 §3 描述的 Robolectric
     * AndroidKeyStore shadow 失效问题。
     *
     * 之所以放在主构造器而非通过 [internal] secondary：Hilt @Inject 链会强制
     * primary constructor，加 secondary 容易引发"两个构造器都匹配 (context, prefsName)"
     * 的重载分辨二义性。
     */
    secretKeyOverride: SecretKey? = null,
) {
    private val appContext = context.applicationContext
    private val prefs: SharedPreferences =
        appContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    private val lock = Any()

    private val secretKey: SecretKey by lazy {
        secretKeyOverride ?: loadOrCreateMasterKey()
    }

    // ─── 读 API（mirror SharedPreferences） ─────────────────────────

    public fun getString(key: String, defaultValue: String? = null): String? {
        synchronized(lock) {
            val encoded = prefs.getString(key, null) ?: return defaultValue
            return try {
                decryptToString(encoded)
            } catch (e: Exception) {
                // Wave A1 产品 review 必修 #2：解密失败时**不**抛 throw 给调用方，
                // 而是返回 defaultValue（语义"解密坏 = 当作没找到 = 没登录"）。
                // 失败场景虽稀有但真实：设备重置擦了 KeyStore alias（厂商 ROM bug） /
                // GCM tag 被破坏 / KeyStore 自己 corruption。硬抛会让 TokenManager 21 个
                // getter 全部成为 crash 入口；改为 fail-soft 后用户被强制登出（可接受），
                // 系统不崩。但仍打 Log.w 让 Crashlytics / logcat 可观测。
                Log.w(TAG, "Decrypt failed for key='$key' (returning default); cause=${e.message}")
                defaultValue
            }
        }
    }

    public fun getLong(key: String, defaultValue: Long = 0L): Long {
        val raw = getString(key, null) ?: return defaultValue
        return raw.toLongOrNull() ?: defaultValue
    }

    public fun getInt(key: String, defaultValue: Int = 0): Int {
        val raw = getString(key, null) ?: return defaultValue
        return raw.toIntOrNull() ?: defaultValue
    }

    public fun getBoolean(key: String, defaultValue: Boolean = false): Boolean {
        val raw = getString(key, null) ?: return defaultValue
        return when (raw) {
            "true" -> true
            "false" -> false
            else -> defaultValue
        }
    }

    public fun contains(key: String): Boolean {
        synchronized(lock) {
            return prefs.contains(key)
        }
    }

    // ─── 写 API（mirror SharedPreferences） ─────────────────────────

    public fun putString(key: String, value: String?): SecureStorage {
        synchronized(lock) {
            if (value == null) {
                prefs.edit().remove(key).apply()
            } else {
                val encoded = encryptString(value, key)
                prefs.edit().putString(key, encoded).apply()
            }
        }
        return this
    }

    public fun putLong(key: String, value: Long): SecureStorage = putString(key, value.toString())

    public fun putInt(key: String, value: Int): SecureStorage = putString(key, value.toString())

    public fun putBoolean(key: String, value: Boolean): SecureStorage =
        putString(key, if (value) "true" else "false")

    public fun remove(key: String): SecureStorage {
        synchronized(lock) {
            prefs.edit().remove(key).apply()
        }
        return this
    }

    public fun clear(): SecureStorage {
        synchronized(lock) {
            prefs.edit().clear().apply()
        }
        return this
    }

    /**
     * 批量写。语义跟 [SharedPreferences.Editor] 完全对齐：所有改动 in-memory
     * 累积，[Editor.apply] 调用时才一次性 atomically 落盘。
     *
     * 注意：[SharedPreferences.Editor] 自己是 atomic 的（OS 级 mmap fsync），
     * 所以即使加密层按 key 顺序加密，落盘仍是一次性事务，不会出现"半写入"。
     */
    public fun edit(): Editor = Editor()

    public inner class Editor internal constructor() {
        private val pending: MutableMap<String, String?> = mutableMapOf()
        private val removals: MutableSet<String> = mutableSetOf()
        private var clearAll = false

        public fun putString(key: String, value: String?): Editor {
            if (value == null) {
                removals.add(key)
                pending.remove(key)
            } else {
                pending[key] = value
                removals.remove(key)
            }
            return this
        }

        public fun putLong(key: String, value: Long): Editor = putString(key, value.toString())

        public fun putInt(key: String, value: Int): Editor = putString(key, value.toString())

        public fun putBoolean(key: String, value: Boolean): Editor =
            putString(key, if (value) "true" else "false")

        public fun remove(key: String): Editor {
            removals.add(key)
            pending.remove(key)
            return this
        }

        public fun clear(): Editor {
            clearAll = true
            pending.clear()
            removals.clear()
            return this
        }

        public fun apply() {
            synchronized(lock) {
                val nativeEditor = prefs.edit()
                if (clearAll) {
                    nativeEditor.clear()
                }
                removals.forEach { nativeEditor.remove(it) }
                pending.forEach { (k, v) ->
                    if (v != null) {
                        nativeEditor.putString(k, encryptString(v, k))
                    } else {
                        nativeEditor.remove(k)
                    }
                }
                nativeEditor.apply()
            }
        }
    }

    // ─── 加解密 ─────────────────────────────────────────────────────

    private fun encryptString(plaintext: String, keyForError: String): String {
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val combined = ByteArray(iv.size + ciphertext.size).also {
                System.arraycopy(iv, 0, it, 0, iv.size)
                System.arraycopy(ciphertext, 0, it, iv.size, ciphertext.size)
            }
            Base64.getEncoder().encodeToString(combined)
        } catch (e: Exception) {
            throw SecureStorageException.EncryptFailed(keyForError, e)
        }
    }

    private fun decryptToString(base64Encoded: String): String {
        val combined = Base64.getDecoder().decode(base64Encoded)
        require(combined.size > GCM_IV_SIZE_BYTES) { "ciphertext too short" }
        val iv = combined.copyOfRange(0, GCM_IV_SIZE_BYTES)
        val ciphertext = combined.copyOfRange(GCM_IV_SIZE_BYTES, combined.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_SIZE_BITS, iv))
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }

    private fun loadOrCreateMasterKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        keyStore.getKey(MASTER_KEY_ALIAS, null)?.let { return it as SecretKey }

        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        val spec = KeyGenParameterSpec.Builder(
            MASTER_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(AES_KEY_SIZE_BITS)
            // 与 EncryptedSharedPreferences 一致：token 不绑定锁屏密码，卸载-重装才丢。
            // 不开 setUserAuthenticationRequired(true) 因为会让进程在锁屏后无法解密。
            .setUserAuthenticationRequired(false)
            .build()
        keyGen.init(spec)
        return keyGen.generateKey()
    }

    public companion object {
        private const val TAG = "SecureStorage"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"

        /**
         * AndroidKeyStore master key alias。**绝对不可改**——alias 一旦改，所有
         * 已加密 entry 用的旧 key 找不回，[getString] 全部撞 [SecureStorageException.DecryptFailed]
         * → 用户被强制登出（与 [LegacyEncryptedPrefsMigration.LEGACY_PREFS_NAME] /
         * [TokenManager.NEW_PREFS_NAME] 同款不可变约束）。
         *
         * 如未来要做"分环境隔离"等需求，应**新增**一个 alias 走双 alias 共存 + 迁移
         * 路径，绝不直接 rename 此常量。
         */
        public const val MASTER_KEY_ALIAS: String = "tabtin_master_key"

        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_SIZE_BYTES = 12
        private const val GCM_TAG_SIZE_BITS = 128
        private const val AES_KEY_SIZE_BITS = 256
    }
}

/**
 * SecureStorage 加解密 / 密钥管理失败的具体类型。
 *
 * 跟 EncryptedSharedPreferences 把 KeyStoreException / GeneralSecurityException
 * 直接抛 [GeneralSecurityException] 不同，[SecureStorage] 把失败按"哪个 key 上"
 * 标注出来，方便排查"是某个 entry 损坏还是 master key 没了"——后者通常意味
 * 着用户在系统设置清了应用数据 / 密钥被设备重置擦除（罕见但生产真发生过）。
 */
public sealed class SecureStorageException(message: String, cause: Throwable? = null) :
    RuntimeException(message, cause) {
    public class EncryptFailed(key: String, cause: Throwable) :
        SecureStorageException("Failed to encrypt value for key '$key'", cause)

    public class DecryptFailed(key: String, cause: Throwable) :
        SecureStorageException("Failed to decrypt value for key '$key'", cause)
}
