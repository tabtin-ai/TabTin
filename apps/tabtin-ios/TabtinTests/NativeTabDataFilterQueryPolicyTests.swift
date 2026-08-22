import XCTest
@testable import Tabtin

final class NativeTabDataFilterQueryPolicyTests: XCTestCase {
    func testEmptyRulesOmitFiltersAndLogic() {
        let items = NativeTabDataFilterQueryPolicy.queryItems(rules: [], logic: .or)
        XCTAssertTrue(items.isEmpty)
        XCTAssertNil(items["filters"])
        XCTAssertNil(items["filter_logic"])
    }

    func testSingleContainsMatchesCurrentIOSRequest() throws {
        let rule = NativeTabDataFilterRule(fieldId: "field-1", operatorName: "contains", value: "关键字")
        let items = NativeTabDataFilterQueryPolicy.queryItems(rules: [rule], logic: .and)
        XCTAssertEqual(Array(items.keys).sorted(), ["filters"])
        XCTAssertNil(items["filter_logic"])

        let decoded = try decodeFilters(items["filters"])
        XCTAssertEqual(decoded.count, 1)
        XCTAssertEqual(decoded[0]["field_id"] as? String, "field-1")
        XCTAssertEqual(decoded[0]["operator"] as? String, "contains")
        XCTAssertEqual(decoded[0]["value"] as? String, "关键字")
        XCTAssertEqual(decoded[0]["enabled"] as? Bool, true)
        XCTAssertEqual(wireKeys(decoded[0]), ["field_id", "operator", "value", "enabled"])
        XCTAssertEqual(
            items["filters"],
            "[{\"field_id\":\"field-1\",\"operator\":\"contains\",\"value\":\"关键字\",\"enabled\":true}]"
        )
    }

    func testTwoRulesWithOrSendFiltersAndLogic() throws {
        let rules = [
            NativeTabDataFilterRule(fieldId: "fld-name", operatorName: "contains", value: "foo"),
            NativeTabDataFilterRule(fieldId: "fld-status", operatorName: "equals", value: "open"),
        ]
        let items = NativeTabDataFilterQueryPolicy.queryItems(rules: rules, logic: .or)
        XCTAssertEqual(items["filter_logic"], "or")
        XCTAssertEqual(
            items["filters"],
            "[{\"field_id\":\"fld-name\",\"operator\":\"contains\",\"value\":\"foo\",\"enabled\":true},{\"field_id\":\"fld-status\",\"operator\":\"equals\",\"value\":\"open\",\"enabled\":true}]"
        )
        let decoded = try decodeFilters(items["filters"])
        XCTAssertEqual(decoded.count, 2)
        XCTAssertEqual(wireKeys(decoded[0]), ["field_id", "operator", "value", "enabled"])
        XCTAssertEqual(wireKeys(decoded[1]), ["field_id", "operator", "value", "enabled"])
    }

    func testTwoRulesWithAndSendFilterLogicAnd() {
        let rules = [
            NativeTabDataFilterRule(fieldId: "fld-a", operatorName: "greater_than", value: "1"),
            NativeTabDataFilterRule(fieldId: "fld-b", operatorName: "less_than", value: "9"),
        ]
        let items = NativeTabDataFilterQueryPolicy.queryItems(rules: rules, logic: .and)
        XCTAssertEqual(items["filter_logic"], "and")
        XCTAssertEqual(
            items["filters"],
            "[{\"field_id\":\"fld-a\",\"operator\":\"greater_than\",\"value\":\"1\",\"enabled\":true},{\"field_id\":\"fld-b\",\"operator\":\"less_than\",\"value\":\"9\",\"enabled\":true}]"
        )
    }

    func testIllegalOperatorIsDroppedAndNeverSent() {
        let rules = [
            NativeTabDataFilterRule(fieldId: "fld-ok", operatorName: "contains", value: "keep"),
            NativeTabDataFilterRule(fieldId: "fld-bad", operatorName: "is_not_empty", value: "x"),
            NativeTabDataFilterRule(fieldId: "fld-also-bad", operatorName: "BETWEEN", value: "y"),
        ]
        let items = NativeTabDataFilterQueryPolicy.queryItems(rules: rules, logic: .or)
        XCTAssertNil(items["filter_logic"], "只剩一条合法条件时不带 filter_logic")
        XCTAssertEqual(
            items["filters"],
            "[{\"field_id\":\"fld-ok\",\"operator\":\"contains\",\"value\":\"keep\",\"enabled\":true}]"
        )
        XCTAssertFalse(items["filters"]?.contains("is_not_empty") == true)
        XCTAssertFalse(items["filters"]?.contains("BETWEEN") == true)
        XCTAssertTrue(NativeTabDataFilterQueryPolicy.sanitized(rules).allSatisfy {
            NativeTabDataFilterQueryPolicy.allowedOperators.contains($0.operatorName)
        })
    }

    func testAllIllegalOperatorsOmitQueryItems() {
        let rules = [
            NativeTabDataFilterRule(fieldId: "fld-bad", operatorName: "is", value: "doing"),
        ]
        XCTAssertTrue(NativeTabDataFilterQueryPolicy.queryItems(rules: rules, logic: .and).isEmpty)
    }

    func testOperatorsAlignWithAndroidByFieldType() {
        XCTAssertEqual(
            NativeTabDataFilterQueryPolicy.operators(for: .text),
            ["contains", "equals", "not_equals"]
        )
        XCTAssertEqual(
            NativeTabDataFilterQueryPolicy.operators(for: .number),
            ["equals", "not_equals", "greater_than", "less_than"]
        )
        XCTAssertEqual(
            NativeTabDataFilterQueryPolicy.operators(for: .select),
            ["equals", "not_equals"]
        )
        XCTAssertEqual(
            NativeTabDataFilterQueryPolicy.operators(for: .checkbox),
            ["equals", "not_equals"]
        )
        XCTAssertEqual(NativeTabDataFilterQueryPolicy.defaultOperator(for: .longText), "contains")
        XCTAssertEqual(NativeTabDataFilterQueryPolicy.defaultOperator(for: .currency), "equals")
    }

    func testHiddenAndNonScalarFieldsAreNotFilterable() {
        XCTAssertFalse(NativeTabDataFilterQueryPolicy.isFilterable(fieldType: .text, isHidden: true))
        XCTAssertFalse(NativeTabDataFilterQueryPolicy.isFilterable(fieldType: .attachment, isHidden: false))
        XCTAssertFalse(NativeTabDataFilterQueryPolicy.isFilterable(fieldType: .link, isHidden: false))
        XCTAssertTrue(NativeTabDataFilterQueryPolicy.isFilterable(fieldType: .text, isHidden: false))
    }

    func testReplacingSameFieldKeepsOneRule() {
        let first = NativeTabDataFilterRule(fieldId: "fld-name", operatorName: "contains", value: "old")
        let second = NativeTabDataFilterRule(fieldId: "fld-status", operatorName: "equals", value: "open")
        let replacement = NativeTabDataFilterRule(fieldId: "fld-name", operatorName: "equals", value: "new")
        let next = NativeTabDataFilterQueryPolicy.replacing([first, second], with: replacement)
        XCTAssertEqual(next, [second, replacement])
    }

    private func decodeFilters(_ json: String?) throws -> [[String: Any]] {
        let data = try XCTUnwrap(json?.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    }

    private func wireKeys(_ object: [String: Any]) -> [String] {
        ["field_id", "operator", "value", "enabled"].filter { object[$0] != nil }
    }
}
