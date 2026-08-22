import XCTest
@testable import Tabtin

final class NativeTabDataTests: XCTestCase {
    @MainActor
    func testInitialOfflineFailureKeepsCreationDraftReachableThroughReadOnlyEntry() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let localRecord = NativeTabDataRecord(
            id: "draft-local",
            tableId: "table-1",
            fields: [:],
            version: 0
        )
        var draft = NativeTabDataRecordDraft(
            record: localRecord,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.text("离线新记录"), for: field)
        try store.save(draft, userId: "user-1")
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                throw APIError.networkError(URLError(.notConnectedToInternet))
            }
        )

        await session.load()

        XCTAssertNil(session.table)
        XCTAssertNotNil(session.loadError)
        XCTAssertFalse(session.canEdit)
        XCTAssertTrue(session.hasResumableCreationDraft)
        XCTAssertEqual(session.creationEntry, .viewLocalDraft)
        XCTAssertEqual(session.resumableCreationRecord()?.id, "draft-local")
        XCTAssertEqual(session.localDraftSnapshots.first?.fields.first?.value, "离线新记录")
        XCTAssertEqual(session.localDraftSnapshots.first?.copyText, "title: 离线新记录")
        let created = await session.create(record: localRecord)
        XCTAssertNil(created)
        XCTAssertNotNil(store.load(
            recordId: "draft-local",
            tableId: "table-1",
            userId: "user-1",
            organizationId: "org-1"
        ))
    }

    func testCreationEntryPolicyMakesViewerDraftReachableButNeverCreates() {
        XCTAssertEqual(
            NativeTabDataCreationEntryPolicy.resolve(canEdit: true, hasResumableCreationDraft: false),
            .create
        )
        XCTAssertEqual(
            NativeTabDataCreationEntryPolicy.resolve(canEdit: false, hasResumableCreationDraft: true),
            .viewLocalDraft
        )
        XCTAssertEqual(
            NativeTabDataCreationEntryPolicy.resolve(canEdit: false, hasResumableCreationDraft: false),
            .hidden
        )
    }

    func testDefaultViewSelectionPrefersExistingCurrentThenDefault() throws {
        let views = try decodeViews([
            viewJSON(id: "view-a", name: "列表", order: 0),
            viewJSON(id: "view-b", name: "看板", type: "kanban", order: 1),
        ])

        XCTAssertEqual(
            NativeTabDataViewSelection.preferredViewId(
                current: nil,
                defaultViewId: "view-b",
                views: views
            ),
            "view-b"
        )
        XCTAssertEqual(
            NativeTabDataViewSelection.preferredViewId(
                current: "view-a",
                defaultViewId: "view-b",
                views: views
            ),
            "view-a"
        )
        XCTAssertEqual(
            NativeTabDataViewSelection.preferredViewId(
                current: "deleted-view",
                defaultViewId: "missing-default",
                views: views
            ),
            "view-a"
        )
    }

    func testEditableFieldMatrixOnlyAllowsLosslessFrequentScalars() {
        let editable: [NativeTabDataFieldKind] = [
            .text, .longText, .number, .currency, .percent, .rating,
            .select, .singleSelect, .multiSelect, .checkbox, .date,
            .url, .email, .phone, .user,
        ]
        let fullModeOnly: [NativeTabDataFieldKind] = [
            .createdTime, .lastModifiedTime,
            .createdBy, .lastModifiedBy,
            .attachment, .link, .button, .unknown,
        ]

        XCTAssertTrue(editable.allSatisfy(\.isEditable))
        XCTAssertTrue(fullModeOnly.allSatisfy { !$0.isEditable })
        // createdTime / lastModifiedTime 也是时间，但服务端算出来，不能因为日期开放而跟着可编辑。
        XCTAssertFalse(NativeTabDataFieldKind.createdTime.isEditable)
        XCTAssertFalse(NativeTabDataFieldKind.lastModifiedTime.isEditable)
        // created_by / last_modified_by 是系统计算字段，不能因为人员字段开放而跟着可编辑。
        XCTAssertFalse(NativeTabDataFieldKind.createdBy.isEditable)
        XCTAssertFalse(NativeTabDataFieldKind.lastModifiedBy.isEditable)
        XCTAssertEqual(NativeTabDataFieldKind.normalize(" Single_Select "), "select")
        XCTAssertEqual(NativeTabDataFieldKind.normalize("timestamp"), "timestamp")
        XCTAssertEqual(NativeTabDataFieldKind.normalize("never_seen_type"), "never_seen_type")
        XCTAssertEqual(NativeTabDataDisplayText.make(AnyCodable("usr-0001")), "usr-0001")
        XCTAssertTrue(NativeTabDataDisplayText.looksLikeInternalId("usr-0001"))
        XCTAssertFalse(NativeTabDataDisplayText.looksLikeInternalId("REC-001 客户回访"))
        XCTAssertEqual(
            NativeTabDataDisplayText.make(AnyCodable(["display_name": "林小满", "id": "usr-0001"])),
            "林小满"
        )
    }

    func testFieldCreationRequestNormalizesNameAndChoiceOptions() throws {
        let request = NativeTabDataCreateFieldRequest(
            tableId: "table-1",
            name: "  状态  ",
            fieldType: .select,
            choices: [" 待办 ", "", "进行中", "待办"]
        )

        XCTAssertEqual(request.name, "状态")
        XCTAssertEqual(request.choices, ["待办", "进行中"])
        XCTAssertEqual(request.body["table_id"] as? String, "table-1")
        XCTAssertEqual(request.body["field_type"] as? String, "select")
        let options = try XCTUnwrap(request.body["options"] as? [String: Any])
        XCTAssertEqual(options["choices"] as? [String], ["待办", "进行中"])
    }

    @MainActor
    func testFieldCreationReloadsAuthoritativeSchemaBeforeReportingSuccess() async throws {
        let title = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let status = try XCTUnwrap(decodeFields([
            fieldJSON(
                id: "status",
                name: "状态",
                type: "select",
                order: 1,
                options: ["choices": ["待办", "完成"]]
            ),
        ]).first)
        var metadataRequestCount = 0
        var capturedRequest: NativeTabDataCreateFieldRequest?
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                metadataRequestCount += 1
                return (
                    self.table(role: "editor"),
                    NativeTabDataFieldList(fields: metadataRequestCount == 1 ? [title] : [title, status]),
                    NativeTabDataViewList(views: [])
                )
            },
            recordsRequest: { _, _, _ in .empty },
            createFieldRequest: { request in
                capturedRequest = request
                return status
            }
        )

        await session.load()
        let created = await session.createField(
            name: " 状态 ",
            fieldType: .select,
            choices: ["待办", "完成"]
        )

        XCTAssertTrue(created)
        XCTAssertEqual(metadataRequestCount, 2)
        XCTAssertEqual(session.fields.map(\.id), ["title", "status"])
        XCTAssertEqual(capturedRequest?.name, "状态")
        XCTAssertNil(session.fieldCreationError)
        XCTAssertFalse(session.isCreatingField)
    }

    @MainActor
    func testFieldCreationFailureKeepsLastConfirmedSchema() async throws {
        let title = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        var metadataRequestCount = 0
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                metadataRequestCount += 1
                return (
                    self.table(role: "editor"),
                    NativeTabDataFieldList(fields: [title]),
                    NativeTabDataViewList(views: [])
                )
            },
            recordsRequest: { _, _, _ in .empty },
            createFieldRequest: { _ in
                throw APIError.networkError(URLError(.notConnectedToInternet))
            }
        )

        await session.load()
        let created = await session.createField(name: "备注", fieldType: .longText)

        XCTAssertFalse(created)
        XCTAssertEqual(metadataRequestCount, 1)
        XCTAssertEqual(session.fields.map(\.id), ["title"])
        XCTAssertNotNil(session.fieldCreationError)
        XCTAssertFalse(session.isCreatingField)
    }

    func testDateCodecKeepsCalendarDayAcrossExtremeTimeZones() throws {
        var shanghai = Calendar(identifier: .gregorian)
        shanghai.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        var losAngeles = Calendar(identifier: .gregorian)
        losAngeles.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))

        let shanghaiDate = try XCTUnwrap(NativeTabDataDateCodec.decodeDate("2026-08-13", calendar: shanghai))
        let losAngelesDate = try XCTUnwrap(NativeTabDataDateCodec.decodeDate("2026-08-13", calendar: losAngeles))

        XCTAssertEqual(NativeTabDataDateCodec.encodeDate(shanghaiDate, calendar: shanghai), "2026-08-13")
        XCTAssertEqual(NativeTabDataDateCodec.encodeDate(losAngelesDate, calendar: losAngeles), "2026-08-13")
    }

    func testLockedViewDecodesAndRemainsNativeReadable() throws {
        let view = try XCTUnwrap(decodeViews([
            viewJSON(id: "locked", name: "锁定看板", type: "kanban", isLocked: true),
        ]).first)

        XCTAssertTrue(view.isLocked)
        XCTAssertTrue(view.supportsNativeCards)
        XCTAssertTrue(view.isKanban)
    }

    func testKnownViewTypesUseNativeCardFallbackInsteadOfBlockingTheView() throws {
        let nativeTypes = ["grid", "list", "kanban", "  Grid  "]
        for (index, type) in nativeTypes.enumerated() {
            let view = try XCTUnwrap(decodeViews([
                viewJSON(id: "known-\(index)", name: type, type: type),
            ]).first)
            XCTAssertTrue(view.supportsNativeCards, "known view type should render natively: \(type)")
        }

        let summaryTypes = ["gallery", "calendar", "form", "flashcard", "pivot", "gantt", "future_view"]
        for (index, type) in summaryTypes.enumerated() {
            let view = try XCTUnwrap(decodeViews([
                viewJSON(id: "summary-\(index)", name: type, type: type),
            ]).first)
            XCTAssertFalse(view.supportsNativeCards, "complex view type should use summary: \(type)")
        }
    }

    func testKanbanViewWithLegacyObjectGroupsStillDecodesAndUsesKanbanCards() throws {
        var json = viewJSON(id: "legacy-kanban", name: "任务看板（按状态）", type: " kanban ")
        json["groups"] = ["field_id": "status"]
        json["config"] = ["group_by_field": "status"]

        let view = try XCTUnwrap(decodeViews([json]).first)

        XCTAssertTrue(view.supportsNativeCards)
        XCTAssertTrue(view.isKanban)
        XCTAssertEqual(view.groupFieldKey, "status")
    }

    func testKanbanRecordResponseDoesNotRequireTopLevelRecords() throws {
        let payload: [String: Any] = [
            "total": 1,
            "matched_total": 1,
            "page": 1,
            "page_size": 30,
            "metadata": [
                "groups": [[
                    "group_value": "todo",
                    "group_label": "待处理",
                    "count": 1,
                    "records": [["id": "record-1", "fields": [:], "version": 1]],
                ]],
            ],
        ]

        let decoded: NativeTabDataRecordList = try decode(payload)

        XCTAssertTrue(decoded.records.isEmpty)
        XCTAssertEqual(decoded.matchedTotal, 1)
        XCTAssertEqual(decoded.metadata?.groups.first?.records.first?.id, "record-1")
    }

    @MainActor
    func testNestedViewFilterTakesPriorityAndDefersToServerViewConfiguration() async throws {
        let nestedFilter: [String: Any] = [
            "conjunction": "or",
            "filterSet": [
                ["field_id": "status", "operator": "equals", "value": "todo"],
                [
                    "conjunction": "and",
                    "filterSet": [
                        ["field_id": "priority", "operator": "equals", "value": "high"],
                    ],
                ],
            ],
        ]
        var payload = viewJSON(id: "view-1", name: "嵌套筛选")
        payload["filter"] = nestedFilter
        payload["filters"] = [[
            "field_id": "legacy-only",
            "operator": "equals",
            "value": "must-not-win",
        ]]
        payload["config"] = ["filter_logic": "and"]
        let view = try XCTUnwrap(decodeViews([payload]).first)
        var capturedQuery: [String: String] = [:]
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                (
                    self.table(role: "viewer"),
                    NativeTabDataFieldList(fields: []),
                    NativeTabDataViewList(views: [view])
                )
            },
            recordsRequest: { _, _, query in
                capturedQuery = query
                return NativeTabDataRecordList(
                    records: [], total: 0, matchedTotal: 0, page: 1, pageSize: 30, metadata: nil
                )
            }
        )

        await session.load()

        XCTAssertEqual(view.filterSet?.conjunction, "or")
        XCTAssertNil(capturedQuery["filters"])
        XCTAssertNil(capturedQuery["filter_logic"])
    }

    @MainActor
    func testInvalidNestedViewFilterFallsBackToLegacyFiltersAndConjunction() async throws {
        var payload = viewJSON(id: "view-1", name: "旧筛选")
        payload["filter"] = [
            "conjunction": "xor",
            "filterSet": [["field_id": "invalid", "operator": "equals", "value": "x"]],
        ]
        payload["filters"] = [[
            "field_id": "legacy",
            "operator": "equals",
            "value": "kept",
        ]]
        payload["config"] = ["filter_logic": "or"]
        let view = try XCTUnwrap(decodeViews([payload]).first)
        var capturedQuery: [String: String] = [:]
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                (
                    self.table(role: "viewer"),
                    NativeTabDataFieldList(fields: []),
                    NativeTabDataViewList(views: [view])
                )
            },
            recordsRequest: { _, _, query in
                capturedQuery = query
                return NativeTabDataRecordList(
                    records: [], total: 0, matchedTotal: 0, page: 1, pageSize: 30, metadata: nil
                )
            }
        )

        await session.load()

        XCTAssertNil(view.filterSet)
        XCTAssertEqual(capturedQuery["filter_logic"], "or")
        let filterJSON = try XCTUnwrap(capturedQuery["filters"]?.data(using: .utf8))
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: filterJSON) as? [[String: Any]])
        XCTAssertEqual(decoded.first?["field_id"] as? String, "legacy")
        XCTAssertEqual(decoded.first?["value"] as? String, "kept")
    }

    func testViewLockDoesNotParticipateInRecordWritePolicy() {
        XCTAssertTrue(NativeTabDataWritePolicy.canEditRecords(tableCanEdit: true, saveState: .saved))
        XCTAssertFalse(NativeTabDataWritePolicy.canEditRecords(tableCanEdit: false, saveState: .saved))
        XCTAssertFalse(NativeTabDataWritePolicy.canEditRecords(tableCanEdit: true, saveState: .conflict))
        XCTAssertFalse(NativeTabDataWritePolicy.canEditRecords(tableCanEdit: true, saveState: .permissionDenied))
        // .dirty 是正常的未保存态，不能影响可编辑性。
        XCTAssertTrue(NativeTabDataWritePolicy.canEditRecords(tableCanEdit: true, saveState: .dirty))
    }

    func testMetadataGroupsDecodeRecordsAndUseStableOffsetKey() throws {
        let payload: [String: Any] = [
            "records": [],
            "total": 3,
            "matched_total": 3,
            "page": 1,
            "page_size": 30,
            "metadata": [
                "needs_configuration": false,
                "groups": [[
                    "group_value": "todo",
                    "group_label": "待办",
                    "color": "#3B82F6",
                    "records": [[
                        "id": "record-1",
                        "fields": ["title": "第一条"],
                        "version": 7,
                    ]],
                    "count": 3,
                    "offset": 0,
                    "per_group_limit": 20,
                    "has_more": true,
                ]],
            ],
        ]
        let decoded: NativeTabDataRecordList = try decode(payload)
        let group = try XCTUnwrap(decoded.metadata?.groups.first)

        XCTAssertEqual(group.id, "todo")
        XCTAssertEqual(group.groupLabel, "待办")
        XCTAssertEqual(group.records.first?.version, 7)
        XCTAssertTrue(group.hasMore)
    }

    func testMetadataObjectGroupsDoNotDiscardTopLevelRecords() throws {
        let payload: [String: Any] = [
            "records": [[
                "id": "record-1",
                "table_id": "table-1",
                "fields": ["标题": "仍可读取"],
                "version": 8,
            ]],
            "total": 1,
            "matched_total": 1,
            "page": 1,
            "page_size": 30,
            "metadata": [
                "needs_configuration": false,
                "groups": [
                    "fields": [:],
                    "nodes": [:],
                ],
            ],
        ]

        let decoded: NativeTabDataRecordList = try decode(payload)

        let record = try XCTUnwrap(decoded.records.first)
        XCTAssertEqual(record.id, "record-1")
        XCTAssertEqual(record.fields["标题"]?.value as? String, "仍可读取")
        XCTAssertTrue(decoded.metadata?.groups.isEmpty == true)
    }

    func testGroupPaginationAdvancesByReturnedRecordsWithoutSkippingShortPage() throws {
        let payload: [String: Any] = [
            "group_value": "doing",
            "group_label": "进行中",
            "records": [["id": "record-1", "fields": [:], "version": 1]],
            "count": 100,
            "offset": 20,
            "per_group_limit": 20,
            "has_more": true,
        ]
        let group: NativeTabDataRecordGroup = try decode(payload)

        XCTAssertEqual(NativeTabDataGroupPagination.nextOffset(for: group), 21)
    }

    func testCardProjectionUsesUntitledFallbackAndAtMostFourSummaryFields() throws {
        let fields = try decodeFields((0..<7).map { index in
            fieldJSON(
                id: "field-\(index)",
                name: index == 0 ? "标题" : "字段\(index)",
                type: "text",
                primary: index == 0,
                order: index
            )
        })
        let record = NativeTabDataRecord(
            id: "record-abcdefgh",
            tableId: "table-1",
            fields: Dictionary(uniqueKeysWithValues: (1..<7).map { ("field-\($0)", AnyCodable("值\($0)")) }),
            version: 2
        )
        let projection = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: nil,
            untitledTitle: "未命名记录"
        )

        XCTAssertEqual(projection.title, "未命名记录")
        XCTAssertEqual(projection.fields.count, 4)
        XCTAssertEqual(projection.fields.map(\.fieldId), ["field-1", "field-2", "field-3", "field-4"])
    }

    /// 分组字段照常进摘要。Web 正典只排除标题与封面（mobileTableProjection.ts:84），移动端
    /// 曾多排一层分组，导致同一条记录在 Web 与原生上摘要不是同一组字段。
    /// 共享夹具测不出这条：那里的分组字段排在第 8 位，本来就进不了前 4。
    func testCardSummaryKeepsGroupFieldLikeWebCanon() throws {
        let fields = try decodeFields([
            fieldJSON(id: "field-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "field-status", name: "状态", type: "select", order: 1),
            fieldJSON(id: "field-a", name: "字段A", type: "text", order: 2),
            fieldJSON(id: "field-b", name: "字段B", type: "text", order: 3),
            fieldJSON(id: "field-c", name: "字段C", type: "text", order: 4),
        ])
        let view = try XCTUnwrap(
            decodeViews([viewJSON(id: "view-1", name: "主视图", config: ["group_field": "field-status"])]).first
        )
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "field-title": AnyCodable("标题值"),
                "field-status": AnyCodable("处理中"),
                "field-a": AnyCodable("A"),
                "field-b": AnyCodable("B"),
                "field-c": AnyCodable("C"),
            ],
            version: 1
        )

        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: view,
            untitledTitle: "未命名记录"
        )

        XCTAssertEqual(card.fields.map(\.fieldId), ["field-status", "field-a", "field-b", "field-c"])
    }

    /// 未配 card_cover_field 时按类型回落到第一个 attachment 可见字段，
    /// 且封面字段不再占摘要位置——与 mobileTableProjection.ts:79-87 一致。
    func testCardCoverFallsBackToFirstAttachmentFieldAndLeavesSummary() throws {
        let fields = try decodeFields([
            fieldJSON(id: "field-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "field-cover", name: "示意图", type: "attachment", order: 1),
            fieldJSON(id: "field-a", name: "字段A", type: "text", order: 2),
        ])
        let view = try XCTUnwrap(decodeViews([viewJSON(id: "view-1", name: "主视图")]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "field-title": AnyCodable("标题值"),
                "field-cover": AnyCodable([[
                    "name": "对比图.png",
                    "mimeType": "image/png",
                    "url": "https://oss.example.com/cover.png",
                ]]),
                "field-a": AnyCodable("A"),
            ],
            version: 1
        )

        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: view,
            untitledTitle: "未命名记录"
        )

        XCTAssertEqual(card.coverUrl, "https://oss.example.com/cover.png")
        XCTAssertEqual(card.fields.map(\.fieldId), ["field-a"])
    }

    /// 缩略图优先于原图，且不受 mime 闸门影响——对齐 extractMobileCoverUrl 的取键顺序。
    func testCardCoverPrefersThumbnailOverFullImage() throws {
        let fields = try decodeFields([
            fieldJSON(id: "field-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "field-cover", name: "示意图", type: "attachment", order: 1),
        ])
        let view = try XCTUnwrap(decodeViews([viewJSON(id: "view-1", name: "主视图")]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "field-title": AnyCodable("标题值"),
                "field-cover": AnyCodable([[
                    "name": "原图.png",
                    "url": "https://oss.example.com/full.png",
                    "thumbnail_url": "https://oss.example.com/thumb.png",
                ]]),
            ],
            version: 1
        )

        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: view,
            untitledTitle: "未命名记录"
        )

        XCTAssertEqual(card.coverUrl, "https://oss.example.com/thumb.png")
    }

    /// 非图片附件不能当封面：PDF 有 url 也要跳过，否则卡片会拿 PDF 地址去当图加载。
    func testCardCoverSkipsNonImageAttachment() throws {
        let fields = try decodeFields([
            fieldJSON(id: "field-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "field-spec", name: "需求文档", type: "attachment", order: 1),
        ])
        let view = try XCTUnwrap(decodeViews([viewJSON(id: "view-1", name: "主视图")]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "field-title": AnyCodable("标题值"),
                "field-spec": AnyCodable([[
                    "name": "修复方案.pdf",
                    "mimeType": "application/pdf",
                    "url": "https://oss.example.com/spec.pdf",
                ]]),
            ],
            version: 1
        )

        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: view,
            untitledTitle: "未命名记录"
        )

        XCTAssertNil(card.coverUrl)
    }

    /// 有意偏离 Web：配置的封面字段仍须是 attachment。Web 会把任意配置字段的字符串
    /// 值直接当图片地址取用，一处 url 字段配置就能让卡片去拉任意外链。
    func testConfiguredCoverFieldStillMustBeAttachment() throws {
        let fields = try decodeFields([
            fieldJSON(id: "field-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "field-link", name: "相关链接", type: "url", order: 1),
        ])
        let view = try XCTUnwrap(
            decodeViews([viewJSON(id: "view-1", name: "主视图", config: ["card_cover_field": "field-link"])]).first
        )
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "field-title": AnyCodable("标题值"),
                "field-link": AnyCodable("https://evil.example.com/track.png"),
            ],
            version: 1
        )

        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: view,
            untitledTitle: "未命名记录"
        )

        XCTAssertNil(card.coverUrl)
        XCTAssertEqual(card.fields.map(\.fieldId), ["field-link"], "不当封面就该照常进摘要")
    }

    func testCardCoverIsNilWhenAttachmentValueIsEmpty() throws {
        let fields = try decodeFields([
            fieldJSON(id: "field-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "field-cover", name: "示意图", type: "attachment", order: 1),
        ])
        let view = try XCTUnwrap(decodeViews([viewJSON(id: "view-1", name: "主视图")]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["field-title": AnyCodable("标题值"), "field-cover": AnyCodable([Any]())],
            version: 1
        )

        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: view,
            untitledTitle: "未命名记录"
        )

        XCTAssertNil(card.coverUrl)
    }

    func testSelectOptionKeepsStorageValueSeparateFromLabel() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(
                id: "status",
                name: "状态",
                type: "select",
                options: ["choices": [[
                    "id": "todo-id",
                    "value": "todo",
                    "label": "待办",
                    "color": "#3B82F6",
                ]]]
            ),
        ]).first)

        XCTAssertEqual(field.selectOptions, [
            NativeTabDataSelectOption(value: "todo", label: "待办", color: "#3B82F6"),
        ])
    }

    func testDraftPersistsDirtyFieldsAndExpectedVersion() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let titleField = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("旧标题")],
            version: 12
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [titleField]
        )
        draft.set(.text("新标题"), for: titleField)
        try store.save(draft, userId: "user-1")

        let restored = try XCTUnwrap(store.load(
            recordId: "record-1",
            tableId: "table-1",
            userId: "user-1",
            organizationId: "org-1"
        ))
        let body = restored.updateBody()
        XCTAssertEqual(restored.dirtyFieldIds, Set(["title"]))
        XCTAssertNil(body["expected_version"])
        XCTAssertEqual((body["fields"] as? [String: Any])?["title"] as? String, "新标题")
        let item = restored.bulkUpdateItem()
        XCTAssertEqual(item["record_id"] as? String, "record-1")
        XCTAssertNil(item["expected_version"])
        XCTAssertEqual((item["data"] as? [String: Any])?["title"] as? String, "新标题")
        XCTAssertEqual((item["base_snapshot"] as? [String: Any])?["title"] as? String, "旧标题")
        XCTAssertTrue(store.hasDraft(tableId: "table-1", userId: "user-1", organizationId: "org-1"))
        XCTAssertFalse(store.hasDraft(tableId: "table-1", userId: "another-user", organizationId: "org-1"))
        XCTAssertFalse(store.hasDraft(tableId: "table-1", userId: "user-1", organizationId: "org-2"))

        store.removeAll(tableId: "table-1", userId: "user-1", organizationId: "org-1")
        XCTAssertFalse(store.hasDraft(tableId: "table-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testDeleteUsesDraftBaselineAnd409KeepsDraftInConflict() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let openedRecord = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("远端标题")],
            version: 12
        )
        var capturedRequest: NativeTabDataDeleteRequest?
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                (
                    self.table(role: "editor"),
                    NativeTabDataFieldList(fields: [field]),
                    NativeTabDataViewList(views: [])
                )
            },
            recordsRequest: { _, _, _ in
                NativeTabDataRecordList(
                    records: [openedRecord],
                    total: 1,
                    matchedTotal: 1,
                    page: 1,
                    pageSize: 30,
                    metadata: nil
                )
            },
            deleteRequest: { request in
                capturedRequest = request
                throw APIError.serverError(409, nil)
            }
        )

        await session.load()
        session.updateDraft(record: openedRecord, field: field, value: .text("删除前本地修改"))
        let refreshedRecord = NativeTabDataRecord(
            id: openedRecord.id,
            tableId: openedRecord.tableId,
            fields: openedRecord.fields,
            version: 99
        )

        let deleted = await session.delete(record: refreshedRecord)

        XCTAssertFalse(deleted)
        XCTAssertEqual(capturedRequest?.recordId, openedRecord.id)
        XCTAssertEqual(capturedRequest?.expectedVersion, 12)
        XCTAssertEqual(capturedRequest?.query["expected_version"], "12")
        XCTAssertEqual(session.saveState, .dirty)
        XCTAssertEqual(session.saveError, L10n.TabData.deleteModifiedMessage)
        XCTAssertTrue(session.canEdit)
        XCTAssertTrue(session.canEdit)
        XCTAssertEqual(session.value(record: openedRecord, field: field), .text("删除前本地修改"))
        XCTAssertNotNil(store.load(
            recordId: openedRecord.id,
            tableId: "table-1",
            userId: "user-1",
            organizationId: "org-1"
        ))
    }

    func testBulkUpdateBodyUsesFieldIdsAndOmitsExpectedVersion() throws {
        let fields = try decodeFields([
            fieldJSON(id: "fld-title", name: "标题", type: "text", primary: true),
            fieldJSON(id: "fld-status", name: "状态", type: "select"),
        ])
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "fld-title": AnyCodable("旧标题"),
                "fld-status": AnyCodable("todo"),
            ],
            version: 4
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: fields
        )
        draft.set(.text("新标题"), for: fields[0])

        let body = draft.bulkUpdateBody(operationGroupId: "op-1")
        XCTAssertEqual(body["operation_group_id"] as? String, "op-1")
        XCTAssertNil(body["expected_version"])
        let updates = try XCTUnwrap(body["updates"] as? [[String: Any]])
        let item = try XCTUnwrap(updates.first)
        XCTAssertEqual(item["record_id"] as? String, "record-1")
        XCTAssertNil(item["expected_version"])
        let data = try XCTUnwrap(item["data"] as? [String: Any])
        let snapshot = try XCTUnwrap(item["base_snapshot"] as? [String: Any])
        XCTAssertEqual(Array(data.keys), ["fld-title"])
        XCTAssertEqual(Array(snapshot.keys), ["fld-title"])
        XCTAssertEqual(data["fld-title"] as? String, "新标题")
        XCTAssertEqual(snapshot["fld-title"] as? String, "旧标题")
        XCTAssertNil(snapshot["fld-status"])
        XCTAssertNil(data["标题"])
        XCTAssertNil(snapshot["标题"])
    }

    func testBulkUpdateSnapshotKeepsEditStartValueNotLatestRemote() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["fld-title": AnyCodable("编辑起点")],
            version: 2
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.text("我改的"), for: field)
        let laterRemote = NativeTabDataRecord(
            id: record.id,
            tableId: record.tableId,
            fields: ["fld-title": AnyCodable("别人刚改的")],
            version: 9
        )

        XCTAssertEqual(draft.value(for: field), .text("我改的"))
        XCTAssertEqual(
            (draft.bulkUpdateItem()["base_snapshot"] as? [String: Any])?["fld-title"] as? String,
            "编辑起点"
        )
        XCTAssertNotEqual(
            (draft.bulkUpdateItem()["base_snapshot"] as? [String: Any])?["fld-title"] as? String,
            laterRemote.fields["fld-title"]?.stringValue
        )
    }

    func testLegacyDraftWithoutBaselineOmitsBaseSnapshot() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["fld-title": AnyCodable("旧标题")],
            version: 3
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.text("新标题"), for: field)
        let encoded = try JSONEncoder().encode(draft)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "baseValues")
        let legacy = try JSONDecoder().decode(
            NativeTabDataRecordDraft.self,
            from: try JSONSerialization.data(withJSONObject: object)
        )

        XCTAssertEqual(legacy.value(for: field), .text("新标题"))
        XCTAssertNil(legacy.bulkUpdateItem()["base_snapshot"])
        XCTAssertEqual((legacy.bulkUpdateItem()["data"] as? [String: Any])?["fld-title"] as? String, "新标题")
        XCTAssertNil(legacy.bulkUpdateBody()["expected_version"])
    }

    func testDraftRevertingToBaselineClearsDirtyAndCanSubmit() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("旧标题")],
            version: 3
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.text("新标题"), for: field)
        XCTAssertTrue(draft.canSubmit)
        XCTAssertEqual(draft.dirtyFieldIds, Set(["title"]))

        draft.set(.text("旧标题"), for: field)
        XCTAssertFalse(draft.canSubmit)
        XCTAssertTrue(draft.dirtyFieldIds.isEmpty)
        XCTAssertEqual(draft.value(for: field), .text("旧标题"))
    }

    func testLegacyDraftWithoutBaselineKeepsTouchedDirtyAfterRevert() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("旧标题")],
            version: 3
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.text("新标题"), for: field)
        let encoded = try JSONEncoder().encode(draft)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "baseValues")
        var legacy = try JSONDecoder().decode(
            NativeTabDataRecordDraft.self,
            from: try JSONSerialization.data(withJSONObject: object)
        )
        legacy.set(.text("旧标题"), for: field)
        XCTAssertTrue(legacy.canSubmit)
        XCTAssertEqual(legacy.dirtyFieldIds, Set(["title"]))
    }

    @MainActor
    func testSaveVersionConflictKeepsTableEditableForRetry() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-title", name: "标题", type: "text", primary: true),
        ]).first)
        let first = NativeTabDataRecord(
            id: "record-a",
            tableId: "table-1",
            fields: ["fld-title": AnyCodable("A")],
            version: 1
        )
        let second = NativeTabDataRecord(
            id: "record-b",
            tableId: "table-1",
            fields: ["fld-title": AnyCodable("B")],
            version: 1
        )
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                (
                    self.table(role: "editor"),
                    NativeTabDataFieldList(fields: [field]),
                    NativeTabDataViewList(views: [])
                )
            },
            recordsRequest: { _, _, _ in
                NativeTabDataRecordList(
                    records: [first, second],
                    total: 2,
                    matchedTotal: 2,
                    page: 1,
                    pageSize: 30,
                    metadata: nil
                )
            },
            updateRequest: { _, _ in throw APIError.serverError(409, nil) }
        )

        await session.load()
        session.updateDraft(record: first, field: field, value: .text("A-本地"))

        let saved = await session.save(record: first)

        XCTAssertFalse(saved)
        XCTAssertEqual(session.saveState, .dirty)
        XCTAssertNotEqual(session.saveState, .conflict)
        // 兜底 409 也不锁：草稿保留、整表仍可编辑，用户改完能直接重试。
        XCTAssertTrue(session.canEdit)
        XCTAssertEqual(session.value(record: first, field: field), .text("A-本地"))
        session.updateDraft(record: first, field: field, value: .text("A-改过再存"))
        XCTAssertEqual(session.value(record: first, field: field), .text("A-改过再存"))
        session.updateDraft(record: second, field: field, value: .text("B-本地"))
        XCTAssertEqual(session.value(record: second, field: field), .text("B-本地"))
    }

    @MainActor
    func testSaveSuccessWithAdvisoryConflictsClearsDraftAndKeepsTableEditable() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-status", name: "状态", type: "select"),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["fld-status": AnyCodable("todo")],
            version: 3
        )
        let updated = NativeTabDataRecord(
            id: record.id,
            tableId: record.tableId,
            fields: ["fld-status": AnyCodable("doing")],
            version: 4
        )
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                (
                    self.table(role: "editor"),
                    NativeTabDataFieldList(fields: [field]),
                    NativeTabDataViewList(views: [])
                )
            },
            recordsRequest: { _, _, _ in
                NativeTabDataRecordList(
                    records: [record],
                    total: 1,
                    matchedTotal: 1,
                    page: 1,
                    pageSize: 30,
                    metadata: nil
                )
            },
            updateRequest: { _, _ in
                NativeTabDataRecordUpdateResult(
                    record: updated,
                    conflicts: [
                        NativeTabDataBulkUpdateConflict(
                            recordId: record.id,
                            fieldId: "fld-status",
                            yourValue: AnyCodable("doing"),
                            serverValue: AnyCodable("blocked")
                        )
                    ]
                )
            }
        )

        await session.load()
        session.updateDraft(record: record, field: field, value: .selections(["doing"]))

        let saved = await session.save(record: record)

        XCTAssertTrue(saved)
        XCTAssertEqual(session.saveState, .saved)
        XCTAssertTrue(session.canEdit)
        XCTAssertEqual(session.saveNotice, L10n.TabData.advisoryConflict("状态"))
        XCTAssertNil(session.saveError)
        XCTAssertNil(store.load(
            recordId: record.id,
            tableId: "table-1",
            userId: "user-1",
            organizationId: "org-1"
        ))
        XCTAssertEqual(session.record(id: record.id)?.version, 4)
    }

    func testAdvisoryConflictMessageListsLeadingFieldsThenOverflow() {
        XCTAssertEqual(
            NativeTabDataAdvisoryConflictPolicy.message(fieldNames: ["状态"]),
            L10n.TabData.advisoryConflict("状态")
        )
        XCTAssertEqual(
            NativeTabDataAdvisoryConflictPolicy.message(fieldNames: ["状态", "负责人"]),
            L10n.TabData.advisoryConflictList("「状态」「负责人」")
        )
        XCTAssertEqual(
            NativeTabDataAdvisoryConflictPolicy.message(fieldNames: ["状态", "负责人", "优先级"]),
            L10n.TabData.advisoryConflictOverflow("「状态」「负责人」", 3)
        )
    }

    func testCreateBodyDoesNotSendSyntheticRecordOrVersion() throws {
        let titleField = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "draft-local-only",
            tableId: "table-1",
            fields: [:],
            version: 0
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [titleField]
        )
        draft.set(.text("新记录"), for: titleField)
        let body = draft.createBody()

        XCTAssertEqual(body["table_id"] as? String, "table-1")
        XCTAssertNil(body["expected_version"])
        XCTAssertNil(body["id"])
        XCTAssertEqual((body["fields"] as? [String: Any])?["title"] as? String, "新记录")
    }

    func testSingleSelectUsesScalarWhileMultiSelectUsesArray() throws {
        let fields = try decodeFields([
            fieldJSON(id: "status", name: "状态", type: "select"),
            fieldJSON(id: "tags", name: "标签", type: "multi_select"),
        ])
        let record = NativeTabDataRecord(id: "record-1", tableId: "table-1", fields: [:], version: 1)
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: fields
        )
        draft.set(.selections(["todo"]), for: fields[0])
        draft.set(.selections(["urgent", "mobile"]), for: fields[1])

        let changed = try XCTUnwrap(draft.updateBody()["fields"] as? [String: Any])
        XCTAssertEqual(changed["status"] as? String, "todo")
        XCTAssertEqual(changed["tags"] as? [String], ["urgent", "mobile"])
    }

    func testNumberDraftKeepsIntermediateTextButRejectsInvalidSaveValue() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "amount", name: "金额", type: "number"),
        ]).first)
        let record = NativeTabDataRecord(id: "record-1", tableId: "table-1", fields: [:], version: 1)
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )

        draft.set(.number("-"), for: field)
        XCTAssertEqual(draft.value(for: field), .number("-"))
        XCTAssertTrue(draft.hasInvalidValues)

        draft.set(.number("-12.50"), for: field)
        XCTAssertFalse(draft.hasInvalidValues)
        XCTAssertEqual((draft.updateBody()["fields"] as? [String: Any])?["amount"] as? NSDecimalNumber, NSDecimalNumber(string: "-12.50"))
    }

    /// date 的编解码要能把线上串接回选择器再原样写出去。
    func testDateDraftRoundTripsWireFormat() throws {
        let fields = try decodeFields([
            fieldJSON(id: "due", name: "截止日", type: "date"),
        ])
        let due = try XCTUnwrap(fields.first { $0.id == "due" })
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "due": AnyCodable("2026-08-18"),
            ],
            version: 1
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: fields
        )

        XCTAssertTrue(due.fieldType.isEditable)
        XCTAssertEqual(draft.value(for: due), .date(NativeTabDataDateCodec.decodeDate("2026-08-18")))

        let picked = try XCTUnwrap(NativeTabDataDateCodec.decodeDate("2026-09-01"))
        draft.set(.date(picked), for: due)
        let changed = try XCTUnwrap(draft.updateBody()["fields"] as? [String: Any])
        XCTAssertEqual(changed["due"] as? String, "2026-09-01")
    }

    /// 落盘的旧草稿只覆盖当时可编辑的类型。日期放开后，旧草稿在日期字段上没有键，
    /// 详情页必须回落到远端值，而不是把「草稿没记」显示成「被清空」。
    func testStaleDraftWithoutNewlyEditableFieldFallsBackToRemoteValue() throws {
        let fields = try decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text"),
            fieldJSON(id: "due", name: "截止日", type: "date"),
        ])
        let due = try XCTUnwrap(fields.first { $0.id == "due" })
        let title = try XCTUnwrap(fields.first { $0.id == "title" })
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("回访"), "due": AnyCodable("2026-08-18")],
            version: 1
        )
        // 只用文本字段建草稿，模拟日期还是只读时落盘的那一版。
        var stale = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [title]
        )
        stale.set(.text("回访改了"), for: title)

        XCTAssertTrue(stale.covers(title))
        XCTAssertFalse(stale.covers(due))
        // 直接读草稿会得到空日期——这正是要靠 covers 拦住的形态。
        XCTAssertEqual(stale.value(for: due), .date(nil))
    }

    func testDraftStoreSeparatesSameResourceAcrossOrganizationsAndTargetedRemoval() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text"),
        ]).first)
        let record = NativeTabDataRecord(id: "same-record", tableId: "same-table", fields: [:], version: 1)

        for organizationId in ["org/a", "org.a"] {
            var draft = NativeTabDataRecordDraft(
                record: record,
                tableId: "same-table",
                organizationId: organizationId,
                fields: [field]
            )
            draft.set(.text(organizationId), for: field)
            try store.save(draft, userId: "user.same")
        }

        XCTAssertEqual(
            store.load(recordId: "same-record", tableId: "same-table", userId: "user.same", organizationId: "org/a")?.value(for: field),
            .text("org/a")
        )
        XCTAssertEqual(
            store.load(recordId: "same-record", tableId: "same-table", userId: "user.same", organizationId: "org.a")?.value(for: field),
            .text("org.a")
        )

        store.removeAll(tableId: "same-table", userId: "user.same", organizationId: "org/a")
        XCTAssertNil(store.load(recordId: "same-record", tableId: "same-table", userId: "user.same", organizationId: "org/a"))
        XCTAssertNotNil(store.load(recordId: "same-record", tableId: "same-table", userId: "user.same", organizationId: "org.a"))
    }

    func testSaveRebasePreservesEditsMadeAfterSubmittedSnapshot() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text"),
        ]).first)
        let original = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("old")],
            version: 5
        )
        var submitted = NativeTabDataRecordDraft(
            record: original,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        submitted.set(.text("first"), for: field)
        var latest = submitted
        latest.set(.text("second"), for: field)
        let server = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("first")],
            version: 6
        )

        let rebased = try XCTUnwrap(latest.rebased(after: submitted, onto: server, fields: [field]))
        XCTAssertEqual(rebased.value(for: field), .text("second"))
        XCTAssertEqual(rebased.baseVersion, 6)
        XCTAssertNil(rebased.updateBody()["expected_version"])
        XCTAssertNil(rebased.bulkUpdateItem()["expected_version"])
    }

    func testDraftSchemaCompatibilityRejectsDeletedOrRetypedDirtyFields() throws {
        let textField = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text"),
        ]).first)
        let statusField = try XCTUnwrap(decodeFields([
            fieldJSON(id: "status", name: "状态", type: "select"),
        ]).first)
        let retypedField = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "number"),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("old"), "status": AnyCodable("todo")],
            version: 1
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [textField, statusField]
        )
        draft.set(.text("new"), for: textField)
        draft.set(.selections(["doing"]), for: statusField)

        // isCompatible 仍只是判定；剔除后其余脏字段继续可提交。
        XCTAssertTrue(draft.isCompatible(with: [textField, statusField]))
        XCTAssertFalse(draft.isCompatible(with: [statusField]))
        XCTAssertFalse(draft.isCompatible(with: [retypedField, statusField]))

        let afterDelete = NativeTabDataDroppedFieldPolicy.rebase(
            draft: draft,
            previousFields: [textField, statusField],
            nextFields: [statusField]
        )
        XCTAssertEqual(afterDelete.droppedFieldNames, ["标题"])
        XCTAssertFalse(afterDelete.draft.dirtyFieldIds.contains("title"))
        XCTAssertTrue(afterDelete.draft.dirtyFieldIds.contains("status"))
        XCTAssertTrue(afterDelete.draft.canSubmit)
        XCTAssertTrue(afterDelete.draft.isCompatible(with: [statusField]))

        let afterRetype = NativeTabDataDroppedFieldPolicy.rebase(
            draft: draft,
            previousFields: [textField, statusField],
            nextFields: [retypedField, statusField]
        )
        XCTAssertEqual(afterRetype.droppedFieldNames, ["标题"])
        XCTAssertTrue(afterRetype.draft.canSubmit)
        XCTAssertTrue(afterRetype.draft.isCompatible(with: [retypedField, statusField]))
    }

    func testLegacyDraftWithoutFieldNamesStillDecodes() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("旧标题")],
            version: 3
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.text("新标题"), for: field)
        let encoded = try JSONEncoder().encode(draft)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "fieldNames")
        let legacy = try JSONDecoder().decode(
            NativeTabDataRecordDraft.self,
            from: try JSONSerialization.data(withJSONObject: object)
        )

        XCTAssertEqual(legacy.fieldNames, [:])
        XCTAssertEqual(legacy.value(for: field), .text("新标题"))
        XCTAssertTrue(legacy.canSubmit)
        let rebased = NativeTabDataDroppedFieldPolicy.rebase(
            draft: legacy,
            previousFields: [],
            nextFields: []
        )
        XCTAssertEqual(rebased.droppedFieldNames, ["title"])
    }

    func testFullEditorPolicySeparatesOpenDiscardAndSavingHandoffs() {
        XCTAssertEqual(
            NativeTabDataFullEditorPolicy.preparation(hasDirtyDrafts: false, saveState: .saved),
            .open
        )
        XCTAssertEqual(
            NativeTabDataFullEditorPolicy.preparation(hasDirtyDrafts: true, saveState: .dirty),
            .confirmDiscard
        )
        XCTAssertEqual(
            NativeTabDataFullEditorPolicy.preparation(hasDirtyDrafts: false, saveState: .conflict),
            .confirmDiscard
        )
        XCTAssertEqual(
            NativeTabDataFullEditorPolicy.preparation(hasDirtyDrafts: true, saveState: .saving),
            .waitForSave
        )
        XCTAssertTrue(NativeTabDataFullEditorPolicy.canSaveCurrentDraft(
            hasDirtyFields: true,
            canEdit: true,
            saveState: .dirty
        ))
        XCTAssertFalse(NativeTabDataFullEditorPolicy.canSaveCurrentDraft(
            hasDirtyFields: true,
            canEdit: true,
            saveState: .conflict
        ))
    }

    func testOperationGateInvalidatesOlderQueriesAndAllowsOnlyOneMutation() throws {
        var gate = NativeTabDataOperationGate()
        let query = try XCTUnwrap(gate.beginReplacingQuery())
        XCTAssertTrue(gate.accepts(query))
        let pagination = try XCTUnwrap(gate.beginIndependentQuery())
        XCTAssertTrue(gate.accepts(pagination))

        let mutation = try XCTUnwrap(gate.beginMutation())
        XCTAssertFalse(gate.accepts(query))
        XCTAssertFalse(gate.accepts(pagination))
        XCTAssertTrue(gate.accepts(mutation))
        XCTAssertTrue(gate.isMutationInFlight)
        XCTAssertNil(gate.beginMutation())
        XCTAssertNil(gate.currentQuery())
        XCTAssertNil(gate.beginIndependentQuery())

        gate.finishMutation(mutation)
        XCTAssertFalse(gate.isMutationInFlight)
        XCTAssertFalse(gate.accepts(mutation))
        XCTAssertNotNil(gate.beginReplacingQuery())
    }

    func testOperationGateInvalidationRejectsEveryOutstandingResult() throws {
        var gate = NativeTabDataOperationGate()
        let query = try XCTUnwrap(gate.beginReplacingQuery())
        gate.invalidate()

        XCTAssertFalse(gate.accepts(query))
        XCTAssertFalse(gate.isMutationInFlight)
    }

    @MainActor
    func testInvalidSessionClearsPersistedDraftBeforeQueryMutation() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text"),
        ]).first)
        let record = NativeTabDataRecord(id: "record-1", tableId: "table-1", fields: [:], version: 1)
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.text("sensitive"), for: field)
        try store.save(draft, userId: "user-1")

        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { false }
        )

        XCTAssertTrue(session.hasDirtyDrafts)
        await session.search("must-not-stick")
        XCTAssertFalse(session.hasDirtyDrafts)
        XCTAssertEqual(session.searchText, "")
        XCTAssertEqual(session.saveState, .permissionDenied)
        XCTAssertEqual(session.loadError, L10n.TabData.permissionMessage)
        XCTAssertFalse(store.hasDraft(tableId: "table-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testMismatchedTableMetadataKeepsDraftAndRejectsResponse() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("远端标题")],
            version: 1
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.text("本地草稿"), for: field)
        try store.save(draft, userId: "user-1")
        var wrongTable = table(role: "editor")
        wrongTable = NativeTabDataTable(
            id: "another-table",
            name: wrongTable.name,
            organizationId: wrongTable.organizationId,
            defaultViewId: wrongTable.defaultViewId,
            currentUserRole: wrongTable.currentUserRole
        )
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                (wrongTable, NativeTabDataFieldList(fields: [field]), NativeTabDataViewList(views: []))
            },
            recordsRequest: { _, _, _ in XCTFail("身份错误的表不能继续取记录"); return .empty }
        )

        await session.load()

        XCTAssertNil(session.table)
        XCTAssertTrue(session.records.isEmpty)
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertEqual(session.loadError, L10n.TabData.conflictMessage)
        XCTAssertEqual(store.load(
            recordId: record.id,
            tableId: "table-1",
            userId: "user-1",
            organizationId: "org-1"
        )?.value(for: field), .text("本地草稿"))
    }

    @MainActor
    func testInvalidRecordListIdentityRejectsWholeRefreshWithoutReplacingExistingDataOrDraft() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let existing = NativeTabDataRecord(
            id: "existing",
            tableId: "table-1",
            fields: ["title": AnyCodable("已有记录")],
            version: 1
        )
        let invalidLists = [
            NativeTabDataRecord(id: "bad", tableId: nil, fields: [:], version: 1),
            NativeTabDataRecord(id: "bad", tableId: "another-table", fields: [:], version: 1),
        ]

        for invalid in invalidLists {
            var requestCount = 0
            let session = NativeTabDataSession(
                tableId: "table-1",
                organizationId: "org-1",
                draftStore: store,
                userId: "user-1",
                sessionGeneration: 7,
                sessionIsCurrent: { true },
                metadataRequest: { _ in
                    (self.table(role: "editor"), NativeTabDataFieldList(fields: [field]), NativeTabDataViewList(views: []))
                },
                recordsRequest: { _, _, _ in
                    requestCount += 1
                    let records = requestCount == 1 ? [existing] : [invalid]
                    return NativeTabDataRecordList(
                        records: records, total: 1, matchedTotal: 1, page: 1, pageSize: 30, metadata: nil
                    )
                }
            )
            await session.load()
            session.updateDraft(record: existing, field: field, value: .text("本地修改"))

            await session.refresh()

            XCTAssertEqual(session.records.map(\.id), [existing.id])
            XCTAssertEqual(session.value(record: existing, field: field), .text("本地修改"))
            XCTAssertEqual(session.saveState, .conflict)
            XCTAssertEqual(session.loadError, L10n.TabData.conflictMessage)
            XCTAssertNotNil(store.load(
                recordId: existing.id,
                tableId: "table-1",
                userId: "user-1",
                organizationId: "org-1"
            ))
        }
    }

    @MainActor
    func testSaveDenialRevalidationKeepsDraftWhenTableBecomesViewer() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("远端标题")],
            version: 1
        )
        var metadataRequestCount = 0
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                metadataRequestCount += 1
                return (
                    self.table(role: metadataRequestCount == 1 ? "editor" : "viewer"),
                    NativeTabDataFieldList(fields: [field]),
                    NativeTabDataViewList(views: [])
                )
            },
            recordsRequest: { _, _, _ in
                NativeTabDataRecordList(
                    records: [record],
                    total: 1,
                    matchedTotal: 1,
                    page: 1,
                    pageSize: 30,
                    metadata: nil
                )
            },
            updateRequest: { _, _ in
                throw APIError.serverError(403, nil)
            }
        )

        await session.load()
        session.updateDraft(record: record, field: field, value: .text("本地标题"))

        let saved = await session.save(record: record)

        XCTAssertFalse(saved)
        XCTAssertEqual(metadataRequestCount, 2)
        XCTAssertEqual(session.table?.currentUserRole, "viewer")
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertEqual(session.saveError, L10n.TabData.conflictMessage)
        XCTAssertFalse(session.canEdit)
        XCTAssertEqual(session.value(record: record, field: field), .text("本地标题"))
        XCTAssertNotNil(session.record(id: record.id))
        XCTAssertEqual(
            store.load(
                recordId: record.id,
                tableId: "table-1",
                userId: "user-1",
                organizationId: "org-1"
            )?.value(for: field),
            .text("本地标题")
        )
    }

    @MainActor
    func testUpdateResponseWithMismatchedIdentityKeepsDraftAndLocksWrites() async throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let original = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("远端标题")],
            version: 4
        )
        let invalidResponses = [
            NativeTabDataRecord(
                id: "another-record",
                tableId: "table-1",
                fields: ["title": AnyCodable("错误记录")],
                version: 5
            ),
            NativeTabDataRecord(
                id: "record-1",
                tableId: "another-table",
                fields: ["title": AnyCodable("越界表格")],
                version: 5
            ),
            NativeTabDataRecord(
                id: "record-1",
                tableId: nil,
                fields: ["title": AnyCodable("缺少表格身份")],
                version: 5
            ),
        ]

        for invalidResponse in invalidResponses {
            let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
            let store = NativeTabDataDraftStore(store: defaults)
            let session = NativeTabDataSession(
                tableId: "table-1",
                organizationId: "org-1",
                draftStore: store,
                userId: "user-1",
                sessionGeneration: 7,
                sessionIsCurrent: { true },
                metadataRequest: { _ in
                    (
                        self.table(role: "editor"),
                        NativeTabDataFieldList(fields: [field]),
                        NativeTabDataViewList(views: [])
                    )
                },
                recordsRequest: { _, _, _ in
                    NativeTabDataRecordList(
                        records: [original],
                        total: 1,
                        matchedTotal: 1,
                        page: 1,
                        pageSize: 30,
                        metadata: nil
                    )
                },
                updateRequest: { _, _ in NativeTabDataRecordUpdateResult(record: invalidResponse) }
            )

            await session.load()
            session.updateDraft(record: original, field: field, value: .text("本地标题"))

            let saved = await session.save(record: original)

            XCTAssertFalse(saved)
            XCTAssertEqual(session.saveState, .conflict)
            XCTAssertEqual(session.saveError, L10n.TabData.conflictMessage)
            XCTAssertFalse(session.canEdit)
            XCTAssertEqual(session.record(id: original.id)?.fields["title"]?.stringValue, "远端标题")
            XCTAssertNil(session.record(id: "another-record"))
            XCTAssertEqual(session.value(record: original, field: field), .text("本地标题"))
            XCTAssertNotNil(store.load(
                recordId: original.id,
                tableId: "table-1",
                userId: "user-1",
                organizationId: "org-1"
            ))
        }
    }

    @MainActor
    func testCreateResponseRequiresCurrentTableIdentityBeforeRemovingDraft() async throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let localRecord = NativeTabDataRecord(
            id: "local-record",
            tableId: "table-1",
            fields: [:],
            version: 0
        )
        let invalidResponses = [
            NativeTabDataRecord(
                id: "created-record",
                tableId: "another-table",
                fields: ["title": AnyCodable("错误表格")],
                version: 1
            ),
            NativeTabDataRecord(
                id: "created-record",
                tableId: nil,
                fields: ["title": AnyCodable("缺少表格身份")],
                version: 1
            ),
        ]

        for invalidResponse in invalidResponses {
            let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
            let store = NativeTabDataDraftStore(store: defaults)
            let session = NativeTabDataSession(
                tableId: "table-1",
                organizationId: "org-1",
                draftStore: store,
                userId: "user-1",
                sessionGeneration: 7,
                sessionIsCurrent: { true },
                metadataRequest: { _ in
                    (
                        self.table(role: "editor"),
                        NativeTabDataFieldList(fields: [field]),
                        NativeTabDataViewList(views: [])
                    )
                },
                recordsRequest: { _, _, _ in
                    NativeTabDataRecordList(
                        records: [],
                        total: 0,
                        matchedTotal: 0,
                        page: 1,
                        pageSize: 30,
                        metadata: nil
                    )
                },
                createRequest: { _ in invalidResponse }
            )

            await session.load()
            session.updateDraft(record: localRecord, field: field, value: .text("本地新记录"))

            let created = await session.create(record: localRecord)

            XCTAssertNil(created)
            XCTAssertEqual(session.saveState, .conflict)
            XCTAssertEqual(session.saveError, L10n.TabData.conflictMessage)
            XCTAssertFalse(session.canEdit)
            XCTAssertTrue(session.records.isEmpty)
            XCTAssertEqual(session.resumableCreationRecord()?.id, localRecord.id)
            XCTAssertEqual(
                store.load(
                    recordId: localRecord.id,
                    tableId: "table-1",
                    userId: "user-1",
                    organizationId: "org-1"
                )?.value(for: field),
                .text("本地新记录")
            )
        }
    }

    @MainActor
    func testCreateAndDeleteDenialsKeepDraftsWhenTableRemainsReadable() async throws {
        for operation in ["create", "delete"] {
            let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
            let store = NativeTabDataDraftStore(store: defaults)
            let field = try XCTUnwrap(decodeFields([
                fieldJSON(id: "title", name: "标题", type: "text", primary: true),
            ]).first)
            let remoteRecord = NativeTabDataRecord(
                id: "record-1",
                tableId: "table-1",
                fields: ["title": AnyCodable("远端标题")],
                version: 1
            )
            var metadataRequestCount = 0
            let session = NativeTabDataSession(
                tableId: "table-1",
                organizationId: "org-1",
                draftStore: store,
                userId: "user-1",
                sessionGeneration: 7,
                sessionIsCurrent: { true },
                metadataRequest: { _ in
                    metadataRequestCount += 1
                    return (
                        self.table(role: metadataRequestCount == 1 ? "editor" : "viewer"),
                        NativeTabDataFieldList(fields: [field]),
                        NativeTabDataViewList(views: [])
                    )
                },
                recordsRequest: { _, _, _ in
                    NativeTabDataRecordList(
                        records: [remoteRecord],
                        total: 1,
                        matchedTotal: 1,
                        page: 1,
                        pageSize: 30,
                        metadata: nil
                    )
                },
                createRequest: { _ in throw APIError.serverError(403, nil) },
                deleteRequest: { _ in throw APIError.serverError(403, nil) }
            )

            await session.load()
            if operation == "create" {
                let localRecord = NativeTabDataRecord(
                    id: "local-draft",
                    tableId: "table-1",
                    fields: [:],
                    version: 0
                )
                session.updateDraft(record: localRecord, field: field, value: .text("本地新记录"))
                let created = await session.create(record: localRecord)
                XCTAssertNil(created)
                XCTAssertEqual(session.resumableCreationRecord()?.id, localRecord.id)
                XCTAssertEqual(
                    store.load(
                        recordId: localRecord.id,
                        tableId: "table-1",
                        userId: "user-1",
                        organizationId: "org-1"
                    )?.value(for: field),
                    .text("本地新记录")
                )
            } else {
                session.updateDraft(record: remoteRecord, field: field, value: .text("删除前本地修改"))
                let deleted = await session.delete(record: remoteRecord)
                XCTAssertFalse(deleted)
                XCTAssertNotNil(session.record(id: remoteRecord.id))
                XCTAssertEqual(session.value(record: remoteRecord, field: field), .text("删除前本地修改"))
            }
            XCTAssertEqual(metadataRequestCount, 2)
            XCTAssertEqual(session.saveState, .conflict)
            XCTAssertFalse(session.canEdit)
        }
    }

    @MainActor
    func testReadDenialAfterWriteDenialPurgesTabDataDraftsAndProtectedContent() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("远端标题")],
            version: 1
        )
        var metadataRequestCount = 0
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                metadataRequestCount += 1
                guard metadataRequestCount == 1 else {
                    throw APIError.serverError(403, nil)
                }
                return (
                    self.table(role: "editor"),
                    NativeTabDataFieldList(fields: [field]),
                    NativeTabDataViewList(views: [])
                )
            },
            recordsRequest: { _, _, _ in
                NativeTabDataRecordList(
                    records: [record],
                    total: 1,
                    matchedTotal: 1,
                    page: 1,
                    pageSize: 30,
                    metadata: nil
                )
            },
            updateRequest: { _, _ in throw APIError.serverError(403, nil) }
        )

        await session.load()
        session.updateDraft(record: record, field: field, value: .text("本地敏感标题"))

        let saved = await session.save(record: record)

        XCTAssertFalse(saved)
        XCTAssertNil(session.table)
        XCTAssertTrue(session.fields.isEmpty)
        XCTAssertTrue(session.records.isEmpty)
        XCTAssertFalse(session.hasDirtyDrafts)
        XCTAssertEqual(session.saveState, .permissionDenied)
        XCTAssertFalse(store.hasDraft(tableId: "table-1", userId: "user-1", organizationId: "org-1"))
    }

    @MainActor
    func testTransientReadFailureAfterWriteDenialKeepsTabDataDraftLocked() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let store = NativeTabDataDraftStore(store: defaults)
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "title", name: "标题", type: "text", primary: true),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: ["title": AnyCodable("远端标题")],
            version: 1
        )
        var metadataRequestCount = 0
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: store,
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                metadataRequestCount += 1
                guard metadataRequestCount == 1 else {
                    throw APIError.networkError(URLError(.notConnectedToInternet))
                }
                return (
                    self.table(role: "editor"),
                    NativeTabDataFieldList(fields: [field]),
                    NativeTabDataViewList(views: [])
                )
            },
            recordsRequest: { _, _, _ in
                NativeTabDataRecordList(
                    records: [record],
                    total: 1,
                    matchedTotal: 1,
                    page: 1,
                    pageSize: 30,
                    metadata: nil
                )
            },
            updateRequest: { _, _ in throw APIError.serverError(403, nil) }
        )

        await session.load()
        session.updateDraft(record: record, field: field, value: .text("本地标题"))

        let saved = await session.save(record: record)

        XCTAssertFalse(saved)
        XCTAssertEqual(session.saveState, .conflict)
        XCTAssertFalse(session.canEdit)
        XCTAssertEqual(session.value(record: record, field: field), .text("本地标题"))
        XCTAssertTrue(store.hasDraft(tableId: "table-1", userId: "user-1", organizationId: "org-1"))
    }

    func testTabDataWriteDenialsRevalidateBeforeReadDenialsPurge() {
        XCTAssertTrue(NativeTabDataSaveFailurePolicy.requiresMetadataRevalidationAfterWriteFailure(
            APIError.serverError(403, nil)
        ))
        XCTAssertTrue(NativeTabDataSaveFailurePolicy.requiresMetadataRevalidationAfterWriteFailure(
            APIError.serverError(404, nil)
        ))
        XCTAssertFalse(NativeTabDataSaveFailurePolicy.requiresMetadataRevalidationAfterWriteFailure(
            APIError.serverError(409, nil)
        ))
        XCTAssertTrue(NativeTabDataSaveFailurePolicy.mustPurgeProtectedDataAfterReadFailure(
            APIError.serverError(403, nil)
        ))
        XCTAssertTrue(NativeTabDataSaveFailurePolicy.mustPurgeProtectedDataAfterReadFailure(
            APIError.serverError(404, nil)
        ))
        XCTAssertFalse(NativeTabDataSaveFailurePolicy.mustPurgeProtectedDataAfterReadFailure(
            APIError.networkError(URLError(.notConnectedToInternet))
        ))
    }

    /// 与 Android `TabDataNumberFormat`、Web `formatPercentCellValue` 同一组输入与期望。
    /// Web 依据：cellValueUtils.ts:65、mobileTablePrimitives.ts:127；
    /// 算法 `(ratio * 100).toFixed(2).replace(/\.?0+$/, '') + '%'`。
    func testPercentDisplayMatchesWebCanon() throws {
        let cases: [(String, String)] = [
            ("0.85", "85%"),
            ("0.12", "12%"),
            ("1", "100%"),
            ("0", "0%"),
            ("0.123", "12.3%"),
            ("0.1234", "12.34%"),
            ("0.12345", "12.35%"),
            ("0.1", "10%"),
            ("0.125", "12.5%"),
            ("1.5", "150%"),
            ("-0.25", "-25%"),
            ("0.001", "0.1%"),
            ("0.0001", "0.01%"),
            ("0.00001", "0%"),
            ("-0.00001", "-0%"),
            (" 0.85 ", "85%"),
        ]
        for (raw, expected) in cases {
            XCTAssertEqual(
                NativeTabDataNumberFormatPolicy.formatPercent(raw),
                expected,
                "input=\(raw)"
            )
        }
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercent(""))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercent("   "))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercent("n/a"))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercent("abc"))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercent("85%"))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercent("Infinity"))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercent("NaN"))
    }

    /// 详情编辑显示百分点数；用户不动则原样保留 stored raw，避免 85/100 浮点漂移。
    /// 与 Android `TabDataNumberFormatTest` 同一组输入与期望。
    func testPercentEditorCommitDoesNotDriftAndKeepsIntermediate() throws {
        let pointCases: [(String, String)] = [
            ("0.85", "85"),
            ("0.12", "12"),
            ("1", "100"),
            ("0", "0"),
            ("0.123", "12.3"),
            ("0.1234", "12.34"),
            ("0.12345", "12.35"),
            ("0.1", "10"),
            ("0.125", "12.5"),
            ("1.5", "150"),
            ("-0.25", "-25"),
            ("0.001", "0.1"),
            ("0.0001", "0.01"),
            ("0.00001", "0"),
            ("-0.00001", "-0"),
            (" 0.85 ", "85"),
        ]
        for (raw, expected) in pointCases {
            XCTAssertEqual(
                NativeTabDataNumberFormatPolicy.formatPercentEditorPoints(raw),
                expected,
                "input=\(raw)"
            )
        }
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercentEditorPoints(""))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatPercentEditorPoints("n/a"))

        let keepStored: [(String, String)] = [
            ("0.85", "85"),
            ("0.123", "12.3"),
            ("0.12345", "12.35"),
            ("0.12", "12"),
            ("1", "100"),
            ("0", "0"),
            ("-0.25", "-25"),
            ("0.123456", "12.35"),
        ]
        for (stored, points) in keepStored {
            XCTAssertEqual(
                NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: points, storedRatioRaw: stored),
                .ratio(stored),
                "unchanged \(stored)"
            )
        }
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: "85%", storedRatioRaw: "0.85"),
            .ratio("0.85")
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: " 85 ", storedRatioRaw: " 0.85 "),
            .ratio("0.85")
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: "90", storedRatioRaw: "0.85"),
            .ratio("0.9")
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: "85", storedRatioRaw: ""),
            .ratio("0.85")
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: "85%", storedRatioRaw: ""),
            .ratio("0.85")
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: "", storedRatioRaw: "0.85"),
            .empty
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: "   ", storedRatioRaw: "0.85"),
            .empty
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: "%", storedRatioRaw: "0.85"),
            .empty
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: ".5", storedRatioRaw: "0.85"),
            .ratio("0.005")
        )
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.parsePercentPointsToRatio("85"), 0.85)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.parsePercentPointsToRatio("85%"), 0.85)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.parsePercentPointsToRatio(" 85 "), 0.85)
        XCTAssertNil(NativeTabDataNumberFormatPolicy.parsePercentPointsToRatio(""))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.parsePercentPointsToRatio("   "))

        for typed in ["-", "+", ".", "-.", "+.", "8.", "12."] {
            XCTAssertEqual(
                NativeTabDataNumberFormatPolicy.commitPercentEditor(typed: typed, storedRatioRaw: "0.85"),
                .intermediate,
                "typed=\(typed)"
            )
            XCTAssertTrue(NativeTabDataNumberFormatPolicy.isPercentEditorIntermediate(typed), "typed=\(typed)")
        }
        XCTAssertFalse(NativeTabDataNumberFormatPolicy.isPercentEditorIntermediate(""))
        XCTAssertFalse(NativeTabDataNumberFormatPolicy.isPercentEditorIntermediate("85"))
        XCTAssertFalse(NativeTabDataNumberFormatPolicy.isPercentEditorIntermediate("8"))
    }

    /// 与 Android `TabDataNumberFormat`、Web grid `symbol + toFixed(precision)` 同一组输入。
    func testCurrencyMatchesWebGridFormatter() throws {
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.formatCurrency("12.3", symbol: "¥", precision: 2),
            "¥12.30"
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.formatCurrency("12.3", symbol: "$", precision: 1),
            "$12.3"
        )
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.formatCurrency("0", symbol: "€", precision: 2),
            "€0.00"
        )
        XCTAssertNil(NativeTabDataNumberFormatPolicy.formatCurrency("abc", symbol: "¥", precision: 2))
    }

    func testRatingClampsToIntegerRange() throws {
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.clampRating("0", max: 5), 0)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.clampRating("5", max: 5), 5)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.clampRating("9", max: 5), 5)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.clampRating("-1", max: 5), 0)
        XCTAssertNil(NativeTabDataNumberFormatPolicy.clampRating("1.5", max: 5))
        XCTAssertNil(NativeTabDataNumberFormatPolicy.clampRating("n/a", max: 5))
    }

    func testCurrencyAndRatingOptionsReadNumberAndString() throws {
        let dollar: [String: AnyCodable] = [
            "symbol": AnyCodable("$"),
            "precision": AnyCodable(1),
        ]
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.currencySymbol(dollar), "$")
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.currencyPrecision(dollar), 1)
        XCTAssertEqual(
            NativeTabDataNumberFormatPolicy.formatCurrency(
                "12.3",
                symbol: NativeTabDataNumberFormatPolicy.currencySymbol(dollar),
                precision: NativeTabDataNumberFormatPolicy.currencyPrecision(dollar)
            ),
            "$12.3"
        )
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.currencySymbol(["symbol": AnyCodable("")]), "¥")
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.currencySymbol(nil), "¥")
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.currencyPrecision(nil), 2)

        XCTAssertEqual(NativeTabDataNumberFormatPolicy.ratingMax(["max": AnyCodable("10")]), 10)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.ratingMax(["max": AnyCodable(10)]), 10)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.ratingMax(nil), 5)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.ratingMax([:]), 5)
        XCTAssertEqual(NativeTabDataNumberFormatPolicy.formatRatingStars("3", max: 5), "★★★☆☆")
    }

    /// 折叠行露出几个 chip 由可用宽度决定，不是写死「最多 3 个」。
    func testChoiceOverflowVisibleCountIsWidthDriven() {
        XCTAssertEqual(NativeTabDataChoiceOverflow.visibleCount(chipWidths: [40, 40, 40], overflowWidth: 20, spacing: 8, availableWidth: 200), 3)
        XCTAssertEqual(NativeTabDataChoiceOverflow.visibleCount(chipWidths: [80, 80, 80, 80], overflowWidth: 24, spacing: 8, availableWidth: 200), 2)
        XCTAssertEqual(NativeTabDataChoiceOverflow.visibleCount(chipWidths: [50, 50, 50], overflowWidth: 20, spacing: 4, availableWidth: 74), 1)
        XCTAssertEqual(NativeTabDataChoiceOverflow.visibleCount(chipWidths: [180], overflowWidth: 30, spacing: 8, availableWidth: 100), 0)
        XCTAssertEqual(NativeTabDataChoiceOverflow.visibleCount(chipWidths: [], overflowWidth: 20, spacing: 8, availableWidth: 200), 0)
        XCTAssertEqual(NativeTabDataChoiceOverflow.visibleCount(chipWidths: [10, 10, 10, 10], overflowWidth: 24, spacing: 4, availableWidth: 1000), 4)
    }

    /// 卡片摘要 percent 必须走 Web 正典，不能露出后端比值原文。
    func testCardSummaryFormatsPercentLikeWebCanon() throws {
        let fields = try decodeFields([
            fieldJSON(id: "fld-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "fld-progress", name: "完成度", type: "percent", order: 1),
        ])
        let progress = try XCTUnwrap(fields.first { $0.id == "fld-progress" })
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "fld-title": AnyCodable("回访"),
                "fld-progress": AnyCodable(0.85),
            ],
            version: 1
        )

        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: nil,
            untitledTitle: "Untitled record"
        )
        XCTAssertEqual(card.fields.first { $0.fieldId == "fld-progress" }?.value, "85%")
        XCTAssertEqual(
            progress.displayText(for: NativeTabDataValue.parse(AnyCodable(0.85), field: progress)),
            "85%"
        )
        XCTAssertEqual(
            progress.displayText(for: NativeTabDataValue.parse(AnyCodable("n/a"), field: progress)),
            "n/a"
        )
        XCTAssertEqual(
            progress.displayText(for: NativeTabDataValue.parse(nil, field: progress)),
            ""
        )
    }

    /// 卡片摘要 currency 必须带符号和精度，不能露出裸数字。
    func testCardSummaryFormatsCurrencyLikeWebGrid() throws {
        let fields = try decodeFields([
            fieldJSON(id: "fld-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "fld-amount", name: "金额", type: "currency", order: 1),
        ])
        let amount = try XCTUnwrap(fields.first { $0.id == "fld-amount" })
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "fld-title": AnyCodable("回访"),
                "fld-amount": AnyCodable(12.3),
            ],
            version: 1
        )
        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: nil,
            untitledTitle: "Untitled record"
        )
        XCTAssertEqual(card.fields.first { $0.fieldId == "fld-amount" }?.value, "¥12.30")
        XCTAssertEqual(
            amount.displayText(for: NativeTabDataValue.parse(AnyCodable(12.3), field: amount)),
            "¥12.30"
        )
    }

    /// 卡片摘要 rating 必须画星星，不能露出裸数字。
    func testCardSummaryFormatsRatingAsStars() throws {
        let fields = try decodeFields([
            fieldJSON(id: "fld-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(id: "fld-priority", name: "优先级", type: "rating", order: 1),
        ])
        let priority = try XCTUnwrap(fields.first { $0.id == "fld-priority" })
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "fld-title": AnyCodable("回访"),
                "fld-priority": AnyCodable(3),
            ],
            version: 1
        )
        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: nil,
            untitledTitle: "Untitled record"
        )
        XCTAssertEqual(card.fields.first { $0.fieldId == "fld-priority" }?.value, "★★★☆☆")
        XCTAssertEqual(
            priority.displayText(for: NativeTabDataValue.parse(AnyCodable(3), field: priority)),
            "★★★☆☆"
        )
    }

    func testCardSummaryHonorsCurrencyAndRatingOptions() throws {
        let fields = try decodeFields([
            fieldJSON(id: "fld-title", name: "标题", type: "text", primary: true, order: 0),
            fieldJSON(
                id: "fld-amount",
                name: "金额",
                type: "currency",
                order: 1,
                options: ["symbol": "$", "precision": 1]
            ),
            fieldJSON(
                id: "fld-priority",
                name: "优先级",
                type: "rating",
                order: 2,
                options: ["max": 10]
            ),
        ])
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "fld-title": AnyCodable("回访"),
                "fld-amount": AnyCodable(12.3),
                "fld-priority": AnyCodable(3),
            ],
            version: 1
        )
        let card = NativeTabDataCardProjection.make(
            record: record,
            fields: fields,
            view: nil,
            untitledTitle: "Untitled record"
        )
        XCTAssertEqual(card.fields.first { $0.fieldId == "fld-amount" }?.value, "$12.3")
        XCTAssertEqual(card.fields.first { $0.fieldId == "fld-priority" }?.value, "★★★☆☆☆☆☆☆☆")
    }

    func testMemberDirectoryResolverKeepsMultiSelectOrderAndSkipsEmptyUnknown() throws {
        let directory = NativeTabDataMemberDirectory(
            members: [
                NativeTabDataDirectoryMember(
                    userId: "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3",
                    displayName: "林小满",
                    avatarUrl: "https://oss.example.com/avatar/lin-xiaoman.png"
                )
            ],
            identitySnapshots: [
                NativeTabDataIdentitySnapshot(
                    userId: "a4c8f01d-3e92-4b76-8d15-6f2b7c9e4a83",
                    displayName: "周叙",
                    leftAt: "2026-05-01T00:00:00.000Z"
                )
            ]
        )
        let mixed: [Any] = [
            "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3",
            "a4c8f01d-3e92-4b76-8d15-6f2b7c9e4a83",
            ["id": "e91b7d3a-5f04-42c8-9e67-1a8d3b5c7f20", "name": "外部-赵珂"],
            "c05d8e27-4a16-4f93-b8c2-9d7e1f3a6b45"
        ]
        let resolved = NativeTabDataMemberDirectoryResolver.resolve(
            mixed,
            directory: directory,
            copy: .contract
        )
        XCTAssertEqual(resolved.map(\.kind), [.member, .departed, .external, .unknown])
        XCTAssertEqual(resolved.map(\.displayName), ["林小满", "周叙（已离职）", "外部-赵珂", "未知"])
        XCTAssertEqual(resolved[0].avatarUrl, "https://oss.example.com/avatar/lin-xiaoman.png")
        XCTAssertNil(resolved[1].avatarUrl)
        XCTAssertNil(resolved[2].avatarUrl)
        XCTAssertNil(resolved[3].avatarUrl)

        XCTAssertTrue(NativeTabDataMemberDirectoryResolver.resolve(nil, directory: directory).isEmpty)
        XCTAssertTrue(NativeTabDataMemberDirectoryResolver.resolve(NSNull(), directory: directory).isEmpty)
        XCTAssertTrue(NativeTabDataMemberDirectoryResolver.resolve("", directory: directory).isEmpty)
        XCTAssertTrue(NativeTabDataMemberDirectoryResolver.resolve([Any](), directory: directory).isEmpty)
        XCTAssertEqual(
            NativeTabDataMemberDirectoryResolver.resolve(nil, directory: directory).map(\.displayName),
            []
        )
    }

    func testMemberDirectoryResolverPrefersDirectoryNameOverEmbeddedStaleName() throws {
        let directory = NativeTabDataMemberDirectory(
            members: [
                NativeTabDataDirectoryMember(
                    userId: "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3",
                    displayName: "林小满",
                    avatarUrl: "https://oss.example.com/avatar/lin-xiaoman.png"
                )
            ],
            identitySnapshots: [
                NativeTabDataIdentitySnapshot(
                    userId: "a4c8f01d-3e92-4b76-8d15-6f2b7c9e4a83",
                    displayName: "周叙",
                    leftAt: nil
                )
            ]
        )
        let member = NativeTabDataMemberDirectoryResolver.resolve(
            ["id": "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3", "name": "林小满-导入时旧名"],
            directory: directory,
            copy: .contract
        )
        XCTAssertEqual(member.map(\.kind), [.member])
        XCTAssertEqual(member.map(\.displayName), ["林小满"])
        XCTAssertEqual(member.first?.avatarUrl, "https://oss.example.com/avatar/lin-xiaoman.png")

        let departed = NativeTabDataMemberDirectoryResolver.resolve(
            ["id": "a4c8f01d-3e92-4b76-8d15-6f2b7c9e4a83", "name": "周叙-导入时旧名"],
            directory: directory,
            copy: .contract
        )
        XCTAssertEqual(departed.map(\.kind), [.departed])
        XCTAssertEqual(departed.map(\.displayName), ["周叙（已离职）"])
    }

    func testMemberDirectoryResolverDoesNotTreatIdOnlyObjectAsExternal() throws {
        let directory = NativeTabDataMemberDirectory.empty
        let resolved = NativeTabDataMemberDirectoryResolver.resolve(
            ["id": "c05d8e27-4a16-4f93-b8c2-9d7e1f3a6b45"],
            directory: directory,
            copy: .contract
        )
        XCTAssertEqual(resolved.map(\.kind), [.unknown])
        XCTAssertEqual(resolved.map(\.displayName), ["未知"])
        XCTAssertFalse(resolved[0].displayName.contains("c05d8e27"))
    }

    func testMemberDirectoryBatchingDeduplicatesAndChunksAt200() {
        var ids = (0..<250).map { "user-\($0)" }
        ids.append("user-1")
        ids.append(" user-2 ")
        ids.append("")
        let chunks = NativeTabDataMemberDirectoryBatching.uniquedChunks(ids)
        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks[0].count, 200)
        XCTAssertEqual(chunks[1].count, 50)
        XCTAssertEqual(chunks[0][0], "user-0")
        XCTAssertEqual(chunks[0][1], "user-1")
        XCTAssertEqual(Set(chunks.flatMap { $0 }).count, 250)
        XCTAssertEqual(
            NativeTabDataMemberDirectoryBatching.uniquedChunks(["a", "a", "b", "b"]),
            [["a", "b"]]
        )
        XCTAssertTrue(NativeTabDataMemberDirectoryBatching.uniquedChunks([]).isEmpty)
    }

    func testQueryCodecProducesValidFilterAndOffsetJSON() throws {
        let filter = NativeTabDataFilterRule(fieldId: "field-1", operatorName: "contains", value: "关键字")
        let filterJSON = try XCTUnwrap(NativeTabDataQueryCodec.json([filter.jsonObject]))
        let filterData = try XCTUnwrap(filterJSON.data(using: .utf8))
        let decodedFilters = try XCTUnwrap(JSONSerialization.jsonObject(with: filterData) as? [[String: Any]])
        XCTAssertEqual(decodedFilters.first?["field_id"] as? String, "field-1")
        XCTAssertEqual(decodedFilters.first?["enabled"] as? Bool, true)

        let offsetJSON = try XCTUnwrap(NativeTabDataQueryCodec.json(["todo": 40]))
        let offsetData = try XCTUnwrap(offsetJSON.data(using: .utf8))
        XCTAssertEqual((try JSONSerialization.jsonObject(with: offsetData) as? [String: Int])?["todo"], 40)
    }

    /// 与 Web `resolveSelectChipColors`、Android `TabDataChoiceColors` 同一组输入与期望。
    /// Web 依据：`packages/smartsheet-ui/src/utils/choice-colors.ts`；hash 必须落到同一预设色。
    func testChoiceColorsMatchWebCanon() {
        let cases: [(color: String?, value: String, background: String, foreground: String)] = [
            ("gray", "待处理", "#808080", "#FFFFFF"),
            ("blueBright", "进行中", "#007BFF", "#FFFFFF"),
            ("purpleLight2", "aaa", "#E5CCFF", "#000000"),
            ("yellowLight2", "light", "#FFF3BF", "#000000"),
            ("red", "dark", "#D90A19", "#FFFFFF"),
            ("#ED8936", "5327-live-opt-A", "#ED8936", "#000000"),
            ("#ed8936", "x", "#ED8936", "#000000"),
            ("#abc", "x", "#AABBCC", "#000000"),
            ("#ABC", "x", "#AABBCC", "#000000"),
            ("  #00ff00  ", "x", "#00FF00", "#FFFFFF"),
            ("#FFFFFF", "w", "#FFFFFF", "#000000"),
            ("#000000", "b", "#000000", "#FFFFFF"),
            ("#808080", "g", "#808080", "#FFFFFF"),
            (nil, "untitled", "#FFD43B", "#000000"),
            ("", "untitled", "#FFD43B", "#000000"),
            ("not-a-color", "untitled", "#FFD43B", "#000000"),
            (nil, "P1", "#FA8000", "#FFFFFF"),
            (nil, "Done", "#0066CC", "#FFFFFF"),
            (nil, "高优先级", "#F15646", "#FFFFFF"),
        ]
        for item in cases {
            let resolved = NativeTabDataChoiceColorPolicy.resolveHex(color: item.color, value: item.value)
            XCTAssertEqual(resolved.background, item.background, "bg color=\(item.color ?? "nil") value=\(item.value)")
            XCTAssertEqual(resolved.foreground, item.foreground, "fg color=\(item.color ?? "nil") value=\(item.value)")
        }
        XCTAssertEqual(NativeTabDataChoiceColorPolicy.normalizeHexColor("#abc"), "#AABBCC")
        XCTAssertEqual(NativeTabDataChoiceColorPolicy.normalizeHexColor("#Ed8936"), "#ED8936")
        XCTAssertEqual(NativeTabDataChoiceColorPolicy.stableHash("untitled"), 13_050_085)
        XCTAssertEqual(NativeTabDataChoiceColorPolicy.stableHash("P1"), 2529)
        XCTAssertTrue(NativeTabDataChoiceColorPolicy.isLightHexColor("#ED8936"))
        XCTAssertFalse(NativeTabDataChoiceColorPolicy.isLightHexColor("#808080"))
        XCTAssertTrue(NativeTabDataChoiceColorPolicy.isLightHexColor("#FFF3BF"))
        XCTAssertFalse(NativeTabDataChoiceColorPolicy.isLightHexColor("#D90A19"))
    }

    private func decode<T: Decodable>(_ object: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func decodeViews(_ objects: [[String: Any]]) throws -> [NativeTabDataView] {
        try objects.map { try decode($0) }
    }

    private func decodeView(_ object: [String: Any]) throws -> NativeTabDataView {
        try decode(object)
    }

    private func prefillFields() throws -> [NativeTabDataField] {
        try decodeFields([
            fieldJSON(id: "fld-status", name: "状态", type: "select"),
            fieldJSON(id: "fld-owner", name: "负责人", type: "user"),
            fieldJSON(id: "fld-due", name: "截止日期", type: "date"),
            fieldJSON(id: "fld-progress", name: "进度", type: "percent"),
            fieldJSON(id: "fld-done", name: "已验收", type: "checkbox"),
            fieldJSON(id: "fld-priority", name: "优先级", type: "rating"),
            fieldJSON(id: "fld-tags", name: "标签", type: "multi_select"),
            fieldJSON(id: "fld-title", name: "任务名称", type: "text"),
            fieldJSON(id: "fld-project", name: "所属项目", type: "link"),
            fieldJSON(id: "fld-spec", name: "需求文档", type: "attachment"),
        ])
    }

    private func filterJSON(
        _ fieldId: String,
        _ operatorName: String,
        _ value: Any,
        enabled: Bool? = true
    ) -> [String: Any] {
        var result: [String: Any] = [
            "field_id": fieldId,
            "operator": operatorName,
            "value": value,
        ]
        if let enabled { result["enabled"] = enabled }
        return result
    }

    private func groupJSON(_ fieldId: String) -> [String: Any] {
        ["field_id": fieldId]
    }

    private func sameJSONValue(_ left: Any?, _ right: Any?) -> Bool {
        if left == nil || left is NSNull {
            return right == nil || right is NSNull
        }
        if right == nil || right is NSNull {
            return false
        }
        guard
            JSONSerialization.isValidJSONObject(left!),
            JSONSerialization.isValidJSONObject(right!),
            let leftData = try? JSONSerialization.data(withJSONObject: left!, options: [.sortedKeys]),
            let rightData = try? JSONSerialization.data(withJSONObject: right!, options: [.sortedKeys])
        else {
            return false
        }
        return leftData == rightData
    }

    /// user 多选看 options.multiple 或顶层 isMultipleCellValue，缺省为单选。
    func testUserFieldMultipleFollowsOptionsAndIsMultipleCellValue() throws {
        let single = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-owner", name: "负责人", type: "user"),
        ]).first)
        let fromOptions = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-reviewers", name: "评审人", type: "user", options: ["multiple": true]),
        ]).first)
        let fromFlag = try XCTUnwrap(decodeFields([
            fieldJSON(
                id: "fld-watchers",
                name: "关注人",
                type: "user",
                isMultipleCellValue: true
            ),
        ]).first)
        XCTAssertFalse(single.allowsMultipleUsers)
        XCTAssertTrue(fromOptions.allowsMultipleUsers)
        XCTAssertTrue(fromFlag.allowsMultipleUsers)
        XCTAssertFalse(try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-creator", name: "创建人", type: "created_by", options: ["multiple": true]),
        ]).first).allowsMultipleUsers)
    }

    func testUserFieldParseAndWireMatchesWebEditorContract() throws {
        let single = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-owner", name: "负责人", type: "user"),
        ]).first)
        let multiple = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-reviewers", name: "评审人", type: "user", options: ["multiple": true]),
        ]).first)
        let record = NativeTabDataRecord(
            id: "record-1",
            tableId: "table-1",
            fields: [
                "fld-owner": AnyCodable("usr-old"),
                "fld-reviewers": AnyCodable(["usr-a"]),
            ],
            version: 1
        )
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [single, multiple]
        )

        XCTAssertEqual(
            NativeTabDataValue.parse(AnyCodable("usr-0001"), field: single),
            .selections(["usr-0001"])
        )
        XCTAssertEqual(
            NativeTabDataValue.parse(AnyCodable(["usr-0001", "usr-0002"]), field: multiple),
            .selections(["usr-0001", "usr-0002"])
        )
        XCTAssertEqual(
            NativeTabDataValue.parse(
                AnyCodable(["id": "usr-0001", "name": "林小满"]),
                field: single
            ),
            .selections(["usr-0001"])
        )
        XCTAssertEqual(
            NativeTabDataValue.parse(AnyCodable(["usr-0001", "usr-0002"]), field: single),
            .selections(["usr-0001"])
        )

        draft.set(.selections(["usr-0001"]), for: single)
        draft.set(.selections(["usr-0001", "usr-0002"]), for: multiple)
        let changed = try XCTUnwrap(draft.updateBody()["fields"] as? [String: Any])
        XCTAssertEqual(changed["fld-owner"] as? String, "usr-0001")
        XCTAssertEqual(changed["fld-reviewers"] as? [String], ["usr-0001", "usr-0002"])

        draft.set(.selections([]), for: single)
        draft.set(.selections([]), for: multiple)
        let cleared = try XCTUnwrap(draft.updateBody()["fields"] as? [String: Any])
        XCTAssertTrue(cleared["fld-owner"] is NSNull)
        XCTAssertTrue(cleared["fld-reviewers"] is NSNull)
    }

    func testMemberPickerSearchQueryUsesServerSearchAndClampsLimit() {
        XCTAssertEqual(
            NativeTabDataMemberPickerPolicy.searchQuery(search: "  林  ", offset: 20, limit: 500),
            ["search": "林", "search_mode": "nickname", "offset": "20", "limit": "200"]
        )
        XCTAssertEqual(
            NativeTabDataMemberPickerPolicy.searchQuery(search: "   ", offset: -3),
            ["offset": "0", "limit": "50"]
        )
        XCTAssertNil(NativeTabDataMemberPickerPolicy.searchQuery(search: "").keys.first { $0 == "search_mode" })
    }

    func testMemberPickerToggleRespectsSingleAndMultiple() {
        XCTAssertEqual(
            NativeTabDataMemberPickerPolicy.toggle(selected: ["a"], userId: "b", multiple: false),
            ["b"]
        )
        XCTAssertEqual(
            NativeTabDataMemberPickerPolicy.toggle(selected: ["b"], userId: "b", multiple: false),
            []
        )
        XCTAssertEqual(
            NativeTabDataMemberPickerPolicy.toggle(selected: ["a"], userId: "b", multiple: true),
            ["a", "b"]
        )
        XCTAssertEqual(
            NativeTabDataMemberPickerPolicy.toggle(selected: ["a", "b"], userId: "a", multiple: true),
            ["b"]
        )
    }

    /// 选择器列表只有在职成员时，已选离职 id 仍走快照，不能退化成「未知」或裸 id。
    func testSelectedDepartedMemberChipUsesSnapshotNotPickerList() {
        let departedId = "a4c8f01d-3e92-4b76-8d15-6f2b7c9e4a83"
        let directory = NativeTabDataMemberDirectory(
            members: [
                NativeTabDataDirectoryMember(
                    userId: "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3",
                    displayName: "林小满",
                    avatarUrl: nil
                )
            ],
            identitySnapshots: [
                NativeTabDataIdentitySnapshot(
                    userId: departedId,
                    displayName: "周叙",
                    leftAt: "2026-05-01T00:00:00.000Z"
                )
            ]
        )
        let resolved = NativeTabDataMemberPickerPolicy.resolveSelected(
            ids: [departedId],
            directory: directory,
            copy: .contract
        )
        XCTAssertEqual(resolved.map(\.kind), [.departed])
        XCTAssertEqual(resolved.map(\.displayName), ["周叙（已离职）"])
        XCTAssertFalse(resolved[0].displayName.contains(departedId))
        XCTAssertEqual(
            NativeTabDataMemberPickerPolicy.directoryMember(
                from: OrganizationMember(
                    id: "mem-1",
                    userId: "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3",
                    role: .editor,
                    joinedAt: nil,
                    user: MemberUser(
                        id: "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3",
                        nickname: "林小满",
                        username: "lin",
                        email: nil,
                        phone: nil,
                        avatar: "https://oss.example.com/a.png"
                    )
                )
            )?.displayName,
            "林小满"
        )
    }

    /// 昵称、用户名都为空的在职成员不能被目录丢弃：丢了就在选择器里搜不到、派不了活。
    func testUnnamedMemberStaysSelectableWithPlaceholderInsteadOfRawId() throws {
        let userId = "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3"
        let resolved = NativeTabDataMemberPickerPolicy.directoryMember(
            from: OrganizationMember(
                id: "mem-unnamed",
                userId: userId,
                role: .editor,
                joinedAt: nil,
                user: MemberUser(
                    id: userId,
                    nickname: "",
                    username: "",
                    email: nil,
                    phone: nil,
                    avatar: nil
                )
            ),
            copy: .contract
        )
        let member = try XCTUnwrap(resolved)
        XCTAssertEqual(member.userId, userId)
        XCTAssertEqual(member.displayName, "未命名成员")
        XCTAssertFalse(member.displayName.contains(userId))
    }

    /// `OrganizationMember.displayName` 的回落链里有手机号和邮箱，人员字段不能跟着用：
    /// 那会把联系方式当成称呼显示在表格和选择器里。
    func testMemberDirectoryNeverFallsBackToPhoneOrEmail() throws {
        let userId = "7c1e5b90-2d34-4f8a-b6c2-90ae3f1d5482"
        let phone = "13800138000"
        let email = "someone@example.com"
        let member = try XCTUnwrap(NativeTabDataMemberPickerPolicy.directoryMember(
            from: OrganizationMember(
                id: "mem-contact-only",
                userId: userId,
                role: .editor,
                joinedAt: nil,
                user: MemberUser(
                    id: userId,
                    nickname: nil,
                    username: nil,
                    email: email,
                    phone: phone,
                    avatar: nil
                )
            ),
            copy: .contract
        ))
        XCTAssertEqual(member.displayName, "未命名成员")
        XCTAssertFalse(member.displayName.contains(phone))
        XCTAssertFalse(member.displayName.contains(email))
    }

    func testPrefillOrFilterLogicSkipsTheEntireFiltersBranch() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [
                    filterJSON("fld-status", "is", "doing"),
                    filterJSON("fld-owner", "equals", "usr-0001"),
                ],
                groups: [groupJSON("fld-tags")],
                config: ["filter_logic": "or"]
            )
        )
        let actual = NativeTabDataPrefillPolicy.resolve(
            currentView: view,
            fields: try prefillFields(),
            groupValues: ["标签": "urgent"]
        )
        XCTAssertTrue(sameJSONValue(actual, ["标签": "urgent"]))
        XCTAssertNil(actual?["状态"], "状态出现即仍处理了筛选段")
        XCTAssertNil(actual?["负责人"])
    }

    func testPrefillMissingEnabledIsTreatedAsEnabledAndFalseIsSkipped() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [
                    filterJSON("fld-done", "is", true, enabled: nil),
                    filterJSON("fld-priority", "equals", 5, enabled: false),
                ]
            )
        )
        let actual = NativeTabDataPrefillPolicy.resolve(currentView: view, fields: try prefillFields())
        XCTAssertEqual(actual?["已验收"] as? Bool, true)
        XCTAssertNil(actual?["优先级"], "优先级=5 被禁用，出现即没跳过")
    }

    func testPrefillOperatorsAreCaseInsensitiveAndTrimmed() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [
                    filterJSON("fld-due", "IS", "2026-08-20"),
                    filterJSON("fld-tags", "  IS_ANY_OF  ", ["urgent"]),
                ]
            )
        )
        let actual = NativeTabDataPrefillPolicy.resolve(currentView: view, fields: try prefillFields())
        XCTAssertEqual(actual?["截止日期"] as? String, "2026-08-20")
        XCTAssertEqual(actual?["标签"] as? String, "urgent")
    }

    func testPrefillFieldLookupFallsBackFromIdToName() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [filterJSON("进度", "equals", 0.4)]
            )
        )
        let actual = NativeTabDataPrefillPolicy.resolve(currentView: view, fields: try prefillFields())
        XCTAssertEqual(actual?["进度"] as? Double, 0.4)
        XCTAssertNil(actual?["fld-progress"], "结果 key 必须是字段名")
        XCTAssertNil(actual?["fld-status"])
    }

    func testPrefillConflictingFiltersClearTheEntireFiltersResult() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [
                    filterJSON("fld-status", "is", "doing"),
                    filterJSON("fld-owner", "equals", "usr-0001"),
                    filterJSON("fld-status", "is", "todo"),
                ],
                groups: [groupJSON("fld-status")]
            )
        )
        let actual = NativeTabDataPrefillPolicy.resolve(
            currentView: view,
            fields: try prefillFields(),
            groupValues: ["状态": "done"]
        )
        XCTAssertTrue(sameJSONValue(actual, ["状态": "done"]))
        XCTAssertNil(actual?["负责人"], "负责人若还在，就是只清了冲突字段")
    }

    func testPrefillGroupsOverlayFiltersUsingFieldNamesAndSkipEmptyValues() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [filterJSON("fld-status", "is", "doing")],
                groups: [groupJSON("fld-status")]
            )
        )
        let fields = try prefillFields()
        let overlay = NativeTabDataPrefillPolicy.resolve(
            currentView: view,
            fields: fields,
            groupValues: ["状态": "todo", "优先级": 3]
        )
        XCTAssertEqual(overlay?["状态"] as? String, "todo")

        let emptyKeepsFilter = NativeTabDataPrefillPolicy.resolve(
            currentView: view,
            fields: fields,
            groupValues: ["状态": ""]
        )
        XCTAssertEqual(emptyKeepsFilter?["状态"] as? String, "doing")
    }

    func testPrefillResultKeysAreFieldNamesAndEmptyResultIsNil() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [filterJSON("fld-status", "is", "doing")]
            )
        )
        let fields = try prefillFields()
        let actual = NativeTabDataPrefillPolicy.resolve(currentView: view, fields: fields)
        XCTAssertEqual(Set((actual ?? [:]).keys), ["状态"])
        XCTAssertNil(actual?["fld-status"])
        let empty = try decodeView(viewJSON(id: "view-1", name: "主视图"))
        XCTAssertNil(NativeTabDataPrefillPolicy.resolve(currentView: empty, fields: fields))
    }

    func testPrefillDoesNotReadNestedFilterSetConfigFiltersOrFilterGroups() throws {
        let trapConfig: [String: Any] = [
            "filter_logic": "and",
            "filters": [
                "conjunction": "and",
                "conditions": [[
                    "field": "fld-status",
                    "operator": "is",
                    "value": "todo",
                ]],
            ],
            "groups": [groupJSON("fld-priority")],
            "filter_groups": [
                "conjunction": "and",
                "groups": [[
                    "conjunction": "and",
                    "conditions": [[
                        "field": "fld-tags",
                        "operator": "is",
                        "value": "review",
                    ]],
                ]],
            ],
        ]
        var payload = viewJSON(
            id: "view-1",
            name: "主视图",
            filters: [filterJSON("fld-status", "is", "doing")],
            groups: [groupJSON("fld-status")],
            config: trapConfig
        )
        payload["filter"] = [
            "conjunction": "and",
            "filterSet": [[
                "field_id": "fld-title",
                "operator": "equals",
                "value": "TRAP-FROM-NESTED-FILTER",
            ]],
        ]
        let view = try decodeView(payload)
        let actual = NativeTabDataPrefillPolicy.resolve(
            currentView: view,
            fields: try prefillFields(),
            groupValues: ["优先级": 3]
        )
        XCTAssertEqual(actual?["状态"] as? String, "doing")
        XCTAssertNil(actual?["任务名称"], "读了顶层 filter 就会多出任务名称")
        XCTAssertNil(actual?["优先级"], "读了 config.groups 才会写入优先级")
        XCTAssertNil(actual?["标签"], "读了 filter_groups 会写入标签")
    }

    func testPrefillSingleElementArrayOperatorsUnwrapAndMultiElementIsSkipped() throws {
        let fields = try prefillFields()
        let single = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [
                    filterJSON("fld-tags", "is_any_of", ["urgent"]),
                    filterJSON("fld-status", "in", ["doing"]),
                ]
            )
        )
        let unwrapped = NativeTabDataPrefillPolicy.resolve(currentView: single, fields: fields)
        XCTAssertEqual(unwrapped?["标签"] as? String, "urgent")
        XCTAssertEqual(unwrapped?["状态"] as? String, "doing")

        let multi = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [
                    filterJSON("fld-tags", "is_any_of", ["urgent", "review"]),
                    filterJSON("fld-owner", "equals", "usr-0001"),
                ]
            )
        )
        let skipped = NativeTabDataPrefillPolicy.resolve(currentView: multi, fields: fields)
        XCTAssertNil(skipped?["标签"])
        XCTAssertEqual(skipped?["负责人"] as? String, "usr-0001")
    }

    func testPrefillCreateTimeWritableSpecialsAreKeptEvenWhenMobileUIIsReadonly() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                filters: [
                    filterJSON("fld-score", "equals", "1.6"),
                    filterJSON("fld-project", "equals", ["rec-1001"]),
                    filterJSON("fld-spec", "equals", "file-a-0001"),
                ]
            )
        )
        let actual = NativeTabDataPrefillPolicy.resolve(currentView: view, fields: try prefillFields())
        XCTAssertNil(actual?["综合得分"])
        XCTAssertEqual(actual?["所属项目"] as? [String], ["rec-1001"])
        XCTAssertEqual(actual?["需求文档"] as? String, "file-a-0001")
    }

    func testPrefillKanbanGroupValuesUseTheGroupingFieldName() throws {
        let view = try decodeView(
            viewJSON(
                id: "view-1",
                name: "主视图",
                groups: [groupJSON("fld-owner")]
            )
        )
        let fields = try prefillFields()
        let values = NativeTabDataPrefillPolicy.groupValues(
            from: view,
            fields: fields,
            group: NativeTabDataRecordGroup(groupValue: "usr-0001", groupLabel: "林小满")
        )
        XCTAssertTrue(sameJSONValue(values, ["负责人": "usr-0001"]))
        XCTAssertEqual(
            NativeTabDataPrefillPolicy.resolve(currentView: view, fields: fields, groupValues: values)?["负责人"] as? String,
            "usr-0001"
        )
    }

    func testPrefillDraftCoversSeededValuesAndKeepsReadonlyWireShape() throws {
        let fields = try prefillFields()
        let record = NativeTabDataRecord(id: "draft-1", tableId: "table-1", fields: [:], version: 0)
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: fields
        )
        let status = try XCTUnwrap(fields.first { $0.id == "fld-status" })
        let project = try XCTUnwrap(fields.first { $0.id == "fld-project" })
        XCTAssertTrue(draft.covers(status), "init 会给可编辑字段建空键")
        XCTAssertEqual(draft.value(for: status), .selections([]))

        draft.seedPrefill(
            [
                "状态": "doing",
                "所属项目": ["rec-1001"],
                "需求文档": "file-a-0001",
            ],
            fields: fields
        )
        XCTAssertTrue(draft.covers(status))
        XCTAssertEqual(draft.value(for: status), .selections(["doing"]))
        XCTAssertFalse(draft.covers(project), "关联记录不进 values，避免 covers 把远端回落吃掉")
        let body = draft.createBody()["fields"] as? [String: Any]
        XCTAssertEqual(body?["fld-status"] as? String, "doing")
        XCTAssertEqual(body?["fld-project"] as? [String], ["rec-1001"])
        XCTAssertEqual(body?["fld-spec"] as? String, "file-a-0001")
    }

    @MainActor
    func testBeginCreationSeedsPrefillAndDoesNotOverwriteExistingDraft() async throws {
        let fields = try prefillFields()
        let views = try decodeViews([
            viewJSON(
                id: "view-1",
                name: "进行中",
                filters: [filterJSON("fld-status", "is", "doing")]
            ),
        ])
        let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
        let session = NativeTabDataSession(
            tableId: "table-1",
            organizationId: "org-1",
            draftStore: NativeTabDataDraftStore(store: defaults),
            userId: "user-1",
            sessionGeneration: 7,
            sessionIsCurrent: { true },
            metadataRequest: { _ in
                (
                    self.table(role: "editor"),
                    NativeTabDataFieldList(fields: fields),
                    NativeTabDataViewList(views: views)
                )
            },
            recordsRequest: { _, _, _ in .empty }
        )
        await session.load()

        let created = session.beginCreation()
        let status = try XCTUnwrap(fields.first { $0.id == "fld-status" })
        XCTAssertEqual(session.value(record: created, field: status), .selections(["doing"]))
        XCTAssertTrue(session.draft(for: created).covers(status))
        XCTAssertEqual(session.draft(for: created).canSubmit, true)

        session.updateDraft(record: created, field: status, value: .selections(["todo"]))
        let resumed = session.beginCreation()
        XCTAssertEqual(resumed.id, created.id)
        XCTAssertEqual(session.value(record: resumed, field: status), .selections(["todo"]))
    }

    func testUserDraftSnapshotResolvesNamesInsteadOfRawIds() throws {
        let field = try XCTUnwrap(decodeFields([
            fieldJSON(id: "fld-owner", name: "负责人", type: "user"),
        ]).first)
        let record = NativeTabDataRecord(id: "record-1", tableId: "table-1", fields: [:], version: 1)
        var draft = NativeTabDataRecordDraft(
            record: record,
            tableId: "table-1",
            organizationId: "org-1",
            fields: [field]
        )
        draft.set(.selections(["3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3"]), for: field)
        let directory = NativeTabDataMemberDirectory(
            members: [
                NativeTabDataDirectoryMember(
                    userId: "3f2a9c14-8b7d-4e51-9a06-1c5d2e8f47b3",
                    displayName: "林小满",
                    avatarUrl: nil
                )
            ],
            identitySnapshots: []
        )
        let snapshot = draft.readOnlySnapshot(fields: [field], directory: directory)
        XCTAssertEqual(snapshot.fields.first?.value, "林小满")
        XCTAssertFalse(snapshot.copyText.contains("3f2a9c14"))
    }

    private func decodeFields(_ objects: [[String: Any]]) throws -> [NativeTabDataField] {
        try objects.map { try decode($0) }
    }

    private func table(role: String, organizationId: String = "org-1") -> NativeTabDataTable {
        NativeTabDataTable(
            id: "table-1",
            name: "移动端表格",
            organizationId: organizationId,
            defaultViewId: nil,
            currentUserRole: role
        )
    }

    private func viewJSON(
        id: String,
        name: String,
        type: String = "grid",
        order: Int = 0,
        isLocked: Bool = false,
        filters: [[String: Any]] = [],
        groups: [[String: Any]] = [],
        config: [String: Any] = [:]
    ) -> [String: Any] {
        [
            "id": id,
            "name": name,
            "view_type": type,
            "order": order,
            "filters": filters,
            "sorts": [],
            "groups": groups,
            "config": config,
            "visible_fields": [],
            "field_order": [],
            "column_meta": [:],
            "is_locked": isLocked,
        ]
    }

    private func fieldJSON(
        id: String,
        name: String,
        type: String,
        primary: Bool = false,
        order: Int = 0,
        options: [String: Any]? = nil,
        isMultipleCellValue: Bool? = nil
    ) -> [String: Any] {
        var result: [String: Any] = [
            "id": id,
            "name": name,
            "field_type": type,
            "is_primary": primary,
            "is_hidden": false,
            "order": order,
        ]
        if let options { result["options"] = options }
        if let isMultipleCellValue { result["isMultipleCellValue"] = isMultipleCellValue }
        return result
    }
}
