package com.tabtin.mobile.features.tabdata

import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldType
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataRecordGroup
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.longOrNull

/**
 * TabData 实时事件的解析与合并决策。
 *
 * 订阅 topic 为 `table.events.{tableId}`。同一 topic 上会到达：
 * - `table.events.delta`：记录增删改
 * - `table.events.field` / `table.events.view`：字段或视图结构变更
 *
 * 纯函数，不碰 UI / 网络。结构事件只做「是不是本表」判断，不读 payload 快照，
 * 也不拿 `latest_version` 跟记录 version 比——那是另一套万亿级 token。
 */
public object TabDataRealtimePolicy {
    public const val EVENT_DELTA: String = "table.events.delta"
    public const val EVENT_FIELD: String = "table.events.field"
    public const val EVENT_VIEW: String = "table.events.view"
    public const val TOPIC_PREFIX: String = "table.events."

    private val recordJson = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        isLenient = true
    }

    public fun topic(tableId: String): String = "$TOPIC_PREFIX$tableId"

    public fun parseDelta(envelope: WSEnvelope, expectedTableId: String): TabDataRealtimeDelta? {
        if (envelope.type != EVENT_DELTA) return null
        val tableId = envelope.payloadString("table_id")
            ?: envelope.tableId
            ?: return null
        if (tableId != expectedTableId) return null
        val metadata = envelope.payloadDict("metadata")
        val records = parseRecords(envelope.payload["records"])
        return TabDataRealtimeDelta(
            tableId = tableId,
            action = envelope.payloadString("action").orEmpty(),
            recordIds = stringList(envelope.payload["record_ids"]),
            records = records,
            latestVersion = longValue(envelope.payload["latest_version"]),
            rlsAffected = boolValue(envelope.payload["rls_affected"]) == true ||
                boolValue(metadata?.get("rls_affected")) == true,
            actorUserId = actorUserId(metadata),
            affectedCount = longValue(envelope.payload["affected_count"])
                ?: longValue(metadata?.get("count"))
                ?: longValue(metadata?.get("affected_count")),
        )
    }

    public fun parseStructureChange(
        envelope: WSEnvelope,
        expectedTableId: String,
    ): TabDataRealtimeStructureChange? {
        val kind = when (envelope.type) {
            EVENT_FIELD -> TabDataRealtimeStructureKind.Field
            EVENT_VIEW -> TabDataRealtimeStructureKind.View
            else -> return null
        }
        val tableId = envelope.payloadString("table_id")
            ?: envelope.tableId
            ?: return null
        if (tableId != expectedTableId) return null
        return TabDataRealtimeStructureChange(
            tableId = tableId,
            kind = kind,
            action = envelope.payloadString("action").orEmpty(),
        )
    }

    /**
     * 结构变更不按 user_id 忽略：同一账号在电脑上改字段/视图，手机仍要跟上。
     * 也不消费 payload 里的 fields/view 快照——那只是变更片段，完整 schema 走重拉。
     */
    public fun decideStructure(
        change: TabDataRealtimeStructureChange,
    ): TabDataRealtimeDecision =
        if (change.tableId.isBlank()) TabDataRealtimeDecision.Ignore
        else TabDataRealtimeDecision.ReloadSchema

    public fun decide(
        delta: TabDataRealtimeDelta,
        localUserId: String?,
        pendingRecordIds: Set<String>,
        editingRecordId: String?,
        isDetailDirty: Boolean,
    ): TabDataRealtimeDecision {
        if (shouldIgnoreAsSelfEcho(delta, localUserId, pendingRecordIds)) {
            return TabDataRealtimeDecision.Ignore
        }
        if (delta.rlsAffected) return TabDataRealtimeDecision.Refresh
        if (isIgnoredAction(delta.action)) return TabDataRealtimeDecision.Ignore
        if (isDeleteAction(delta.action)) {
            val deletedIds = delta.recordIds.filter { it.isNotBlank() }.toSet()
            if (editingRecordId != null && editingRecordId in deletedIds && isDetailDirty) {
                return TabDataRealtimeDecision.DeletedWhileEditing(editingRecordId)
            }
            if (deletedIds.isNotEmpty()) {
                return TabDataRealtimeDecision.Delete(deletedIds)
            }
            return TabDataRealtimeDecision.Refresh
        }
        if (delta.records.isNotEmpty() && delta.latestVersion != null) {
            return TabDataRealtimeDecision.Merge(
                records = delta.records,
                deletedIds = emptySet(),
                latestVersion = delta.latestVersion,
            )
        }
        return TabDataRealtimeDecision.Refresh
    }

    /**
     * 只在「当前用户 + 本地正在提交这些记录」时跳过回声。
     * 同一账号在桌面端改、手机上看，不应被 user_id 单独误伤。
     */
    public fun shouldIgnoreAsSelfEcho(
        delta: TabDataRealtimeDelta,
        localUserId: String?,
        pendingRecordIds: Set<String>,
    ): Boolean {
        val actor = delta.actorUserId?.takeIf(String::isNotBlank) ?: return false
        val local = localUserId?.takeIf(String::isNotBlank) ?: return false
        if (actor != local || pendingRecordIds.isEmpty()) return false
        val affected = delta.recordIds.filter { it.isNotBlank() }.toSet() +
            delta.records.map(TabDataRecord::id).filter { it.isNotBlank() }.toSet()
        return affected.isEmpty() || affected.any { it in pendingRecordIds }
    }

    public fun normalizeRecord(record: TabDataRecord, fields: List<TabDataField>): TabDataRecord {
        if (fields.isEmpty()) return record
        val byId = fields.associateBy(TabDataField::id)
        val byName = fields.associateBy(TabDataField::name)
        val named = linkedMapOf<String, JsonElement>()
        fun absorb(source: JsonObject) {
            source.forEach { (key, value) ->
                val field = byId[key] ?: byName[key]
                named[field?.name ?: key] = value
            }
        }
        absorb(record.data)
        absorb(record.fields)
        val normalized = JsonObject(named)
        return record.copy(fields = normalized, data = normalized)
    }

    /** 按 id 原地替换 / 删除，新记录插到列表头部，不重建无关项，避免滚动位置跳动。 */
    public fun mergeRecords(
        current: List<TabDataRecord>,
        incoming: List<TabDataRecord>,
        deletedIds: Set<String>,
    ): List<TabDataRecord> {
        val incomingById = incoming.associateBy(TabDataRecord::id)
        val seen = mutableSetOf<String>()
        val updated = current.mapNotNull { existing ->
            if (existing.id in deletedIds) return@mapNotNull null
            val replacement = incomingById[existing.id]
            if (replacement != null) {
                seen += existing.id
                replacement
            } else {
                existing
            }
        }
        val created = incoming.filter { it.id.isNotBlank() && it.id !in seen && it.id !in deletedIds }
        return created + updated
    }

    /**
     * 看板分组内按 id 合并。新记录无法判断该进哪一列时返回 null，调用方应走 refresh。
     */
    public fun mergeGroups(
        groups: List<TabDataRecordGroup>,
        incoming: List<TabDataRecord>,
        deletedIds: Set<String>,
    ): List<TabDataRecordGroup>? {
        val existingIds = groups.flatMap { group -> group.records.map(TabDataRecord::id) }.toSet()
        val unplaced = incoming.filter { it.id !in existingIds && it.id !in deletedIds }
        if (unplaced.isNotEmpty()) return null
        return groups.map { group ->
            val next = mergeRecords(group.records, incoming, deletedIds)
            val removed = group.records.count { it.id in deletedIds }
            group.copy(
                records = next,
                count = (group.count - removed).coerceAtLeast(next.size),
            )
        }
    }

    public fun adjustedTotal(
        currentTotal: Int,
        currentIds: Set<String>,
        incoming: List<TabDataRecord>,
        deletedIds: Set<String>,
    ): Int {
        val removed = deletedIds.count { it in currentIds }
        val added = incoming.count { it.id !in currentIds && it.id !in deletedIds }
        return (currentTotal - removed + added).coerceAtLeast(0)
    }

    /**
     * 打开详情时合并远端记录：草稿脏字段保留本地值，其余字段吃远端。
     * [detailOriginal] 更新为远端，这样下次保存的冲突检测基线是「别人刚写下的值」。
     */
    public fun mergeOpenDetail(
        remote: TabDataRecord,
        fields: List<TabDataField>,
        detailDraft: Map<String, JsonElement>,
        detailOriginal: Map<String, JsonElement>,
    ): TabDataRealtimeDetailMerge {
        val remoteValues = TabDataDraftPolicy.initialDraft(remote, fields)
        val dirtyNames = dirtyFieldNames(detailDraft, detailOriginal)
        val protectedDraft = remoteValues.toMutableMap()
        dirtyNames.forEach { name ->
            protectedDraft[name] = detailDraft[name] ?: JsonNull
        }
        return TabDataRealtimeDetailMerge(
            record = remote,
            original = remoteValues,
            draft = protectedDraft,
            protectedFieldNames = dirtyNames.toList(),
        )
    }

    public fun dirtyFieldNames(
        draft: Map<String, JsonElement>,
        original: Map<String, JsonElement>,
    ): Set<String> = (draft.keys + original.keys).filterTo(linkedSetOf()) { key ->
        draft[key] != original[key]
    }

    /**
     * schema 重拉后把未保存的脏值套回新字段列表。
     *
     * 优先按字段 id 对齐（改名后脏值跟着走）。字段被删、或类型变得对不上时，
     * 丢掉该键：列已经不在了 / 存不进去，留着只会让整份草稿永远 dirty。
     * 其余仍在的脏字段原样保留。
     */
    public fun rebaseOpenDetailAfterSchema(
        previousFields: List<TabDataField>,
        nextFields: List<TabDataField>,
        detailDraft: Map<String, JsonElement>,
        detailOriginal: Map<String, JsonElement>,
        record: TabDataRecord?,
    ): TabDataRealtimeSchemaRebase {
        val dirtyNames = dirtyFieldNames(detailDraft, detailOriginal)
        val previousByName = previousFields.associateBy(TabDataField::name)
        val previousById = previousFields.associateBy(TabDataField::id)
        val nextById = nextFields.associateBy(TabDataField::id)
        val nextValues = TabDataDraftPolicy.initialDraft(record, nextFields).toMutableMap()
        nextFields.forEach { field ->
            val current = nextValues[field.name]
            if (current != null && current != JsonNull) return@forEach
            val previousName = previousById[field.id]?.name
            val fallback = previousName?.let { name ->
                record?.namedFields?.get(name) ?: detailOriginal[name]
            } ?: record?.namedFields?.get(field.id)
            if (fallback != null && fallback != JsonNull) {
                nextValues[field.name] = fallback
            }
        }
        val protectedByNewName = linkedMapOf<String, JsonElement>()
        val droppedFieldNames = mutableListOf<String>()
        dirtyNames.forEach { oldName ->
            val previous = previousByName[oldName]
            val next = previous?.let { nextById[it.id] }
                ?: nextFields.firstOrNull { field -> field.name == oldName }
            when {
                next == null -> droppedFieldNames += oldName
                previous != null &&
                    TabDataFieldType.normalize(next.fieldType) !=
                    TabDataFieldType.normalize(previous.fieldType) ->
                    droppedFieldNames += oldName
                else -> protectedByNewName[next.name] = detailDraft[oldName] ?: JsonNull
            }
        }
        return TabDataRealtimeSchemaRebase(
            original = nextValues,
            draft = nextValues + protectedByNewName,
            protectedFieldNames = protectedByNewName.keys.toList(),
            droppedFieldNames = droppedFieldNames,
        )
    }

    private fun isDeleteAction(action: String): Boolean {
        val normalized = action.trim().lowercase()
        return normalized == "delete_record" ||
            normalized == "bulk_delete" ||
            normalized == "batch_delete" ||
            normalized == "batch_delete_records" ||
            normalized.endsWith("_delete")
    }

    private fun isIgnoredAction(action: String): Boolean = when (action.trim().lowercase()) {
        "computed_recalc_progress",
        "computed_recalc_completed",
        "collab.degraded",
        "collab.restored",
        -> true
        else -> false
    }

    private fun actorUserId(metadata: JsonObject?): String? {
        if (metadata == null) return null
        return sequenceOf("user_id", "userId", "actor_id", "actorId")
            .mapNotNull { key -> (metadata[key] as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) }
            .firstOrNull()
    }

    private fun parseRecords(raw: JsonElement?): List<TabDataRecord> {
        val array = raw as? JsonArray ?: return emptyList()
        return array.mapNotNull { element ->
            runCatching { recordJson.decodeFromJsonElement(TabDataRecord.serializer(), element) }.getOrNull()
                ?.takeIf { it.id.isNotBlank() }
        }
    }

    private fun stringList(raw: JsonElement?): List<String> {
        val array = raw as? JsonArray ?: return emptyList()
        return array.mapNotNull { element ->
            (element as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank)
        }
    }

    private fun longValue(raw: JsonElement?): Long? {
        val primitive = raw as? JsonPrimitive ?: return null
        return primitive.longOrNull ?: primitive.contentOrNull?.toLongOrNull()
    }

    private fun boolValue(raw: JsonElement?): Boolean? {
        val primitive = raw as? JsonPrimitive ?: return null
        return primitive.booleanOrNull
    }
}

public data class TabDataRealtimeDelta(
    public val tableId: String,
    public val action: String,
    public val recordIds: List<String>,
    public val records: List<TabDataRecord>,
    public val latestVersion: Long?,
    public val rlsAffected: Boolean,
    public val actorUserId: String?,
    public val affectedCount: Long?,
)

public data class TabDataRealtimeStructureChange(
    public val tableId: String,
    public val kind: TabDataRealtimeStructureKind,
    public val action: String,
)

public enum class TabDataRealtimeStructureKind {
    Field,
    View,
}

public sealed interface TabDataRealtimeDecision {
    public data object Ignore : TabDataRealtimeDecision
    public data object Refresh : TabDataRealtimeDecision
    public data object ReloadSchema : TabDataRealtimeDecision
    public data class Merge(
        public val records: List<TabDataRecord>,
        public val deletedIds: Set<String>,
        public val latestVersion: Long,
    ) : TabDataRealtimeDecision
    public data class Delete(public val recordIds: Set<String>) : TabDataRealtimeDecision
    public data class DeletedWhileEditing(public val recordId: String) : TabDataRealtimeDecision
}

public data class TabDataRealtimeDetailMerge(
    public val record: TabDataRecord,
    public val original: Map<String, JsonElement>,
    public val draft: Map<String, JsonElement>,
    public val protectedFieldNames: List<String>,
)

public data class TabDataRealtimeSchemaRebase(
    public val original: Map<String, JsonElement>,
    public val draft: Map<String, JsonElement>,
    public val protectedFieldNames: List<String>,
    public val droppedFieldNames: List<String>,
)
