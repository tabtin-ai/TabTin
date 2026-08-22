import XCTest
@testable import Tabtin

final class UserPortraitContractTests: XCTestCase {
    func testAllPortraitRequestsUseAgentScope() {
        XCTAssertEqual(UserPortraitService.query(agentId: "agent-7"), ["agent_id": "agent-7"])
        XCTAssertEqual(
            UserPortraitService.query(agentId: "agent-7", limit: 20),
            ["agent_id": "agent-7", "limit": "20"]
        )
    }

    func testPortraitParserKeepsOverviewSections() {
        let sections = parseUserPortraitSections("## 偏好\n喜欢直接沟通\n## 工作方式\n先想后做")
        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(sections[0].title, "偏好")
        XCTAssertEqual(sections[0].body, "喜欢直接沟通")
        XCTAssertEqual(sections[1].title, "工作方式")
    }

    func testMemoryTypesUseLocalizedPresentationLabels() {
        XCTAssertEqual(agentMemoryTypeLabel("about_you"), L10n.Project.myAgentsMemoryTypeAboutYou)
        XCTAssertEqual(agentMemoryTypeLabel("insight"), L10n.Project.myAgentsMemoryTypeInsight)
        XCTAssertEqual(agentMemoryTypeLabel("task_summary"), L10n.Project.myAgentsMemoryTypeTaskSummary)
        XCTAssertEqual(agentMemoryTypeLabel("diary"), L10n.Project.myAgentsMemoryTypeDiary)
        XCTAssertEqual(agentMemoryTypeLabel("future_type"), L10n.Project.myAgentsMemory)
    }

    func testMemoryDisplayTitleDoesNotExposeInternalTypeKey() {
        XCTAssertEqual(
            agentMemoryDisplayTitle(memoryType: "about_you", title: "about_you"),
            L10n.Project.myAgentsMemoryTypeAboutYou
        )
        XCTAssertEqual(
            agentMemoryDisplayTitle(memoryType: "about_you", title: "用户偏好"),
            "用户偏好"
        )
    }
}
