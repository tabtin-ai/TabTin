import Foundation

/// 新建记录时按当前视图预填字段。与 Web `resolveMobilePrefillValues` 逐条对齐：
///
/// - `config.filter_logic === "or"` 时整段 filters 跳过（不读嵌套 FilterSet 的 conjunction）
/// - 只读顶层扁平 `filters` / `groups`，不读 `config.filters`、`filter_groups`、顶层 `filter`
/// - `enabled === false` 跳过；缺省视为启用
/// - 字段先按 id 再按 name；算子 trim + 小写
/// - 同一字段被赋了不同值 → 清空**整段** filters 结果
/// - 结果 key 是字段名；空结果返回 nil
///
/// 可写性跟 Web 的 `isWritableField`（创建期类型），不是移动端详情页能不能编辑。
/// 附件 / 关联记录在移动端只读展示，预填值仍要进提交内容。
enum NativeTabDataPrefillPolicy {
    private static let nonWritableCreateFieldTypes: Set<String> = [
        "created_time",
        "last_modified_time",
        "created_by",
        "last_modified_by",
    ]
    private static let scalarPrefillOperators: Set<String> = ["equals", "is", "is_exactly"]
    private static let arrayPrefillOperators: Set<String> = ["in", "is_any_of"]

    static func resolve(
        currentView: NativeTabDataView?,
        fields: [NativeTabDataField],
        groupValues: [String: Any]? = nil
    ) -> [String: Any]? {
        let fieldById = Dictionary(uniqueKeysWithValues: fields.map { ($0.id, $0) })
        let fieldByName = Dictionary(uniqueKeysWithValues: fields.map { ($0.name, $0) })
        var result: [String: Any] = [:]
        let filterLogic = currentView?.config["filter_logic"]?.stringValue
        if filterLogic != "or" {
            var hasConflictingFilter = false
            for filter in currentView?.filters ?? [] {
                if isDisabled(filter) { continue }
                guard let fieldKey = filter["field_id"]?.stringValue else { continue }
                let field = fieldById[fieldKey] ?? fieldByName[fieldKey]
                guard let value = readFilterPrefill(filter, field: field), let field else { continue }
                if let existing = result[field.name], !sameJSONValue(existing, value) {
                    hasConflictingFilter = true
                    break
                }
                result[field.name] = value
            }
            if hasConflictingFilter { result.removeAll() }
        }

        for group in currentView?.groups ?? [] {
            guard let fieldKey = group["field_id"]?.stringValue else { continue }
            guard let field = fieldById[fieldKey] ?? fieldByName[fieldKey] else { continue }
            guard isWritableField(field) else { continue }
            let value = groupValues?[field.name]
            if !shouldSkipGroupValue(value), let value {
                result[field.name] = value
            }
        }
        return result.isEmpty ? nil : result
    }

    /// 看板分组下新建：把这一列的 `groupValue` 写成 `{字段名: 值}`，供 `resolve` 的 groups 分支使用。
    /// 移动端看板只展开第一层分组。
    static func groupValues(
        from view: NativeTabDataView?,
        fields: [NativeTabDataField],
        group: NativeTabDataRecordGroup
    ) -> [String: Any]? {
        guard let grouping = view?.groups.first else { return nil }
        guard let fieldKey = grouping["field_id"]?.stringValue else { return nil }
        guard let field = fields.first(where: { $0.id == fieldKey })
            ?? fields.first(where: { $0.name == fieldKey })
        else { return nil }
        if shouldSkipGroupValue(group.groupValue.value) { return nil }
        return [field.name: group.groupValue.value]
    }

    private static func isWritableField(_ field: NativeTabDataField?) -> Bool {
        guard let field else { return false }
        let raw = field.fieldType.rawValue
        let normalized = NativeTabDataFieldKind.normalize(raw)
        return !nonWritableCreateFieldTypes.contains(raw)
            && !nonWritableCreateFieldTypes.contains(normalized)
    }

    private static func readFilterPrefill(
        _ filter: [String: AnyCodable],
        field: NativeTabDataField?
    ) -> Any? {
        guard isWritableField(field) else { return nil }
        guard let operatorName = filter["operator"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        else { return nil }
        guard let raw = filter["value"], !(raw.value is NSNull) else { return nil }
        if scalarPrefillOperators.contains(operatorName) { return raw.value }
        if arrayPrefillOperators.contains(operatorName),
           let array = raw.arrayValue,
           array.count == 1 {
            return array[0]
        }
        return nil
    }

    private static func isDisabled(_ filter: [String: AnyCodable]) -> Bool {
        filter["enabled"]?.boolValue == false
    }

    private static func shouldSkipGroupValue(_ value: Any?) -> Bool {
        guard let value else { return true }
        if value is NSNull { return true }
        if let string = value as? String, string.isEmpty { return true }
        return false
    }

    private static func sameJSONValue(_ lhs: Any, _ rhs: Any) -> Bool {
        let left = ["v": lhs]
        let right = ["v": rhs]
        guard
            JSONSerialization.isValidJSONObject(left),
            JSONSerialization.isValidJSONObject(right),
            let leftData = try? JSONSerialization.data(withJSONObject: left, options: [.sortedKeys]),
            let rightData = try? JSONSerialization.data(withJSONObject: right, options: [.sortedKeys])
        else {
            return String(describing: lhs) == String(describing: rhs)
        }
        return leftData == rightData
    }
}
