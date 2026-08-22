import XCTest
@testable import Tabtin

final class NativeTabDataContractFixtureTests: XCTestCase {
    func testFixtureFieldsAndAliasesMatchDeclaredIOSCurrent() throws {
        let table = try loadTable()
        let contract = try loadContract()
        let fields = try table.fields()
        XCTAssertEqual(Set(fields.map(\.fieldType.rawValue)).count, 27, "夹具必须覆盖 27 个字段类型")

        let declared = try contract.fieldCurrent(platform: "ios")
        let actualEditable = Set(fields.filter(\.fieldType.isEditable).map(\.fieldType.rawValue))
        let actualReadonly = Set(fields.filter { !$0.fieldType.isEditable }.map(\.fieldType.rawValue))
        XCTAssertEqual(declared.editable, actualEditable, "iOS 可编辑字段集合发生漂移")
        XCTAssertEqual(declared.readonly, actualReadonly, "iOS 只读字段集合发生漂移")

        let aliasCases = try table.aliasCases()
        XCTAssertEqual(aliasCases.count, 15, "别名用例必须与 field.ts 的 14 条加未知透传一致")
        let declaredAliases = try XCTUnwrap(
            ((contract["aliasNormalization"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: String]
        )
        for alias in aliasCases {
            let input = try XCTUnwrap(alias["input"] as? String)
            let actual = NativeTabDataFieldKind.normalize(input)
            XCTAssertEqual(declaredAliases[input], actual, "iOS 别名归一化发生漂移：\(input)")
            let decoded: NativeTabDataField = try decode([
                "id": "probe",
                "name": "probe",
                "field_type": input,
                "is_primary": false,
                "is_hidden": false,
                "order": 0,
            ])
            if NativeTabDataFieldKind(rawValue: actual) != nil {
                XCTAssertEqual(decoded.fieldType.rawValue, actual, "decode 必须服从同一别名表：\(input)")
            } else {
                XCTAssertEqual(decoded.fieldType, .unknown)
            }
        }
    }

    func testCardProjectionSurfaceFilterSortAndLeaksMatchDeclaredIOSCurrent() throws {
        let table = try loadTable()
        let contract = try loadContract()
        let fields = try table.fields()
        let view = try table.view(id: "viw-grid-0001")
        let records = try table.records()
        let first = try XCTUnwrap(records.first { $0.id == "rec-0001" })
        let card = NativeTabDataCardProjection.make(
            record: first,
            fields: fields,
            view: view,
            untitledTitle: "未命名记录"
        )
        let declaredCard = try XCTUnwrap(
            ((contract["cardProjection"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: Any]
        )

        XCTAssertEqual(card.title, "修复 Android 上下标丢失")
        XCTAssertEqual(declaredCard["titleField"] as? String, "fld-title")
        XCTAssertEqual(declaredCard["coverField"] as? String, "fld-cover")
        let declaredRecords = (contract["cardProjection"] as? [String: Any])?["records"] as? [[String: Any]] ?? []
        let declaredFirst = declaredRecords.first { $0["id"] as? String == "rec-0001" }
        XCTAssertEqual(card.coverUrl, declaredFirst?["coverUrl"] as? String)
        XCTAssertEqual(card.fields.count, 4)
        // 分组字段照常进摘要：Web 正典只排除标题与封面（ 裁定）。本夹具对这条无鉴别力，
        // 分组字段排在前 4 射程之外，真正驱动这条的是
        // NativeTabDataTests.testCardSummaryKeepsGroupFieldLikeWebCanon（见 ）。
        XCTAssertEqual(declaredCard["excludesGroupField"] as? Bool, false)
        XCTAssertEqual(declaredCard["excludesCoverField"] as? Bool, true)
        XCTAssertEqual(card.fields.map(\.fieldId), declaredCard["bodyFields"] as? [String])
        // 摘要跳过空值是经裁定保留的有意偏离，不跟随 Web 的「—」占位。
        XCTAssertEqual(declaredCard["skipsBlankSummaryFields"] as? Bool, true)
        XCTAssertEqual(declaredCard["supportsPrefill"] as? Bool, false)
        XCTAssertEqual(declaredCard["untitledUsesRecordId"] as? Bool, false)

        var blankFields = first.fields
        blankFields["fld-title"] = AnyCodable("")
        let blank = NativeTabDataCardProjection.make(
            record: NativeTabDataRecord(id: first.id, tableId: first.tableId, fields: blankFields, version: first.version),
            fields: fields,
            view: view,
            untitledTitle: "未命名记录"
        )
        XCTAssertEqual(blank.title, "未命名记录")
        XCTAssertFalse(blank.title.contains("rec-0001"))

        let surfaces = try XCTUnwrap(contract["surfacePolicy"] as? [[String: Any]])
        XCTAssertEqual(surfaces.count, 6)
        for expectation in surfaces {
            let current = try XCTUnwrap((expectation["current"] as? [String: Any])?["ios"] as? [String: Any])
            XCTAssertEqual(current["surface"] as? String, "cards")
            XCTAssertEqual(current["showSwitcher"] as? Bool, false)
        }

        let filter = try XCTUnwrap(
            ((contract["filterExpectations"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: Any]
        )
        XCTAssertEqual(filter["maxConditions"] as? String, "flat_one_per_field")
        XCTAssertEqual(filter["nestedGroups"] as? Bool, false)
        XCTAssertEqual(filter["conjunctions"] as? [String], ["and", "or"])
        XCTAssertEqual(
            filter["operators"] as? [String],
            ["contains", "equals", "not_equals", "greater_than", "less_than"]
        )
        let interactive = NativeTabDataFilterRule(fieldId: "fld-status", operatorName: "contains", value: "doing")
        XCTAssertEqual(interactive.fieldId, "fld-status")

        let sort = try XCTUnwrap(
            ((contract["sortExpectations"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: Any]
        )
        XCTAssertEqual(sort["maxConditions"] as? Int, 1)
        XCTAssertEqual(NativeTabDataSortRule(fieldId: "fld-priority", descending: true).fieldId, "fld-priority")

        let owner = try XCTUnwrap(fields.first { $0.id == "fld-owner" })
        let ownerText = owner.displayText(for: NativeTabDataValue.parse(first.fields[owner.id] ?? first.fields[owner.name], field: owner))
        XCTAssertFalse(ownerText.contains("usr-0001"), "人员展示不得出现原始用户 ID")
        XCTAssertFalse(NativeTabDataDisplayText.looksLikeInternalId(ownerText))
        let leak = try XCTUnwrap(
            ((contract["leakPolicy"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: Any]
        )
        XCTAssertEqual(leak["leaksUserIdInDisplay"] as? Bool, false)
        XCTAssertEqual(leak["leaksRecordIdInTitle"] as? Bool, false)
        XCTAssertEqual(leak["leaksRawViewType"] as? Bool, false)

        let calendar = try table.view(id: "viw-calendar-0001")
        let gantt = try table.view(id: "viw-future-0001")
        XCTAssertFalse(calendar.supportsNativeCards)
        XCTAssertFalse(gantt.supportsNativeCards)
    }

    /// viw-grid-0001 把分组字段与 hidden_fields 目标字段都排在摘要前 4 的射程之外，
    /// 卡片投影的几条规则实现反了它也照样绿。projectionCases 里的
    /// viw-cards-0002 把这些字段摆进射程，这里逐条实测生产投影。
    func testDiscriminatingProjectionCasesMatchDeclaredIOSCurrent() throws {
        let table = try loadTable()
        let contract = try loadContract()
        let fields = try table.fields()
        let records = try table.records()
        let cases = try XCTUnwrap(contract["projectionCases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty, "卡片投影必须保留可证伪用例")

        for projectionCase in cases {
            let label = try XCTUnwrap(projectionCase["id"] as? String)
            let view = try table.view(id: try XCTUnwrap(projectionCase["view"] as? String))
            let recordId = try XCTUnwrap(projectionCase["record"] as? String)
            let record = try XCTUnwrap(records.first { $0.id == recordId })
            let card = NativeTabDataCardProjection.make(
                record: record,
                fields: fields,
                view: view,
                untitledTitle: "未命名记录"
            )
            let current = try XCTUnwrap(
                (projectionCase["current"] as? [String: Any])?["ios"] as? [String: Any]
            )

            XCTAssertFalse(view.groups.isEmpty, "\(label) 的分组字段必须写在顶层 view.groups，与生产读法一致")

            // 投影不回吐标题字段 id，只能反过来断言标题正是声明字段在该记录上的值。
            let titleFieldId = try XCTUnwrap(current["titleField"] as? String)
            let titleField = try XCTUnwrap(fields.first { $0.id == titleFieldId })
            let titleValue = titleField.displayText(
                for: NativeTabDataValue.parse(
                    record.fields[titleField.id] ?? record.fields[titleField.name],
                    field: titleField
                )
            )
            XCTAssertEqual(card.title, titleValue, "\(label) 标题必须取自 \(titleFieldId)")

            let coverFieldId = current["coverField"] as? String
            if let coverFieldId {
                let coverField = try XCTUnwrap(fields.first { $0.id == coverFieldId })
                let coverValue = record.fields[coverField.id] ?? record.fields[coverField.name]
                let coverUrl = try XCTUnwrap(card.coverUrl, "\(label) 封面必须产出地址")
                XCTAssertTrue(
                    String(describing: coverValue?.value).contains(coverUrl),
                    "\(label) 封面必须取自 \(coverFieldId) 的值"
                )
            } else {
                XCTAssertNil(card.coverUrl, "\(label) 不应产出封面")
            }

            XCTAssertEqual(
                card.fields.map(\.fieldId),
                current["bodyFields"] as? [String],
                "\(label) 摘要字段漂移"
            )
        }
    }

    /// prefillCases 必须保留可证伪用例。iOS 已接线 NativeTabDataPrefillPolicy，
    /// current.ios 必须等于生产函数对夹具视图的实际产出。
    func testPrefillCasesMatchDeclaredIOSCurrent() throws {
        let table = try loadTable()
        let contract = try loadContract()
        let fields = try table.fields()
        let cases = try XCTUnwrap(contract["prefillCases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty, "新建预填必须保留可证伪用例")

        for prefillCase in cases {
            let label = try XCTUnwrap(prefillCase["id"] as? String)
            let view = try table.view(id: try XCTUnwrap(prefillCase["view"] as? String))
            XCTAssertNotNil(prefillCase["target"], "\(label) 必须声明正典 target")
            XCTAssertFalse(
                sameJSONValue(prefillCase["target"], nil),
                "\(label) 的 target 不能是空：实现直接返回空时这条必须失败"
            )
            let groupValues = prefillCase["groupValues"] as? [String: Any]
            let actual = NativeTabDataPrefillPolicy.resolve(
                currentView: view,
                fields: fields,
                groupValues: groupValues
            )
            let current = (prefillCase["current"] as? [String: Any])?["ios"]
            XCTAssertTrue(
                sameJSONValue(actual, current),
                "\(label) iOS 预填与 current 声明不一致"
            )
        }
    }

    func testUserDirectoryResolverMatchesContractCasesAndDoesNotLeakIds() throws {
        let table = try loadUserDirectoryTable()
        let expectations = try loadUserDirectoryExpectations()
        let directory = try XCTUnwrap(decodeDirectory(from: table))
        let fields = try table.fields()
        let records = try table.records()
        let cases = try XCTUnwrap(expectations["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)

        let leakPolicy = try XCTUnwrap(expectations["leakPolicy"] as? [String: Any])
        let forbiddenSubstrings = try XCTUnwrap(leakPolicy["forbiddenSubstrings"] as? [String])
        let forbiddenPatterns = (leakPolicy["forbiddenPatterns"] as? [[String: Any]] ?? []).compactMap { item in
            item["pattern"] as? String
        }
        let leakRegexes = try forbiddenPatterns.map { pattern in
            try NSRegularExpression(pattern: pattern)
        }

        for item in cases {
            let label = try XCTUnwrap(item["name"] as? String)
            let recordId = try XCTUnwrap(item["record"] as? String)
            let fieldId = try XCTUnwrap(item["field"] as? String)
            let record = try XCTUnwrap(records.first { $0.id == recordId }, "缺少记录 \(recordId)")
            let field = try XCTUnwrap(fields.first { $0.id == fieldId }, "缺少字段 \(fieldId)")
            let raw = record.fields[field.id] ?? record.fields[field.name]
            let resolved = NativeTabDataMemberDirectoryResolver.resolve(
                raw?.value,
                directory: directory,
                copy: .contract
            )
            let visibleText = resolved.map(\.displayName).joined(separator: " · ")

            if let targets = item["target"] as? [[String: Any]] {
                XCTAssertEqual(resolved.count, targets.count, "\(label) 条数")
                for (index, target) in targets.enumerated() {
                    assertResolved(
                        resolved[index],
                        matches: target,
                        label: "\(label)#\(index)"
                    )
                }
            } else if let target = item["target"] as? [String: Any] {
                XCTAssertEqual(resolved.count, 1, "\(label) 应解析出一条")
                assertResolved(try XCTUnwrap(resolved.first), matches: target, label: label)
            } else {
                XCTAssertTrue(resolved.isEmpty, "\(label) 空值应产出空列表")
                XCTAssertFalse(visibleText.contains(L10n.TabData.unknownMember))
                XCTAssertFalse(visibleText.contains("未知"))
            }

            for fragment in forbiddenSubstrings {
                XCTAssertFalse(
                    visibleText.contains(fragment),
                    "\(label) 泄漏了 \(fragment)"
                )
            }
            let range = NSRange(visibleText.startIndex..<visibleText.endIndex, in: visibleText)
            for regex in leakRegexes {
                XCTAssertEqual(
                    regex.numberOfMatches(in: visibleText, range: range),
                    0,
                    "\(label) 匹配到裸 UUID"
                )
            }
        }
    }

    func testKnownGapsAndTableReleaseReadinessAreDerivedFromCurrentVersusTarget() throws {
        let contract = try loadContract()
        let declaredGaps = try XCTUnwrap((contract["knownGaps"] as? [String: Any])?["ios"] as? [[String: Any]])
        var declaredKeys = Set<String>()
        for gap in declaredGaps {
            let issue = gap["issue"] as? Int
            XCTAssertTrue(
                (issue ?? 0) > 0,
                "\(gap["path"] as? String ?? "?") 的 gap 必须挂在真实 issue 上，便于接手时找到上下文",
            )
            XCTAssertEqual(gap["batch"] as? Int, 3)
            XCTAssertFalse((gap["reason"] as? String ?? "").isEmpty)
            let aspect = try XCTUnwrap(gap["aspect"] as? String)
            XCTAssertTrue(["disposition", "presentation"].contains(aspect))
            declaredKeys.insert("\(try XCTUnwrap(gap["path"] as? String))#\(aspect)")
        }
        XCTAssertEqual(declaredKeys.count, declaredGaps.count)

        let derivedKeys = try derivedIOSGapKeys(contract)
        XCTAssertEqual(
            declaredKeys,
            derivedKeys,
            "iOS gap 必须与 current/target 的当前事实精确相等，不能多报或漏报"
        )

        let iosEditable = try contract.fieldCurrent(platform: "ios").editable
        let androidEditable = try contract.fieldCurrent(platform: "android").editable
        let knownGaps = try XCTUnwrap(contract["knownGaps"] as? [String: Any])
        let hasKnownGaps = ((knownGaps["ios"] as? [Any])?.isEmpty == false)
            || ((knownGaps["android"] as? [Any])?.isEmpty == false)
        let derivedReadiness = (iosEditable != androidEditable || hasKnownGaps || !derivedKeys.isEmpty)
            ? "blocked"
            : "ready"
        let releaseGate = try XCTUnwrap(contract["releaseGate"] as? [String: Any])
        XCTAssertEqual(releaseGate["requireDispositionParity"] as? Bool, true)
        XCTAssertEqual(releaseGate["requireKnownGapsEmpty"] as? Bool, true)
        XCTAssertEqual(
            releaseGate["releaseReadiness"] as? String,
            derivedReadiness,
            "多维表 releaseReadiness 必须由处置一致性与 known gap 共同推导"
        )
    }

    private func derivedIOSGapKeys(_ contract: [String: Any]) throws -> Set<String> {
        var keys = Set<String>()
        let targetEditable = Set(try XCTUnwrap(
            (contract["fieldDispositions"] as? [String: Any])?["editable"] as? [String]
        ))
        let currentEditable = try contract.fieldCurrent(platform: "ios").editable
        for type in targetEditable.subtracting(currentEditable) {
            keys.insert("/fieldDispositions/\(type)#disposition")
        }

        let aliasCurrent = try XCTUnwrap(
            ((contract["aliasNormalization"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: String]
        )
        let aliasTarget = try loadTable().aliasCases().reduce(into: [String: String]()) { result, alias in
            result[try XCTUnwrap(alias["input"] as? String)] = try XCTUnwrap(alias["canonical"] as? String)
        }
        if aliasTarget.contains(where: { aliasCurrent[$0.key] != $0.value }) {
            keys.insert("/aliasNormalization#presentation")
        }

        let card = try XCTUnwrap(contract["cardProjection"] as? [String: Any])
        let cardCurrent = try XCTUnwrap((card["current"] as? [String: Any])?["ios"] as? [String: Any])
        // excludesGroupField 现在反向判定：排除分组才是跑偏，不排除才合正典。
        // hidden_fields 不再是目标，已从达标口径移除。
        let projectionCasesOffTarget = (contract["projectionCases"] as? [[String: Any]] ?? []).contains { item in
            guard
                let target = item["target"] as? [String: Any],
                let current = (item["current"] as? [String: Any])?["ios"] as? [String: Any]
            else { return true }
            return (target["titleField"] as? String) != (current["titleField"] as? String)
                || (target["coverField"] as? String) != (current["coverField"] as? String)
                || (target["bodyFields"] as? [String]) != (current["bodyFields"] as? [String])
        }
        let cardOffTarget = (card["coverField"] as? String) != (cardCurrent["coverField"] as? String)
            || (cardCurrent["excludesGroupField"] as? Bool) == true
            || (cardCurrent["excludesCoverField"] as? Bool) != true
            || (cardCurrent["supportsPrefill"] as? Bool) != true
            || projectionCasesOffTarget
        if cardOffTarget {
            keys.insert("/cardProjection#presentation")
        }

        let prefillCases = contract["prefillCases"] as? [[String: Any]] ?? []
        let prefillCasesOffTarget = prefillCases.isEmpty || prefillCases.contains { item in
            !sameJSONValue(item["target"], (item["current"] as? [String: Any])?["ios"])
        }
        if prefillCasesOffTarget {
            keys.insert("/prefillCases#presentation")
        }

        let surfaces = try XCTUnwrap(contract["surfacePolicy"] as? [[String: Any]])
        let surfaceOffTarget = surfaces.contains { expectation in
            guard let current = (expectation["current"] as? [String: Any])?["ios"] as? [String: Any] else {
                return true
            }
            return (expectation["surface"] as? String) != (current["surface"] as? String)
                || (expectation["showSwitcher"] as? Bool) != (current["showSwitcher"] as? Bool)
        }
        if surfaceOffTarget {
            keys.insert("/surfacePolicy#disposition")
        }

        let viewTarget = Set(try XCTUnwrap(
            (contract["viewDispositions"] as? [String: Any])?["native"] as? [String]
        ))
        let viewCurrent = Set(try XCTUnwrap(
            (((contract["viewDispositions"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: Any])?["native"] as? [String]
        ))
        if viewCurrent != viewTarget {
            keys.insert("/viewDispositions#disposition")
        }

        let filter = try XCTUnwrap(
            ((contract["filterExpectations"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: Any]
        )
        if (filter["nestedGroups"] as? Bool) != true || (filter["maxConditions"] as? Int) != 2 {
            keys.insert("/filterExpectations#disposition")
        }
        let sort = try XCTUnwrap(
            ((contract["sortExpectations"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: Any]
        )
        if (sort["maxConditions"] as? Int) != 2 {
            keys.insert("/sortExpectations#disposition")
        }
        let leak = try XCTUnwrap(
            ((contract["leakPolicy"] as? [String: Any])?["current"] as? [String: Any])?["ios"] as? [String: Any]
        )
        if leak["leaksUserIdInDisplay"] as? Bool == true {
            keys.insert("/leakPolicy/userId#presentation")
        }
        return keys
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

    private func loadTable() throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: fixtureData(named: "full-fields.table"))
        return try XCTUnwrap(object as? [String: Any])
    }

    private func loadContract() throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: fixtureData(named: "full-fields.expectations"))
        return try XCTUnwrap(object as? [String: Any])
    }

    private func loadUserDirectoryTable() throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: fixtureData(named: "user-directory.table"))
        return try XCTUnwrap(object as? [String: Any])
    }

    private func loadUserDirectoryExpectations() throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: fixtureData(named: "user-directory.expectations"))
        return try XCTUnwrap(object as? [String: Any])
    }

    private func decodeDirectory(from table: [String: Any]) throws -> NativeTabDataMemberDirectory {
        let block = try XCTUnwrap(table["directory"] as? [String: Any])
        let data = try JSONSerialization.data(withJSONObject: block)
        return try JSONDecoder().decode(NativeTabDataMemberDirectory.self, from: data)
    }

    private func assertResolved(
        _ actual: NativeTabDataMemberRef,
        matches target: [String: Any],
        label: String
    ) {
        XCTAssertEqual(actual.kind.rawValue, target["kind"] as? String, "\(label) kind")
        XCTAssertEqual(actual.displayName, target["displayName"] as? String, "\(label) displayName")
        XCTAssertEqual(actual.avatarUrl, target["avatarUrl"] as? String, "\(label) avatarUrl")
    }

    private func fixtureData(named name: String) throws -> Data {
        let bundle = Bundle(for: Self.self)
        let url = bundle.url(
            forResource: name,
            withExtension: "json",
            subdirectory: "mobile-contract/table"
        ) ?? bundle.url(forResource: name, withExtension: "json")
        return try Data(contentsOf: XCTUnwrap(url, "测试包缺少 \(name).json"))
    }

    private func decode<T: Decodable>(_ object: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private extension Dictionary where Key == String, Value == Any {
    func fields() throws -> [NativeTabDataField] {
        let table = try XCTUnwrap(self["table"] as? [String: Any])
        let objects = try XCTUnwrap(table["fields"] as? [[String: Any]])
        return try objects.map { object in
            var payload = object
            payload["is_primary"] = object["is_primary"] ?? false
            payload["is_hidden"] = object["is_hidden"] ?? false
            payload["order"] = object["order"] ?? 0
            let data = try JSONSerialization.data(withJSONObject: payload)
            return try JSONDecoder().decode(NativeTabDataField.self, from: data)
        }
    }

    func records() throws -> [NativeTabDataRecord] {
        let table = try XCTUnwrap(self["table"] as? [String: Any])
        let objects = try XCTUnwrap(table["records"] as? [[String: Any]])
        return try objects.map { object in
            let data = try JSONSerialization.data(withJSONObject: object)
            return try JSONDecoder().decode(NativeTabDataRecord.self, from: data)
        }
    }

    func view(id: String) throws -> NativeTabDataView {
        let table = try XCTUnwrap(self["table"] as? [String: Any])
        let objects = try XCTUnwrap(table["views"] as? [[String: Any]])
        let object = try XCTUnwrap(objects.first { $0["id"] as? String == id })
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(NativeTabDataView.self, from: data)
    }

    func aliasCases() throws -> [[String: Any]] {
        try XCTUnwrap(self["aliasCases"] as? [[String: Any]])
    }

    func fieldCurrent(platform: String) throws -> (editable: Set<String>, readonly: Set<String>) {
        let current = try XCTUnwrap(
            ((self["fieldDispositions"] as? [String: Any])?["current"] as? [String: Any])?[platform] as? [String: Any]
        )
        return (
            Set(try XCTUnwrap(current["editable"] as? [String])),
            Set(try XCTUnwrap(current["readonly_display"] as? [String]))
        )
    }
}
