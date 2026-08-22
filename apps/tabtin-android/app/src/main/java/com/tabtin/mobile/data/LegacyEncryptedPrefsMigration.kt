package com.tabtin.mobile.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 老用户从 `androidx.security.crypto:1.1.0-alpha06` (`EncryptedSharedPreferences`)
 * 到新 [SecureStorage] 的双读迁移层。
 *
 * Wave A1（2026-05-04）：deprecated 的 `androidx.security.crypto` 不能直接抹掉
 * 否则老用户升级后丢 token——必须先用旧 reader 读出 entries，再以新格式写到
 * [SecureStorage]。这是产品事故防线（与 iOS Wave 0 `Keychain.swift` 对老 token
 * 的兑现性同模式）。
 *
 * **设计理由**：把 `EncryptedSharedPreferences` / `MasterKey` 的 import 集中到
 * 这一个文件，让 deprecated API 的"传染面"只剩一个文件 + TokenManager init 块
 * 调用一次。后续完成全用户迁移并清理双读时（见 harness 总控 #L19），删本文件
 * + 改 TokenManager init 块即可，依赖在 `gradle/libs.versions.toml` 同步移除。
 *
 * **legacy prefsName 不可变**：值是 `"tabtin_secure_prefs"`——老用户已存 token
 * 是用这个 prefs name 写入的。新 [SecureStorage] 用一个**不同的** prefsName
 * （如 `tabtin_secure_prefs_v2`）以免文件冲突 / 加密格式混淆。
 *
 * **方案 A 选择**（详 Wave A1 反思 §"双读迁移方案 A 决策"）：
 * - 新 SecureStorage 用 `tabtin_secure_prefs_v2`
 * - 旧 EncryptedSharedPreferences 仍读 `tabtin_secure_prefs`
 * - 启动时一次性迁移：所有 entries 读出 → 用新格式写到 v2
 * - 迁移成功后**不**删旧 prefs（保留作回滚备份；harness #L19 决定何时清）
 *
 * **失败语义**：legacy reader 初始化或读取失败时（KeyStoreException / 数据
 * 损坏），整体迁移**静默跳过**（Log.w 记录），不阻塞 App 启动。这与"丢 token
 * → 用户重登"的副作用是同一档代价；硬 throw 反而会让"装新版 = 一定崩"成为
 * 系统性风险。
 *
 * **类型保真**：[migrateFromLegacyEncryptedPrefs] 按 [SharedPreferences.getAll]
 * 返回的 runtime 类型分发到对应的 [SecureStorage.Editor] putX 方法，确保
 * Long/Int/Boolean/String 在新存储里的语义一致。
 */
public object LegacyEncryptedPrefsMigration {
    private const val TAG = "LegacyPrefsMigration"

    /**
     * 老 prefsName。**绝对不可改**——改了等于宣布所有老用户重登。
     */
    public const val LEGACY_PREFS_NAME: String = "tabtin_secure_prefs"

    /**
     * 尝试用 deprecated `EncryptedSharedPreferences` 打开旧 prefs。
     *
     * 失败原因可能：
     * - 设备早期版本 API < 23（Tink 不支持） — 但 minSdk=26 已规避
     * - master key 被设备重置擦除（用户主动清应用数据是另一码事，那种情况
     *   旧 prefs 文件本身也没了）
     * - 某些厂商 ROM AndroidKeyStore 实现 buggy（Robolectric 单测环境也会复现）
     *
     * 任何失败 → 返回 null，调用方应跳过迁移。
     */
    public fun openLegacyPrefsOrNull(context: Context): SharedPreferences? {
        return try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context.applicationContext,
                LEGACY_PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (e: Exception) {
            Log.w(TAG, "Cannot open legacy EncryptedSharedPreferences; skip migration", e)
            null
        }
    }

    /**
     * 把 [legacyPrefs] 里所有 entries 迁移到 [target]。
     *
     * 行为约定：
     * - 只迁移 [target] 当前**不存在**的 key（双读语义：新格式优先；防止重复
     *   迁移把新写入的 fresh value 覆盖掉旧值）
     * - 类型按 runtime 分发；非 String/Long/Int/Boolean 的 entry（如 Set<String>）
     *   记 Log.w 跳过——TokenManager 当前 21 个 key 没有 Set 类型，这条只是兜底
     * - 单 key 迁移失败（加密失败 / 类型异常）记 Log.e 后继续下一个，不让单 key
     *   挂死整体迁移
     * - 迁移完成后**不**清旧 prefs（保留备份）
     *
     * @return 实际迁移条数（用于 telemetry / 调试）
     */
    public fun migrateFromLegacyEncryptedPrefs(
        legacyPrefs: SharedPreferences,
        target: SecureStorage,
    ): Int {
        var migrated = 0
        val all: Map<String, *> = try {
            legacyPrefs.all
        } catch (e: Exception) {
            Log.w(TAG, "Cannot enumerate legacy prefs entries; skip migration", e)
            return 0
        }
        if (all.isEmpty()) return 0

        for ((key, value) in all) {
            if (target.contains(key)) continue
            try {
                when (value) {
                    is String -> target.putString(key, value)
                    is Long -> target.putLong(key, value)
                    is Int -> target.putInt(key, value)
                    is Boolean -> target.putBoolean(key, value)
                    is Float -> target.putString(key, value.toString())
                    null -> { /* legacy 写过 null = 等同 remove，新存储也跳过 */ }
                    else -> {
                        Log.w(
                            TAG,
                            "Skip migration of key='$key' with unsupported type ${value::class.java.name}",
                        )
                        continue
                    }
                }
                migrated++
            } catch (e: Exception) {
                Log.e(TAG, "Failed to migrate legacy entry key='$key'", e)
            }
        }
        return migrated
    }
}
