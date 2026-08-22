import XCTest
@testable import Tabtin

final class AgentSkillAttachFeedbackTests: XCTestCase {
    func testEmptyNamesYieldNil() {
        XCTAssertNil(AgentSkillAttachFeedback.from(names: []))
        XCTAssertNil(AgentSkillAttachFeedback.from(names: ["  ", ""]))
    }

    func testSingleName() {
        XCTAssertEqual(
            AgentSkillAttachFeedback.from(names: ["写文档"]),
            .single(name: "写文档")
        )
    }

    func testBatchUsesFirstNameAndTotalCount() {
        XCTAssertEqual(
            AgentSkillAttachFeedback.from(names: ["写文档", "抓数据", "画图"]),
            .batch(firstName: "写文档", count: 3)
        )
    }
}
