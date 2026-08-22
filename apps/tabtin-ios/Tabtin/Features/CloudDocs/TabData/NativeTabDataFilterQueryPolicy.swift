import Foundation

enum NativeTabDataFilterQueryPolicy {
    static let allowedOperators: Set<String> = [
        "contains", "equals", "not_equals", "greater_than", "less_than",
    ]

    static func isFilterable(fieldType: NativeTabDataFieldKind, isHidden: Bool) -> Bool {
        if isHidden { return false }
        switch fieldType {
        case .attachment, .link:
            return false
        default:
            return true
        }
    }

    static func operators(for fieldType: NativeTabDataFieldKind) -> [String] {
        switch fieldType {
        case .text, .longText, .url, .email, .phone:
            ["contains", "equals", "not_equals"]
        case .number, .currency, .percent, .rating, .date:
            ["equals", "not_equals", "greater_than", "less_than"]
        case .select, .singleSelect, .multiSelect:
            ["equals", "not_equals"]
        default:
            ["equals", "not_equals"]
        }
    }

    static func defaultOperator(for fieldType: NativeTabDataFieldKind) -> String {
        switch fieldType {
        case .text, .longText, .url, .email, .phone:
            "contains"
        default:
            "equals"
        }
    }

    static func replacing(
        _ rules: [NativeTabDataFilterRule],
        with rule: NativeTabDataFilterRule
    ) -> [NativeTabDataFilterRule] {
        rules.filter { $0.fieldId != rule.fieldId } + [rule]
    }

    static func sanitized(_ rules: [NativeTabDataFilterRule]) -> [NativeTabDataFilterRule] {
        rules.filter { allowedOperators.contains($0.operatorName) }
    }

    /// 移动端临时条件的扁平 query。0 条不带键；1 条只带 `filters`；2 条以上才带 `filter_logic`。
    /// 视图 fallback 不在这里处理。
    static func queryItems(
        rules: [NativeTabDataFilterRule],
        logic: NativeTabDataFilterLogic
    ) -> [String: String] {
        let valid = sanitized(rules)
        guard !valid.isEmpty else { return [:] }
        var items = ["filters": encodeFilters(valid)]
        if valid.count > 1 {
            items["filter_logic"] = logic.rawValue
        }
        return items
    }

    static func encodeFilters(_ rules: [NativeTabDataFilterRule]) -> String {
        "[" + rules.map(encodeFilter).joined(separator: ",") + "]"
    }

    /// Android `mapOf(field_id, operator, value, enabled)` 的插入顺序；JSONEncoder 不保证键序。
    private static func encodeFilter(_ rule: NativeTabDataFilterRule) -> String {
        let pairs = [
            "\"field_id\":\(jsonString(rule.fieldId))",
            "\"operator\":\(jsonString(rule.operatorName))",
            "\"value\":\(jsonString(rule.value))",
            "\"enabled\":true",
        ]
        return "{" + pairs.joined(separator: ",") + "}"
    }

    private static func jsonString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data("[]".utf8)
        let wrapped = String(data: data, encoding: .utf8) ?? "[]"
        return String(wrapped.dropFirst().dropLast())
    }
}
