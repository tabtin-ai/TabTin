import Foundation

/// TabData 实时事件：解析同一 topic `table.events.{tableId}` 上的
/// `table.events.delta`（记录）以及 `table.events.field` / `table.events.view`
/// （结构），决定刷新、重拉 schema 或按 id 合并。纯函数，不碰 UI / 网络。
///
/// 结构事件只判断「是不是本表」，不消费 payload 里的 fields/view 快照——
/// 那是变更片段，完整字段/视图走已有 `refresh()`。也不拿 `latest_version`
/// 跟记录 version 比（那是另一套万亿级 token）。
enum NativeTabDataRealtimePolicy {
    static let envelopeType = "table.events.delta"
    static let fieldEnvelopeType = "table.events.field"
    static let viewEnvelopeType = "table.events.view"

    static func topic(tableId: String) -> String {
        "table.events.\(tableId)"
    }

    struct Context: Equatable, Sendable {
        var tableId: String
        var currentUserId: String
        var isSaving: Bool
        var pendingRecordIds: Set<String>
        var draftsByRecordId: [String: NativeTabDataRecordDraft]
        var localRecords: [String: NativeTabDataRecord]
        var fields: [NativeTabDataField]
        var isKanban: Bool
        /// 当前打开着详情的记录。决定「别人删了它要不要告知」——用户正看着的东西
        /// 凭空消失必须有个交代，跟本地有没有草稿是两件事。
        var openRecordId: String?
    }

    struct ApplyPlan: Equatable, Sendable {
        var upserts: [NativeTabDataRecord]
        var deletions: [String]
        var protectedDeletions: [String]
        /// 要明确告知用户的被删记录。跟上面两个数组不互斥：
        /// 「移不移除列表」和「告不告知」是两个独立决定。
        var notifiedDeletions: [String] = []
    }

    enum Decision: Equatable, Sendable {
        case ignore
        case skipOwnChange
        case refresh
        case reloadSchema
        case apply(ApplyPlan)
    }

    enum StructureKind: Equatable, Sendable {
        case field
        case view
    }

    struct StructureChange: Equatable, Sendable {
        var tableId: String?
        var kind: StructureKind
        var action: String
        var fieldIds: [String]
        var viewId: String?
    }

    /// Schema 刷新后草稿怎么处理：本函数只分类，不改写草稿。
    /// 仍在且类型未变的脏字段继续提交；被删或改类型的脏字段记入 orphaned，
    /// 由 Session 按字段剔除并点名告知，不再把整份草稿打成冲突。
    struct SchemaDraftPlan: Equatable, Sendable {
        var retainedDirtyFieldIds: Set<String>
        var orphanedDirtyFieldIds: Set<String>
        var isCompatible: Bool
    }

    struct Delta: Equatable, Sendable {
        var tableId: String?
        var action: String
        var recordIds: [String]
        var records: [NativeTabDataRecord]
        var latestVersion: Int64?
        var rlsAffected: Bool
        var actorUserId: String?
    }

    static func parseDelta(_ envelope: WSEnvelope) -> Delta? {
        guard envelope.type == envelopeType else { return nil }
        let metadata = envelope.payloadDict("metadata") ?? [:]
        let actor = stringValue(metadata["user_id"])
            ?? stringValue(metadata["userId"])
            ?? envelope.payloadString("user_id")
        let rls = envelope.payloadBool("rls_affected")
            ?? boolValue(metadata["rls_affected"])
            ?? false
        let recordIds = stringArray(envelope.payload["record_ids"]?.value)
        return Delta(
            tableId: envelope.payloadString("table_id") ?? envelope.tableId,
            action: envelope.payloadString("action") ?? "",
            recordIds: recordIds,
            records: decodeRecords(envelope.payload["records"]),
            latestVersion: int64Value(envelope.payload["latest_version"]?.value),
            rlsAffected: rls,
            actorUserId: actor
        )
    }

    static func parseStructureChange(_ envelope: WSEnvelope) -> StructureChange? {
        let kind: StructureKind
        switch envelope.type {
        case fieldEnvelopeType: kind = .field
        case viewEnvelopeType: kind = .view
        default: return nil
        }
        return StructureChange(
            tableId: envelope.payloadString("table_id") ?? envelope.tableId,
            kind: kind,
            action: envelope.payloadString("action") ?? "",
            fieldIds: stringArray(envelope.payload["field_ids"]?.value),
            viewId: envelope.payloadString("view_id")
        )
    }

    static func decide(envelope: WSEnvelope, context: Context) -> Decision {
        if let change = parseStructureChange(envelope) {
            return decide(structure: change, context: context)
        }
        guard let delta = parseDelta(envelope) else { return .ignore }
        return decide(delta: delta, context: context)
    }

    /// 结构变更不按 `user_id` 忽略：同一账号在电脑上改字段/视图，手机仍要跟上。
    static func decide(structure: StructureChange, context: Context) -> Decision {
        if let tableId = structure.tableId, tableId != context.tableId {
            return .ignore
        }
        return .reloadSchema
    }

    /// 不改写草稿。被删或改类型的脏字段记入 orphaned；
    /// `isCompatible == false` 只表示「有字段要剔除」，不再表示整份冲突。
    static func planSchemaDraft(
        draft: NativeTabDataRecordDraft,
        fields: [NativeTabDataField]
    ) -> SchemaDraftPlan {
        let current = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0) })
        var retained: Set<String> = []
        var orphaned: Set<String> = []
        for fieldId in draft.dirtyFieldIds {
            if let field = current[fieldId], field.fieldType.rawValue == draft.fieldKinds[fieldId] {
                retained.insert(fieldId)
            } else {
                orphaned.insert(fieldId)
            }
        }
        return SchemaDraftPlan(
            retainedDirtyFieldIds: retained,
            orphanedDirtyFieldIds: orphaned,
            isCompatible: orphaned.isEmpty && draft.isCompatible(with: fields)
        )
    }

    static func decide(delta: Delta, context: Context) -> Decision {
        if let tableId = delta.tableId, tableId != context.tableId {
            return .ignore
        }
        if delta.rlsAffected {
            return .refresh
        }

        let affectedIds = affectedRecordIds(delta)
        if shouldSkipOwnChange(delta: delta, affectedIds: affectedIds, context: context) {
            return .skipOwnChange
        }

        if isDeleteAction(delta.action) {
            return decideDelete(affectedIds: affectedIds, context: context)
        }

        let canInlineMerge = !delta.records.isEmpty && delta.latestVersion != nil
        if canInlineMerge {
            if context.isKanban, isCreateAction(delta.action) {
                return .refresh
            }
            return .apply(ApplyPlan(
                upserts: delta.records.map { mergeRecord($0, context: context) },
                deletions: [],
                protectedDeletions: []
            ))
        }

        return .refresh
    }

    /// 用户有未保存的改动、且草稿持有该字段时，远端值不能覆盖。
    /// `covers` 挡住旧草稿没记过的字段；`dirtyFieldIds` 是值比较后的脏集
    /// （改回打开时的值会从里面拿掉，与 Android `draft != original` 对齐）。
    static func shouldPreserveLocalField(
        draft: NativeTabDataRecordDraft?,
        field: NativeTabDataField
    ) -> Bool {
        guard let draft else { return false }
        return draft.covers(field) && draft.dirtyFieldIds.contains(field.id)
    }

    static func isDeleteAction(_ action: String) -> Bool {
        action == "delete_record" || action == "batch_delete_records" || action == "bulk_delete"
    }

    static func isCreateAction(_ action: String) -> Bool {
        action == "create_record"
            || action == "batch_create_records"
            || action == "bulk_create"
    }

    static func mergeRecord(
        _ remote: NativeTabDataRecord,
        onto local: NativeTabDataRecord?,
        draft: NativeTabDataRecordDraft?,
        fields: [NativeTabDataField]
    ) -> NativeTabDataRecord {
        guard let local else { return remote }
        var merged = local.fields
        let fieldsByKey = fieldLookup(fields)
        for (key, value) in remote.fields {
            if let field = fieldsByKey[key], shouldPreserveLocalField(draft: draft, field: field) {
                continue
            }
            merged[key] = value
        }
        return NativeTabDataRecord(
            id: remote.id,
            tableId: remote.tableId ?? local.tableId,
            fields: merged,
            version: max(remote.version, local.version)
        )
    }

    private static func mergeRecord(_ remote: NativeTabDataRecord, context: Context) -> NativeTabDataRecord {
        mergeRecord(
            remote,
            onto: context.localRecords[remote.id],
            draft: context.draftsByRecordId[remote.id],
            fields: context.fields
        )
    }

    /// 有未提交草稿的记录不从列表移除，否则用户的编辑会连着承载它的行一起消失。
    /// 正打开着详情的记录照常移除（SwiftUI sheet 随之收起），但必须留一句告知，
    /// 不然用户只看到详情凭空关掉，会以为是自己误触。
    private static func decideDelete(affectedIds: [String], context: Context) -> Decision {
        guard !affectedIds.isEmpty else { return .refresh }
        var deletions: [String] = []
        var protectedDeletions: [String] = []
        var notifiedDeletions: [String] = []
        for id in affectedIds {
            if context.draftsByRecordId[id]?.canSubmit == true {
                protectedDeletions.append(id)
                notifiedDeletions.append(id)
            } else {
                deletions.append(id)
                if id == context.openRecordId {
                    notifiedDeletions.append(id)
                }
            }
        }
        return .apply(ApplyPlan(
            upserts: [],
            deletions: deletions,
            protectedDeletions: protectedDeletions,
            notifiedDeletions: notifiedDeletions
        ))
    }

    /// 只挡「自己正在提交的那几条」的回声。同一账号在别处（比如桌面端）改的记录
    /// 仍然要合并进来，否则手机端会静默漏掉自己的另一半改动。
    ///
    /// 刻意不比对 `latest_version`：它是 `VERSION_TOKEN_BASE + record.version` 编码
    /// 出来的万亿级 token，与记录自身的 version 不同量纲，拿来比大小只会得到恒假
    /// 或恒真的结论。判重交给 pendingRecordIds。
    private static func shouldSkipOwnChange(
        delta: Delta,
        affectedIds: [String],
        context: Context
    ) -> Bool {
        let actor = delta.actorUserId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !actor.isEmpty, actor == context.currentUserId else { return false }
        guard context.isSaving, !context.pendingRecordIds.isEmpty else { return false }
        return affectedIds.isEmpty || !Set(affectedIds).isDisjoint(with: context.pendingRecordIds)
    }

    private static func affectedRecordIds(_ delta: Delta) -> [String] {
        if !delta.recordIds.isEmpty { return delta.recordIds }
        return delta.records.map(\.id)
    }

    private static func fieldLookup(_ fields: [NativeTabDataField]) -> [String: NativeTabDataField] {
        var result: [String: NativeTabDataField] = [:]
        for field in fields {
            result[field.id] = field
            result[field.name] = field
        }
        return result
    }

    private static func decodeRecords(_ value: AnyCodable?) -> [NativeTabDataRecord] {
        guard let value else { return [] }
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        guard let data = try? encoder.encode(value),
              let records = try? decoder.decode([NativeTabDataRecord].self, from: data)
        else { return [] }
        return records
    }

    private static func stringArray(_ value: Any?) -> [String] {
        guard let items = value as? [Any] else { return [] }
        return items.compactMap { item in
            if let string = item as? String { return string }
            return nil
        }
    }

    private static func stringValue(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func boolValue(_ value: Any?) -> Bool? {
        if let flag = value as? Bool { return flag }
        if let number = value as? Int { return number != 0 }
        return nil
    }

    private static func int64Value(_ value: Any?) -> Int64? {
        if let number = value as? Int64 { return number }
        if let number = value as? Int { return Int64(number) }
        if let number = value as? Double, let exact = Int64(exactly: number) { return exact }
        if let string = value as? String { return Int64(string) }
        return nil
    }
}
