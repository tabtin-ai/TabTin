import XCTest
@testable import Tabtin

final class NativeTabDataRealtimePolicyTests: XCTestCase {
    func testTopicUsesTableId() {
        XCTAssertEqual(
            NativeTabDataRealtimePolicy.topic(tableId: "table-1"),
            "table.events.table-1"
        )
    }

    /// `AnyCodable` 直接构造时必须保住 Int64。它的 encode switch 一旦漏掉 Int64
    /// 分支就会落进 `default` 写成 null，数据静默丢失——记录 version 是 Int64，
    /// 实时合并会把远端 version 读成 0，然后 `max(remote, local)` 永远选本地值。
    func testAnyCodableKeepsInt64ThroughRoundTrip() throws {
        let data = try JSONEncoder().encode(AnyCodable(["version": Int64(2_000_000_000_005)]))
        let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
        let dict = try XCTUnwrap(decoded.value as? [String: Any])
        XCTAssertEqual(dict["version"] as? Int, 2_000_000_000_005)
    }

    func testInlineRecordsMergeByIdWithoutRebuildingUnrelatedRows() throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "本地标题", status: "todo", version: 3)
        let remote = record(id: "record-1", title: "远端标题", status: "done", version: 5)
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "update_record",
                records: [remote],
                latestVersion: 5,
                actorUserId: "other-user"
            ),
            context: context(local: [local], fields: fields)
        )

        guard case .apply(let plan) = decision else {
            return XCTFail("expected apply, got \(decision)")
        }
        XCTAssertEqual(plan.upserts.map(\.id), ["record-1"])
        XCTAssertEqual(plan.upserts.first?.fields["title"]?.stringValue, "远端标题")
        XCTAssertEqual(plan.upserts.first?.fields["status"]?.stringValue, "done")
        XCTAssertEqual(plan.upserts.first?.version, 5)
        XCTAssertTrue(plan.deletions.isEmpty)
    }

    func testDeltaWithoutRecordsFallsBackToRefresh() throws {
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "update_record",
                recordIds: ["record-1"],
                actorUserId: "other-user"
            ),
            context: context(local: [record(id: "record-1", title: "旧", status: "todo")], fields: try decodeFields())
        )
        XCTAssertEqual(decision, .refresh)
    }

    func testDraftCoveredDirtyFieldIsNotOverwrittenByRemoteValue() throws {
        let fields = try decodeFields()
        let title = try XCTUnwrap(fields.first { $0.id == "title" })
        let status = try XCTUnwrap(fields.first { $0.id == "status" })
        let local = record(id: "record-1", title: "旧标题", status: "todo", version: 3)
        var draft = NativeTabDataRecordDraft(
            record: local,
            tableId: "table-1",
            organizationId: "org-1",
            fields: fields
        )
        draft.set(.text("我正在输入"), for: title)

        XCTAssertTrue(draft.covers(title))
        XCTAssertTrue(draft.covers(status), "init 会给可编辑字段建空键")
        XCTAssertTrue(NativeTabDataRealtimePolicy.shouldPreserveLocalField(draft: draft, field: title))
        XCTAssertFalse(
            NativeTabDataRealtimePolicy.shouldPreserveLocalField(draft: draft, field: status),
            "没改过的字段即使 covers 也要让远端进来"
        )

        let merged = NativeTabDataRealtimePolicy.mergeRecord(
            record(id: "record-1", title: "远端标题", status: "done", version: 5),
            onto: local,
            draft: draft,
            fields: fields
        )
        XCTAssertEqual(merged.fields["title"]?.stringValue, "旧标题")
        XCTAssertEqual(merged.fields["status"]?.stringValue, "done")
        XCTAssertEqual(merged.version, 5)
    }

    func testRevertedDirtyFieldLetsRemoteValueThrough() throws {
        let fields = try decodeFields()
        let title = try XCTUnwrap(fields.first { $0.id == "title" })
        let status = try XCTUnwrap(fields.first { $0.id == "status" })
        let local = record(id: "record-1", title: "旧标题", status: "todo", version: 3)
        var draft = NativeTabDataRecordDraft(
            record: local,
            tableId: "table-1",
            organizationId: "org-1",
            fields: fields
        )
        draft.set(.text("我正在输入"), for: title)
        draft.set(.text("旧标题"), for: title)

        XCTAssertFalse(draft.canSubmit)
        XCTAssertFalse(NativeTabDataRealtimePolicy.shouldPreserveLocalField(draft: draft, field: title))
        XCTAssertFalse(NativeTabDataRealtimePolicy.shouldPreserveLocalField(draft: draft, field: status))

        let merged = NativeTabDataRealtimePolicy.mergeRecord(
            record(id: "record-1", title: "远端标题", status: "done", version: 5),
            onto: local,
            draft: draft,
            fields: fields
        )
        XCTAssertEqual(merged.fields["title"]?.stringValue, "远端标题")
        XCTAssertEqual(merged.fields["status"]?.stringValue, "done")
    }

    func testRlsAffectedTriggersFullRefresh() throws {
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "update_record",
                records: [record(id: "record-1", title: "不该用", status: "done")],
                latestVersion: 9,
                rlsAffected: true,
                actorUserId: "other-user"
            ),
            context: context(
                local: [record(id: "record-1", title: "旧", status: "todo")],
                fields: try decodeFields()
            )
        )
        XCTAssertEqual(decision, .refresh)
    }

    func testOwnInFlightSaveIsSkipped() throws {
        let local = record(id: "record-1", title: "刚保存", status: "done", version: 4)
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "update_record",
                records: [record(id: "record-1", title: "回声", status: "done", version: 4)],
                latestVersion: 4,
                actorUserId: "user-1"
            ),
            context: context(
                local: [local],
                fields: try decodeFields(),
                isSaving: true,
                pendingRecordIds: ["record-1"]
            )
        )
        XCTAssertEqual(decision, .skipOwnChange)
    }

    /// 同一账号在桌面端改了另一条记录，手机端此刻正好在保存自己那条：
    /// 只该挡自己在途的回声，别人（哪怕是自己的另一个端）的改动必须照常合并。
    func testSameUserEditFromAnotherClientStillMerges() throws {
        let mine = record(id: "record-1", title: "我在存", status: "todo", version: 4)
        let other = record(id: "record-2", title: "桌面端改的", status: "done", version: 7)
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "update_record",
                records: [other],
                latestVersion: 7,
                actorUserId: "user-1"
            ),
            context: context(
                local: [mine, record(id: "record-2", title: "旧值", status: "todo", version: 6)],
                fields: try decodeFields(),
                isSaving: true,
                pendingRecordIds: ["record-1"]
            )
        )
        guard case let .apply(plan) = decision else {
            return XCTFail("同账号异端改动被误判为回声：\(decision)")
        }
        XCTAssertEqual(plan.upserts.map(\.id), ["record-2"])
    }

    /// `latest_version` 是 `VERSION_TOKEN_BASE + record.version` 的万亿级 token，
    /// 与记录自身 version 不同量纲。谁要是拿它跟本地 version 比大小，这条会红。
    func testMonotonicVersionTokenIsNotComparedAgainstRecordVersion() throws {
        let local = record(id: "record-1", title: "旧标题", status: "todo", version: 4)
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "update_record",
                records: [record(id: "record-1", title: "他人改的", status: "done", version: 5)],
                latestVersion: 2_000_000_000_005,
                actorUserId: "user-1"
            ),
            context: context(local: [local], fields: try decodeFields())
        )
        guard case let .apply(plan) = decision else {
            return XCTFail("远端改动被 version token 比较吞掉：\(decision)")
        }
        XCTAssertEqual(plan.upserts.first?.id, "record-1")
    }

    func testDeleteKeepsRecordWhenLocalDraftIsDirty() throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        var draft = NativeTabDataRecordDraft(
            record: local,
            tableId: "table-1",
            organizationId: "org-1",
            fields: fields
        )
        draft.set(.text("还没保存"), for: try XCTUnwrap(fields.first { $0.id == "title" }))

        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "delete_record",
                recordIds: ["record-1"],
                actorUserId: "other-user"
            ),
            context: context(local: [local], fields: fields, drafts: [draft])
        )
        guard case .apply(let plan) = decision else {
            return XCTFail("expected apply, got \(decision)")
        }
        XCTAssertEqual(plan.protectedDeletions, ["record-1"])
        XCTAssertTrue(plan.deletions.isEmpty)
        XCTAssertEqual(plan.notifiedDeletions, ["record-1"])
    }

    /// 只是看、没编辑，别人删掉它：照常从列表移除（详情 sheet 随之收起），
    /// 但要告知——否则用户只看到详情凭空关掉。#11161
    func testDeletingRecordUserIsViewingNotifiesEvenWithoutDraft() throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "我正看着这条", status: "todo")

        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "delete_record",
                recordIds: ["record-1"],
                actorUserId: "other-user"
            ),
            context: context(local: [local], fields: fields, openRecordId: "record-1")
        )
        guard case .apply(let plan) = decision else {
            return XCTFail("expected apply, got \(decision)")
        }
        XCTAssertEqual(plan.deletions, ["record-1"])
        XCTAssertTrue(plan.protectedDeletions.isEmpty)
        XCTAssertEqual(plan.notifiedDeletions, ["record-1"])
    }

    /// 没打开、也没草稿的记录被删就该静默消失，不要为了列表里少一行去打扰用户。
    func testDeletingUnopenedRecordStaysSilent() throws {
        let fields = try decodeFields()
        let viewing = record(id: "record-1", title: "我正看着这条", status: "todo")
        let other = record(id: "record-2", title: "旁边那条", status: "todo")

        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: deltaEnvelope(
                action: "delete_record",
                recordIds: ["record-2"],
                actorUserId: "other-user"
            ),
            context: context(local: [viewing, other], fields: fields, openRecordId: "record-1")
        )
        guard case .apply(let plan) = decision else {
            return XCTFail("expected apply, got \(decision)")
        }
        XCTAssertEqual(plan.deletions, ["record-2"])
        XCTAssertTrue(plan.notifiedDeletions.isEmpty)
    }

    @MainActor
    func testSessionMergesInlineRecordsById() async throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "旧标题", status: "todo", version: 2)
        let other = record(id: "record-2", title: "旁边那条", status: "todo", version: 1)
        var refreshCount = 0
        let session = makeSession(fields: fields, records: [local, other]) {
            refreshCount += 1
        }
        await session.load()
        XCTAssertEqual(refreshCount, 1)
        XCTAssertEqual(session.records.map(\.id), ["record-1", "record-2"])

        session.handleRealtimeEnvelope(
            deltaEnvelope(
                action: "update_record",
                records: [record(id: "record-1", title: "别人改了", status: "done", version: 6)],
                latestVersion: 6,
                actorUserId: "other-user"
            )
        )

        XCTAssertEqual(session.records.map(\.id), ["record-1", "record-2"], "按 id 合并，不要整表重建")
        XCTAssertEqual(session.record(id: "record-1")?.fields["title"]?.stringValue, "别人改了")
        XCTAssertEqual(session.record(id: "record-2")?.fields["title"]?.stringValue, "旁边那条")
        XCTAssertEqual(refreshCount, 1)
    }

    @MainActor
    func testSessionRefreshFallbackWhenDeltaHasNoRecords() async throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        var refreshCount = 0
        let session = makeSession(fields: fields, records: [local]) {
            refreshCount += 1
        }
        await session.load()
        session.handleRealtimeEnvelope(
            deltaEnvelope(
                action: "update_record",
                recordIds: ["record-1"],
                actorUserId: "other-user"
            )
        )
        await waitUntil { refreshCount >= 2 }
        XCTAssertGreaterThanOrEqual(refreshCount, 2)
    }

    @MainActor
    func testSessionKeepsDirtyDraftFieldWhenRemoteDeltaArrives() async throws {
        let fields = try decodeFields()
        let title = try XCTUnwrap(fields.first { $0.id == "title" })
        let status = try XCTUnwrap(fields.first { $0.id == "status" })
        let local = record(id: "record-1", title: "旧标题", status: "todo", version: 2)
        let session = makeSession(fields: fields, records: [local])
        await session.load()
        session.updateDraft(record: local, field: title, value: .text("我正在输入"))

        session.handleRealtimeEnvelope(
            deltaEnvelope(
                action: "update_record",
                records: [record(id: "record-1", title: "远端标题", status: "done", version: 8)],
                latestVersion: 8,
                actorUserId: "other-user"
            )
        )

        XCTAssertEqual(session.value(record: local, field: title), .text("我正在输入"))
        XCTAssertEqual(session.value(record: local, field: status), .selections(["done"]))
        XCTAssertEqual(session.record(id: "record-1")?.fields["title"]?.stringValue, "旧标题")
        XCTAssertEqual(session.record(id: "record-1")?.fields["status"]?.stringValue, "done")
    }

    @MainActor
    func testSessionAppliesRemoteAfterDraftRevertsToBaseline() async throws {
        let fields = try decodeFields()
        let title = try XCTUnwrap(fields.first { $0.id == "title" })
        let local = record(id: "record-1", title: "旧标题", status: "todo", version: 2)
        let session = makeSession(fields: fields, records: [local])
        await session.load()
        session.updateDraft(record: local, field: title, value: .text("我正在输入"))
        XCTAssertEqual(session.saveState, .dirty)
        session.updateDraft(record: local, field: title, value: .text("旧标题"))
        XCTAssertFalse(session.draft(for: local).canSubmit)
        XCTAssertFalse(session.hasDirtyDrafts)
        XCTAssertEqual(session.saveState, .saved)

        session.handleRealtimeEnvelope(
            deltaEnvelope(
                action: "update_record",
                records: [record(id: "record-1", title: "远端标题", status: "todo", version: 8)],
                latestVersion: 8,
                actorUserId: "other-user"
            )
        )

        XCTAssertEqual(session.value(record: local, field: title), .text("远端标题"))
        XCTAssertEqual(session.record(id: "record-1")?.fields["title"]?.stringValue, "远端标题")
    }

    @MainActor
    func testSessionRefreshWhenRlsAffected() async throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        var refreshCount = 0
        let session = makeSession(fields: fields, records: [local]) {
            refreshCount += 1
        }
        await session.load()
        session.handleRealtimeEnvelope(
            deltaEnvelope(
                action: "update_record",
                rlsAffected: true,
                actorUserId: "other-user"
            )
        )
        await waitUntil { refreshCount >= 2 }
        XCTAssertGreaterThanOrEqual(refreshCount, 2)
    }

    @MainActor
    func testSessionNotifiesWhenOpenDraftRecordIsDeleted() async throws {
        let fields = try decodeFields()
        let title = try XCTUnwrap(fields.first { $0.id == "title" })
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        let session = makeSession(fields: fields, records: [local])
        await session.load()
        session.updateDraft(record: local, field: title, value: .text("还没保存"))

        session.handleRealtimeEnvelope(
            deltaEnvelope(
                action: "delete_record",
                recordIds: ["record-1"],
                actorUserId: "other-user"
            )
        )

        XCTAssertEqual(session.record(id: "record-1")?.id, "record-1")
        XCTAssertEqual(session.saveNotice, L10n.TabData.remoteRecordDeleted)
        XCTAssertEqual(session.value(record: local, field: title), .text("还没保存"))
    }

    /// 打开详情但没动手改，别人把这条删了：记录该从列表消失（sheet 随之收起），
    /// 同时留下告知。以前只有「有草稿」才提示，纯查看的用户看到详情凭空关掉。#11161
    @MainActor
    func testSessionNotifiesWhenViewedRecordIsDeletedWithoutDraft() async throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        let session = makeSession(fields: fields, records: [local])
        await session.load()
        session.setOpenRecordId("record-1")

        session.handleRealtimeEnvelope(
            deltaEnvelope(
                action: "delete_record",
                recordIds: ["record-1"],
                actorUserId: "other-user"
            )
        )

        XCTAssertNil(session.record(id: "record-1"))
        XCTAssertEqual(session.saveNotice, L10n.TabData.remoteRecordDeleted)
    }

    /// 列表里别人删掉一条我没看的记录：安静移除，不弹提示。
    @MainActor
    func testSessionStaysSilentWhenUnviewedRecordIsDeleted() async throws {
        let fields = try decodeFields()
        let viewing = record(id: "record-1", title: "我正看着这条", status: "todo")
        let other = record(id: "record-2", title: "旁边那条", status: "todo")
        let session = makeSession(fields: fields, records: [viewing, other])
        await session.load()
        session.setOpenRecordId("record-1")

        session.handleRealtimeEnvelope(
            deltaEnvelope(
                action: "delete_record",
                recordIds: ["record-2"],
                actorUserId: "other-user"
            )
        )

        XCTAssertEqual(session.records.map(\.id), ["record-1"])
        XCTAssertNil(session.saveNotice)
    }

    func testFieldEnvelopeReloadsSchema() throws {
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: fieldEnvelope(action: "create_field", fieldIds: ["priority"]),
            context: context(local: [], fields: try decodeFields())
        )
        XCTAssertEqual(decision, .reloadSchema)
    }

    func testViewEnvelopeReloadsSchema() throws {
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: viewEnvelope(action: "update_view", viewId: "view-1"),
            context: context(local: [], fields: try decodeFields())
        )
        XCTAssertEqual(decision, .reloadSchema)
    }

    func testStructureEventForOtherTableIsIgnored() throws {
        let fields = try decodeFields()
        XCTAssertEqual(
            NativeTabDataRealtimePolicy.decide(
                envelope: fieldEnvelope(
                    action: "create_field",
                    fieldIds: ["priority"],
                    tableId: "table-other"
                ),
                context: context(local: [], fields: fields)
            ),
            .ignore
        )
        XCTAssertEqual(
            NativeTabDataRealtimePolicy.decide(
                envelope: viewEnvelope(
                    action: "delete_view",
                    viewId: "view-1",
                    tableId: "table-other"
                ),
                context: context(local: [], fields: fields)
            ),
            .ignore
        )
    }

    /// 同一账号在桌面端改字段，手机端即使正在保存记录也不能按 user_id 丢掉这次结构变更。
    func testSameUserFieldChangeFromAnotherClientStillReloadsSchema() throws {
        let decision = NativeTabDataRealtimePolicy.decide(
            envelope: fieldEnvelope(
                action: "update_field",
                fieldIds: ["title"],
                actorUserId: "user-1"
            ),
            context: context(
                local: [record(id: "record-1", title: "我在存", status: "todo")],
                fields: try decodeFields(),
                isSaving: true,
                pendingRecordIds: ["record-1"]
            )
        )
        XCTAssertEqual(decision, .reloadSchema)
    }

    func testSchemaDraftPlanKeepsDirtyFieldsAndOrphansDeletedOnes() throws {
        let fields = try decodeFields()
        let title = try XCTUnwrap(fields.first { $0.id == "title" })
        let status = try XCTUnwrap(fields.first { $0.id == "status" })
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        var draft = NativeTabDataRecordDraft(
            record: local,
            tableId: "table-1",
            organizationId: "org-1",
            fields: fields
        )
        draft.set(.text("我正在输入"), for: title)
        draft.set(.selections(["doing"]), for: status)

        let afterAddColumn = NativeTabDataRealtimePolicy.planSchemaDraft(
            draft: draft,
            fields: fields + [try decodeField(id: "priority", name: "优先级", type: "text")]
        )
        XCTAssertEqual(afterAddColumn.retainedDirtyFieldIds, ["title", "status"])
        XCTAssertTrue(afterAddColumn.orphanedDirtyFieldIds.isEmpty)
        XCTAssertTrue(afterAddColumn.isCompatible)

        let afterDeleteTitle = NativeTabDataRealtimePolicy.planSchemaDraft(
            draft: draft,
            fields: [status]
        )
        XCTAssertEqual(afterDeleteTitle.retainedDirtyFieldIds, ["status"])
        XCTAssertEqual(afterDeleteTitle.orphanedDirtyFieldIds, ["title"])
        // isCompatible == false 只表示「有字段要剔除」，plan 本身不改草稿。
        XCTAssertFalse(afterDeleteTitle.isCompatible)
        XCTAssertEqual(draft.value(for: title), .text("我正在输入"))
        XCTAssertTrue(draft.dirtyFieldIds.contains("title"))

        let rebased = NativeTabDataDroppedFieldPolicy.rebase(
            draft: draft,
            previousFields: fields,
            nextFields: [status]
        )
        XCTAssertEqual(rebased.droppedFieldIds, ["title"])
        XCTAssertEqual(rebased.droppedFieldNames, ["标题"])
        XCTAssertFalse(rebased.draft.dirtyFieldIds.contains("title"))
        XCTAssertTrue(rebased.draft.dirtyFieldIds.contains("status"))
        XCTAssertEqual(rebased.draft.value(for: status), .selections(["doing"]))
        XCTAssertTrue(rebased.draft.canSubmit)
        XCTAssertTrue(rebased.draft.isCompatible(with: [status]))
        XCTAssertEqual(
            NativeTabDataDroppedFieldPolicy.message(fieldNames: rebased.droppedFieldNames),
            L10n.TabData.droppedField("标题")
        )
    }

    func testDroppedFieldNoticeNamesSingleAndMultipleFields() {
        XCTAssertEqual(
            NativeTabDataDroppedFieldPolicy.message(fieldNames: ["标题"]),
            L10n.TabData.droppedField("标题")
        )
        XCTAssertEqual(
            NativeTabDataDroppedFieldPolicy.message(fieldNames: ["标题", "状态"]),
            L10n.TabData.droppedFields("标题", 2)
        )
        XCTAssertEqual(
            NativeTabDataDroppedFieldPolicy.schemaRefreshNotice(
                droppedFieldNames: [],
                announceSchemaUpdate: true
            ),
            L10n.TabData.remoteSchemaUpdated
        )
        XCTAssertNil(
            NativeTabDataDroppedFieldPolicy.schemaRefreshNotice(
                droppedFieldNames: [],
                announceSchemaUpdate: false
            )
        )
        XCTAssertEqual(
            NativeTabDataDroppedFieldPolicy.schemaRefreshNotice(
                droppedFieldNames: ["标题"],
                announceSchemaUpdate: true
            ),
            L10n.TabData.droppedField("标题")
        )
    }

    func testDroppedFieldNameFallsBackToDraftThenId() throws {
        let title = try decodeField(id: "title", name: "标题", type: "text")
        XCTAssertEqual(
            NativeTabDataDroppedFieldPolicy.displayName(
                fieldId: "title",
                previousFields: [title],
                nextFields: [],
                draftNames: ["title": "草稿里的旧名"]
            ),
            "标题"
        )
        XCTAssertEqual(
            NativeTabDataDroppedFieldPolicy.displayName(
                fieldId: "title",
                previousFields: [],
                nextFields: [],
                draftNames: ["title": "草稿里的旧名"]
            ),
            "草稿里的旧名"
        )
        XCTAssertEqual(
            NativeTabDataDroppedFieldPolicy.displayName(
                fieldId: "title",
                previousFields: [],
                nextFields: [],
                draftNames: [:]
            ),
            "title"
        )
    }

    @MainActor
    func testSessionReloadsSchemaOnFieldEventAndKeepsDirtyDraft() async throws {
        let initialFields = try decodeFields()
        let title = try XCTUnwrap(initialFields.first { $0.id == "title" })
        let status = try XCTUnwrap(initialFields.first { $0.id == "status" })
        let local = record(id: "record-1", title: "旧标题", status: "todo", version: 2)
        var latestFields = initialFields
        var refreshCount = 0
        let session = makeSession(
            fieldsProvider: { latestFields },
            records: [local]
        ) {
            refreshCount += 1
        }
        await session.load()
        session.updateDraft(record: local, field: title, value: .text("我正在输入"))

        latestFields = initialFields + [try decodeField(id: "priority", name: "优先级", type: "text")]
        session.handleRealtimeEnvelope(fieldEnvelope(action: "create_field", fieldIds: ["priority"]))
        await waitUntil { session.fields.contains { $0.id == "priority" } }

        XCTAssertEqual(session.fields.map(\.id), ["title", "status", "priority"])
        XCTAssertEqual(session.value(record: local, field: title), .text("我正在输入"))
        XCTAssertEqual(session.value(record: local, field: status), .selections(["todo"]))
        XCTAssertEqual(session.saveNotice, L10n.TabData.remoteSchemaUpdated)
        XCTAssertEqual(session.saveState, .dirty)
        XCTAssertGreaterThanOrEqual(refreshCount, 2)
    }

    @MainActor
    func testSessionReloadsSchemaOnViewEvent() async throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        let firstView = try decodeView(id: "view-1", name: "主视图")
        let secondView = try decodeView(id: "view-2", name: "看板", type: "kanban")
        var latestViews = [firstView]
        var refreshCount = 0
        let session = makeSession(
            fieldsProvider: { fields },
            viewsProvider: { latestViews },
            records: [local]
        ) {
            refreshCount += 1
        }
        await session.load()
        XCTAssertEqual(session.views.map(\.id), ["view-1"])

        latestViews = [firstView, secondView]
        session.handleRealtimeEnvelope(viewEnvelope(action: "create_view", viewId: "view-2"))
        await waitUntil { session.views.contains { $0.id == "view-2" } }

        XCTAssertEqual(session.views.map(\.id), ["view-1", "view-2"])
        XCTAssertEqual(session.saveNotice, L10n.TabData.remoteSchemaUpdated)
        XCTAssertGreaterThanOrEqual(refreshCount, 2)
    }

    @MainActor
    func testSessionDropsDeletedDirtyFieldAndKeepsRemainingSubmit() async throws {
        let initialFields = try decodeFields()
        let title = try XCTUnwrap(initialFields.first { $0.id == "title" })
        let status = try XCTUnwrap(initialFields.first { $0.id == "status" })
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        var latestFields = initialFields
        let session = makeSession(
            fieldsProvider: { latestFields },
            records: [local]
        )
        await session.load()
        session.updateDraft(record: local, field: title, value: .text("还没保存"))
        session.updateDraft(record: local, field: status, value: .selections(["doing"]))

        latestFields = [status]
        session.handleRealtimeEnvelope(fieldEnvelope(action: "delete_field", fieldIds: ["title"]))
        await waitUntil {
            !session.fields.contains { $0.id == "title" }
                && session.saveNotice == L10n.TabData.droppedField("标题")
        }

        let draft = session.draft(for: local)
        XCTAssertFalse(draft.dirtyFieldIds.contains("title"))
        XCTAssertEqual(draft.value(for: status), .selections(["doing"]))
        XCTAssertTrue(draft.canSubmit)
        XCTAssertEqual(session.saveState, .dirty)
        XCTAssertNil(session.saveError)
        XCTAssertEqual(session.saveNotice, L10n.TabData.droppedField("标题"))
        let snapshot = try XCTUnwrap(session.localDraftSnapshot(for: local))
        XCTAssertNil(snapshot.fields.first { $0.id == "title" })
        XCTAssertEqual(snapshot.fields.first { $0.id == "status" }?.value, "doing")
    }

    @MainActor
    func testSessionNamesMultipleDroppedFields() async throws {
        let initialFields = try decodeFields()
        let title = try XCTUnwrap(initialFields.first { $0.id == "title" })
        let status = try XCTUnwrap(initialFields.first { $0.id == "status" })
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        var latestFields = initialFields
        let session = makeSession(
            fieldsProvider: { latestFields },
            records: [local]
        )
        await session.load()
        session.updateDraft(record: local, field: title, value: .text("还没保存"))
        session.updateDraft(record: local, field: status, value: .selections(["doing"]))

        latestFields = []
        session.handleRealtimeEnvelope(fieldEnvelope(action: "delete_field", fieldIds: ["title", "status"]))
        await waitUntil {
            session.fields.isEmpty
                && session.saveNotice == L10n.TabData.droppedFields("标题", 2)
        }

        let draft = session.draft(for: local)
        XCTAssertTrue(draft.dirtyFieldIds.isEmpty)
        XCTAssertFalse(draft.canSubmit)
        XCTAssertNotEqual(session.saveState, .conflict)
        XCTAssertEqual(session.saveNotice, L10n.TabData.droppedFields("标题", 2))
    }

    @MainActor
    func testSessionDroppedFieldNoticeDoesNotFlashGenericSchemaUpdated() async throws {
        let initialFields = try decodeFields()
        let title = try XCTUnwrap(initialFields.first { $0.id == "title" })
        let status = try XCTUnwrap(initialFields.first { $0.id == "status" })
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        var latestFields = initialFields
        let session = makeSession(
            fieldsProvider: { latestFields },
            records: [local]
        )
        await session.load()
        session.updateDraft(record: local, field: title, value: .text("还没保存"))
        session.updateDraft(record: local, field: status, value: .selections(["doing"]))

        latestFields = [status]
        session.handleRealtimeEnvelope(fieldEnvelope(action: "delete_field", fieldIds: ["title"]))
        XCTAssertNil(session.saveNotice, "结构事件到达时还不能出提示，否则会先闪通用文案")

        let generic = L10n.TabData.remoteSchemaUpdated
        let named = L10n.TabData.droppedField("标题")
        var sawGeneric = false
        await waitUntil {
            if session.saveNotice == generic { sawGeneric = true }
            return session.saveNotice == named
        }

        XCTAssertFalse(sawGeneric)
        XCTAssertEqual(session.saveNotice, named)
    }

    @MainActor
    func testSessionOrdinaryRefreshDoesNotAnnounceSchemaUpdated() async throws {
        let fields = try decodeFields()
        let local = record(id: "record-1", title: "旧标题", status: "todo")
        let session = makeSession(fields: fields, records: [local])

        await session.load()
        XCTAssertNil(session.saveNotice)

        await session.refresh()
        XCTAssertNil(session.saveNotice)
        XCTAssertNotEqual(session.saveNotice, L10n.TabData.remoteSchemaUpdated)
    }

    @MainActor
    private func makeSession(
        fields: [NativeTabDataField],
        records: [NativeTabDataRecord],
        onFetch: (() -> Void)? = nil
    ) -> NativeTabDataSession {
        makeSession(fieldsProvider: { fields }, records: records, onFetch: onFetch)
    }

    @MainActor
    private func makeSession(
        fieldsProvider: @escaping () -> [NativeTabDataField],
        viewsProvider: @escaping () -> [NativeTabDataView] = { [] },
        records: [NativeTabDataRecord],
        onFetch: (() -> Void)? = nil
    ) -> NativeTabDataSession {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        return NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: NativeTabDataDraftStore(store: defaults),
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                (
                    NativeTabDataTable(
                        id: "table-1",
                        name: "任务",
                        organizationId: "org-1",
                        defaultViewId: nil,
                        currentUserRole: "editor"
                    ),
                    NativeTabDataFieldList(fields: fieldsProvider()),
                    NativeTabDataViewList(views: viewsProvider())
                )
            },
            recordsRequest: { _, _, _ in
                onFetch?()
                return NativeTabDataRecordList(
                    records: records,
                    total: records.count,
                    matchedTotal: records.count,
                    page: 1,
                    pageSize: 30,
                    metadata: nil
                )
            }
        )
    }

    @MainActor
    private func waitUntil(
        timeout: TimeInterval = 1,
        _ condition: @escaping () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            await Task.yield()
        }
        XCTAssertTrue(condition(), "timed out waiting for realtime refresh")
    }

    private func context(
        local: [NativeTabDataRecord],
        fields: [NativeTabDataField],
        drafts: [NativeTabDataRecordDraft] = [],
        isSaving: Bool = false,
        pendingRecordIds: Set<String> = [],
        openRecordId: String? = nil
    ) -> NativeTabDataRealtimePolicy.Context {
        NativeTabDataRealtimePolicy.Context(
            tableId: "table-1",
            currentUserId: "user-1",
            isSaving: isSaving,
            pendingRecordIds: pendingRecordIds,
            draftsByRecordId: Dictionary(uniqueKeysWithValues: drafts.map { ($0.recordId, $0) }),
            localRecords: Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) }),
            fields: fields,
            isKanban: false,
            openRecordId: openRecordId
        )
    }

    private func fieldEnvelope(
        action: String,
        fieldIds: [String],
        tableId: String = "table-1",
        actorUserId: String? = "other-user"
    ) -> WSEnvelope {
        WSEnvelope.build(
            type: NativeTabDataRealtimePolicy.fieldEnvelopeType,
            deviceId: "ios-test",
            payload: [
                "table_id": tableId,
                "action": action,
                "field_ids": fieldIds,
                "metadata": ["user_id": actorUserId as Any],
            ]
        )
    }

    private func viewEnvelope(
        action: String,
        viewId: String,
        tableId: String = "table-1",
        actorUserId: String? = "other-user"
    ) -> WSEnvelope {
        WSEnvelope.build(
            type: NativeTabDataRealtimePolicy.viewEnvelopeType,
            deviceId: "ios-test",
            payload: [
                "table_id": tableId,
                "action": action,
                "view_id": viewId,
                "metadata": ["user_id": actorUserId as Any],
            ]
        )
    }

    private func decodeField(id: String, name: String, type: String) throws -> NativeTabDataField {
        let data = try JSONSerialization.data(withJSONObject: fieldJSON(id: id, name: name, type: type))
        return try JSONDecoder().decode(NativeTabDataField.self, from: data)
    }

    private func decodeView(id: String, name: String, type: String = "grid") throws -> NativeTabDataView {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": id,
            "name": name,
            "view_type": type,
            "order": 0,
            "filters": [],
            "sorts": [],
            "groups": [],
            "config": [:],
            "visible_fields": [],
            "field_order": [],
            "column_meta": [:],
            "is_locked": false,
        ] as [String: Any])
        return try JSONDecoder().decode(NativeTabDataView.self, from: data)
    }

    private func deltaEnvelope(
        action: String,
        recordIds: [String] = [],
        records: [NativeTabDataRecord] = [],
        latestVersion: Int64? = nil,
        rlsAffected: Bool = false,
        actorUserId: String? = nil
    ) -> WSEnvelope {
        var payload: [String: Any] = [
            "table_id": "table-1",
            "action": action,
            "record_ids": recordIds.isEmpty ? records.map(\.id) : recordIds,
            "metadata": ["user_id": actorUserId as Any],
        ]
        if !records.isEmpty {
            payload["records"] = records.map { item in
                [
                    "id": item.id,
                    "table_id": item.tableId as Any,
                    "fields": item.fields.mapValues(\.value),
                    "version": item.version,
                ]
            }
        }
        if let latestVersion {
            payload["latest_version"] = latestVersion
        }
        if rlsAffected {
            payload["rls_affected"] = true
        }
        return WSEnvelope.build(type: "table.events.delta", deviceId: "ios-test", payload: payload)
    }

    private func record(
        id: String,
        title: String,
        status: String,
        version: Int64 = 1
    ) -> NativeTabDataRecord {
        NativeTabDataRecord(
            id: id,
            tableId: "table-1",
            fields: [
                "title": AnyCodable(title),
                "status": AnyCodable(status),
            ],
            version: version
        )
    }

    private func decodeFields() throws -> [NativeTabDataField] {
        try [
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
            fieldJSON(id: "status", name: "状态", type: "select"),
        ].map { object in
            let data = try JSONSerialization.data(withJSONObject: object)
            return try JSONDecoder().decode(NativeTabDataField.self, from: data)
        }
    }

    private func fieldJSON(
        id: String,
        name: String,
        type: String,
        primary: Bool = false
    ) -> [String: Any] {
        [
            "id": id,
            "name": name,
            "field_type": type,
            "is_primary": primary,
            "is_hidden": false,
            "order": 0,
        ]
    }
}
