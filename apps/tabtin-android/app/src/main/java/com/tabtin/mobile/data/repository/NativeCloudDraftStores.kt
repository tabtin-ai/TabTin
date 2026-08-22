package com.tabtin.mobile.data.repository

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldType
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

internal const val TABDOC_DRAFT_PREFERENCES: String = "tabdoc_drafts"
internal const val TABDATA_DRAFT_PREFERENCES: String = "tabdata_native_drafts"

@Serializable
public data class TabDataDraftScope(
    val userId: String,
    val organizationId: String,
    val tableId: String,
    val recordId: String,
) {
    public fun isValid(): Boolean =
        userId.isNotBlank() && organizationId.isNotBlank() && tableId.isNotBlank() && recordId.isNotBlank()
}

@Serializable
public data class TabDataDraftFieldIdentity(
    @kotlinx.serialization.SerialName("field_id") val fieldId: String,
    @kotlinx.serialization.SerialName("field_type") val fieldType: String,
)

@Serializable
public data class TabDataDraftSnapshot(
    val scope: TabDataDraftScope,
    val original: JsonObject,
    val draft: JsonObject,
    val expectedVersion: Long? = null,
    val isCreating: Boolean = false,
    @kotlinx.serialization.SerialName("field_identities")
    val fieldIdentities: Map<String, TabDataDraftFieldIdentity>? = null,
    @kotlinx.serialization.SerialName("schema_fingerprint")
    val schemaFingerprint: String? = null,
    val updatedAt: Long = System.currentTimeMillis(),
)

public object TabDataDraftSchema {
    public fun identities(fields: List<TabDataField>): Map<String, TabDataDraftFieldIdentity> =
        fields.associate { field ->
            field.name to TabDataDraftFieldIdentity(
                fieldId = field.id,
                fieldType = field.fieldType.normalizedFieldType(),
            )
        }

    public fun fingerprint(fields: List<TabDataField>): String {
        val material = buildString {
            fields.sortedWith(compareBy<TabDataField> { it.id }.thenBy { it.name }).forEach { field ->
                listOf(field.id, field.name, field.fieldType.normalizedFieldType()).forEach { component ->
                    append(component.length).append(':').append(component)
                }
                append('|')
            }
        }
        return MessageDigest.getInstance("SHA-256")
            .digest(material.toByteArray(Charsets.UTF_8))
            .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    private fun String.normalizedFieldType(): String = TabDataFieldType.normalize(this)
}

/** 记录编辑草稿按用户、组织、表和记录四层隔离，写入使用同步提交保证进程退出前落盘。 */
@Singleton
public class TabDataDraftStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val preferences = context.applicationContext.getSharedPreferences(
        TABDATA_DRAFT_PREFERENCES,
        Context.MODE_PRIVATE,
    )
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = true }
    private val lock = Any()

    public fun load(scope: TabDataDraftScope): TabDataDraftSnapshot? = synchronized(lock) {
        if (!scope.isValid()) return@synchronized null
        val key = keyFor(scope)
        val encoded = preferences.getString(key, null) ?: return@synchronized null
        runCatching { json.decodeFromString(TabDataDraftSnapshot.serializer(), encoded) }
            .getOrElse {
                preferences.edit().remove(key).commit()
                null
            }
            ?.takeIf { it.scope == scope && it.scope.isValid() }
    }

    public fun save(snapshot: TabDataDraftSnapshot): Boolean = synchronized(lock) {
        if (!snapshot.scope.isValid()) return@synchronized false
        val persisted = snapshot.copy(updatedAt = System.currentTimeMillis())
        preferences.edit()
            .putString(keyFor(snapshot.scope), json.encodeToString(TabDataDraftSnapshot.serializer(), persisted))
            .commit()
    }

    public fun remove(scope: TabDataDraftScope): Boolean = synchronized(lock) {
        if (!scope.isValid()) return@synchronized false
        preferences.edit().remove(keyFor(scope)).commit()
    }

    public fun clearTable(userId: String, organizationId: String, tableId: String): Boolean = synchronized(lock) {
        if (userId.isBlank() || organizationId.isBlank() || tableId.isBlank()) return@synchronized false
        val editor = preferences.edit()
        preferences.all.forEach { (key, value) ->
            val snapshot = (value as? String)?.let { encoded ->
                runCatching { json.decodeFromString(TabDataDraftSnapshot.serializer(), encoded) }.getOrNull()
            }
            if (snapshot?.scope?.let {
                    it.userId == userId && it.organizationId == organizationId && it.tableId == tableId
                } == true
            ) {
                editor.remove(key)
            }
        }
        editor.commit()
    }

    /** 当前用户在这张表内是否仍有任意持久草稿（包括已关闭详情和新建记录）。 */
    public fun hasTableDrafts(userId: String, organizationId: String, tableId: String): Boolean = synchronized(lock) {
        if (userId.isBlank() || organizationId.isBlank() || tableId.isBlank()) return@synchronized false
        preferences.all.values.any { value ->
            val snapshot = (value as? String)?.let { encoded ->
                runCatching { json.decodeFromString(TabDataDraftSnapshot.serializer(), encoded) }.getOrNull()
            }
            snapshot?.scope?.let {
                it.isValid() && it.userId == userId && it.organizationId == organizationId && it.tableId == tableId
            } == true
        }
    }

    /**
     * 初载离线时只读展示当前表的持久草稿。
     *
     * 调用方必须提供完整 user / organization / table scope；返回值不提供任何写回能力，
     * 也不会因为单条损坏数据而删除其他草稿。
     */
    public fun listTableDrafts(
        userId: String,
        organizationId: String,
        tableId: String,
    ): List<TabDataDraftSnapshot> = synchronized(lock) {
        if (userId.isBlank() || organizationId.isBlank() || tableId.isBlank()) {
            return@synchronized emptyList()
        }
        preferences.all.values.mapNotNull { value ->
            val encoded = value as? String ?: return@mapNotNull null
            runCatching { json.decodeFromString(TabDataDraftSnapshot.serializer(), encoded) }
                .getOrNull()
                ?.takeIf { snapshot ->
                    snapshot.scope.isValid() &&
                        snapshot.scope.userId == userId &&
                        snapshot.scope.organizationId == organizationId &&
                        snapshot.scope.tableId == tableId
                }
        }.sortedByDescending(TabDataDraftSnapshot::updatedAt)
    }

    public fun clearAll(): Boolean = synchronized(lock) { preferences.edit().clear().commit() }

    private fun keyFor(scope: TabDataDraftScope): String =
        "draft.${scope.storageMaterial().sha256Hex()}"

    private fun TabDataDraftScope.storageMaterial(): String = buildString {
        listOf(userId, organizationId, tableId, recordId).forEachIndexed { index, component ->
            if (index > 0) append('|')
            append(component.length).append(':').append(component)
        }
    }

    private fun String.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
        .digest(toByteArray(Charsets.UTF_8))
        .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

    public companion object {
        public const val NEW_RECORD_ID: String = "__new__"
    }
}

@Singleton
public class NativeCloudDraftCleaner @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    public fun clearAll() {
        context.applicationContext.deleteSharedPreferences(TABDOC_DRAFT_PREFERENCES)
        context.applicationContext.deleteSharedPreferences(TABDATA_DRAFT_PREFERENCES)
    }
}
