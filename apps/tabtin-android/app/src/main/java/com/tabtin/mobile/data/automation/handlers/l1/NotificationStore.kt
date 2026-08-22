package com.tabtin.mobile.data.automation.handlers.l1

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.tabtin.mobile.util.TokenManager
import dagger.Lazy
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class NotificationStore @Inject constructor(
    @ApplicationContext private val context: Context,
    private val tokenManager: Lazy<TokenManager>,
) {
    // NT-010: 改用 ArrayDeque，removeFirst()/addLast() 均为 O(1)，避免 ArrayList O(n) 删除性能问题
    private val recent = ArrayDeque<JsonObject>()
    private val maxSize = 200

    private val prefs = context.getSharedPreferences("tabtin_notifications", Context.MODE_PRIVATE)
    private val saveHandler = Handler(Looper.getMainLooper())
    private val saveRunnable = Runnable { performSaveToDisk() }

    // NT-012: 动态 key，加 userId 前缀防多账号数据串台
    private val prefsKey: String
        get() = "recent_notifications_${tokenManager.get().userId ?: "anon"}"

    // NT-009: 委托给共享工具函数，消除与 DeviceRuntimeDescriptor 中的重复实现
    public val isListenerEnabled: Boolean
        get() = NotificationListenerUtils.isListenerEnabled(context)

    public data class NotificationAction(val title: String, val hasRemoteInput: Boolean)

    /**
     * NT-012: 切换账号或 NLS 服务首次连接时调用，清除内存并重新从当前用户的磁盘分区加载。
     * 由 [TabTinNotificationListener.onListenerConnected] 调用。
     */
    @Synchronized
    public fun reloadForCurrentUser() {
        recent.clear()
        loadFromDisk()
    }

    /**
     * NT-008: Service onDestroy 时调用：取消尚未执行的延迟保存，立即将内存中的数据落盘。
     * 防止 Handler 持有 Runnable 引用在 Service 销毁后仍触发。
     */
    public fun shutdown() {
        saveHandler.removeCallbacks(saveRunnable)
        performSaveToDisk()
    }

    @Synchronized
    public fun onNotificationPosted(
        key: String,
        packageName: String,
        title: String?,
        text: String?,
        bigText: String?,
        postTime: Long,
        actions: List<NotificationAction>? = null,
        subText: String? = null,
        infoText: String? = null,
        category: String? = null,
    ) {
        recent.removeAll { (it["key"] as? JsonPrimitive)?.content == key }
        val entry = buildJsonObject {
            put("key", key)
            put("package", packageName)
            title?.let { put("title", it) }
            text?.let { put("text", it) }
            bigText?.takeIf { it != text }?.let { put("big_text", it) }
            put("time", postTime)
            subText?.let { put("sub_text", it) }
            infoText?.let { put("info_text", it) }
            category?.let { put("category", it) }
            if (!actions.isNullOrEmpty()) {
                put("actions", buildJsonArray {
                    actions.forEach { a ->
                        add(buildJsonObject {
                            put("title", a.title)
                            if (a.hasRemoteInput) put("has_remote_input", true)
                        })
                    }
                })
            }
        }
        recent.addLast(entry)
        while (recent.size > maxSize) recent.removeFirst()
        scheduleSave()
    }

    @Synchronized
    public fun onNotificationRemoved(key: String) {
        if (recent.removeAll { (it["key"] as? JsonPrimitive)?.content == key }) {
            scheduleSave()
        }
    }

    @Synchronized
    public fun getRecent(limit: Int, packageFilter: String? = null): List<JsonObject> {
        val filtered = if (packageFilter != null) {
            recent.filter { (it["package"] as? JsonPrimitive)?.content == packageFilter }
        } else {
            recent.toList()
        }
        return filtered.takeLast(limit).reversed()
    }

    private fun scheduleSave() {
        saveHandler.removeCallbacks(saveRunnable)
        saveHandler.postDelayed(saveRunnable, SAVE_DEBOUNCE_MS)
    }

    @Synchronized
    private fun performSaveToDisk() {
        val arr = buildJsonArray { recent.forEach { add(it) } }
        prefs.edit().putString(prefsKey, arr.toString()).apply()
    }

    @Synchronized
    private fun loadFromDisk() {
        val raw = prefs.getString(prefsKey, null) ?: return
        try {
            val arr = Json.parseToJsonElement(raw).jsonArray
            for (el in arr) recent.addLast(el.jsonObject)
            while (recent.size > maxSize) recent.removeFirst()
        } catch (_: Exception) { /* 数据损坏时从头开始，不崩溃 */ }
    }

    public companion object {
        private const val SAVE_DEBOUNCE_MS = 200L
    }
}
