import XCTest
@testable import Tabtin

final class AgentSkillPickerFilterTests: XCTestCase {
    func testExcludesAlreadyAttachedSkills() {
        let catalog = [
            AgentSkillPickerCandidate(canonicalKey: "a", name: "Alpha", description: "", emoji: ""),
            AgentSkillPickerCandidate(canonicalKey: "b", name: "Beta", description: "", emoji: ""),
        ]
        let result = AgentSkillPickerFilter.available(
            catalog: catalog,
            attachedKeys: ["a"],
            query: ""
        )
        XCTAssertEqual(result.map(\.canonicalKey), ["b"])
    }

    func testSearchFiltersByName() {
        let catalog = [
            AgentSkillPickerCandidate(canonicalKey: "a", name: "写文档", description: "doc", emoji: ""),
            AgentSkillPickerCandidate(canonicalKey: "b", name: "抓数据", description: "data", emoji: ""),
        ]
        let result = AgentSkillPickerFilter.available(
            catalog: catalog,
            attachedKeys: [],
            query: "文档"
        )
        XCTAssertEqual(result.map(\.canonicalKey), ["a"])
    }

    func testSearchDoesNotMatchHiddenCanonicalKey() {
        let catalog = [
            AgentSkillPickerCandidate(
                canonicalKey: "app:private-namespace/hidden-keyword",
                name: "写文档",
                description: "修改正文",
                emoji: ""
            ),
        ]
        let result = AgentSkillPickerFilter.available(
            catalog: catalog,
            attachedKeys: [],
            query: "hidden-keyword"
        )
        XCTAssertTrue(result.isEmpty)
    }
}
