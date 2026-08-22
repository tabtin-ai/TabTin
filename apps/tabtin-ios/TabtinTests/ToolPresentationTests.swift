import XCTest
import UIKit
@testable import Tabtin

/// 锁定 iOS 与 Electron 共用的 Lucide 图标名和时间线摘要规则。
final class ToolPresentationTests: XCTestCase {
    private var previousLanguage: AppLanguage = .system

    override func setUp() {
        super.setUp()
        previousLanguage = LanguageManager.shared.language
        LanguageManager.shared.language = .zhHans
    }

    override func tearDown() {
        LanguageManager.shared.language = previousLanguage
        super.tearDown()
    }

    func testFailedToolOutputUsesReadableEnvelopeMessage() {
        let raw = #"{"success":false,"error_kind":"file_not_found","hint":"找不到文件 /tmp/report.md，请确认路径后重试"}"#

        XCTAssertEqual(
            ToolResultPresentation.displayText(raw, isError: true),
            "文件不存在\n找不到文件 /tmp/report.md，请确认路径后重试"
        )
    }

    func testFailedToolOutputFallsBackToMappedErrorKind() {
        let raw = #"{"success":false,"error_kind":"permission_denied"}"#

        XCTAssertEqual(
            ToolResultPresentation.displayText(raw, isError: true),
            "权限被拒\n文件可能在工作区外或被标记敏感，请授权后重试。"
        )
    }

    func testSuccessfulAndPlainTextToolOutputRemainUnchanged() {
        let success = #"{"success":true,"content":"hello"}"#
        XCTAssertEqual(ToolResultPresentation.displayText(success, isError: false), success)
        XCTAssertEqual(
            ToolResultPresentation.displayText("plain failure", isError: true),
            "plain failure"
        )
        XCTAssertEqual(
            ToolResultPresentation.displayText(#"{"success":false}"#, isError: true),
            #"{"success":false}"#
        )
    }

    func testCoreRuntimeIconsMatchElectronSemantics() {
        XCTAssertEqual(ToolPresentation.of("execute_command").icon, "Terminal")
        XCTAssertEqual(ToolPresentation.of("ssh_execute").icon, "Server")
        XCTAssertEqual(ToolPresentation.of("Write").icon, "FileText")
        XCTAssertEqual(ToolPresentation.of("apply_patch").icon, "FilePenLine")
        XCTAssertEqual(ToolPresentation.of("delete_file").icon, "FileX2")
        XCTAssertEqual(ToolPresentation.of("code_search").icon, "Search")
        XCTAssertEqual(ToolPresentation.of("sql_query").icon, "Database")
        XCTAssertEqual(ToolPresentation.of("Task").icon, "Bot")
        XCTAssertEqual(ToolPresentation.of("ask_user").icon, "HelpCircle")
        XCTAssertEqual(ToolPresentation.of("todo_write").icon, "CheckCircle2")
        XCTAssertEqual(ToolPresentation.of("memory_write").icon, "NotebookPen")
        XCTAssertNotEqual(ToolPresentation.of("memory_write").icon, "Brain")
    }

    func testDeviceAndTabAppToolsUseSemanticFamilyIcons() {
        XCTAssertEqual(ToolPresentation.of("screen_capture").icon, "ScanLine")
        XCTAssertEqual(ToolPresentation.of("screen_type_secret").icon, "Lock")
        XCTAssertEqual(ToolPresentation.of("tabmemo_create_memo").icon, "PlusCircle")
        XCTAssertEqual(ToolPresentation.of("tabsite_publish_site").icon, "Sparkles")
        XCTAssertEqual(ToolPresentation.of("tabdoc_update_block").icon, "FilePenLine")
    }

    func testTimelineLabelPrefersNaturalLanguageDescriptionWithoutCommandOrPath() {
        let terminal = ToolPresentation.of("execute_command")
        XCTAssertEqual(
            terminal.timelineLabel(
                from: #"{"command":"tabtin file --help","description":"查看文件生成工具帮助"}"#
            ),
            "查看文件生成工具帮助"
        )

        let write = ToolPresentation.of("write_file")
        XCTAssertEqual(
            write.timelineLabel(from: #"{"path":"/Users/me/report.docx"}"#),
            "写入文件 · report.docx"
        )
        XCTAssertEqual(
            write.timelineLabel(
                from: #"{"path":"/Users/me/report.docx"}"#,
                runtimeTitle: "正在生成周报"
            ),
            "正在生成周报"
        )
    }

    func testTimelineDetailUsesPathBasename() {
        let write = ToolPresentation.of("write_file")
        XCTAssertEqual(
            write.timelineDetail(from: #"{"path":"/Users/me/proj/report.docx"}"#),
            "report.docx"
        )
        XCTAssertEqual(
            write.timelineLabel(from: #"{"path":"/Users/me/proj/report.docx"}"#),
            "写入文件 · report.docx"
        )
    }

    func testTimelineDetailStripsCdPrefixAndTakesFirstCommandSegment() {
        let terminal = ToolPresentation.of("execute_command")
        let detail = terminal.timelineDetail(from: #"{"command":"cd x && ls -la"}"#)
        XCTAssertEqual(detail, "ls")
        XCTAssertTrue(detail?.hasPrefix("ls") == true)
    }

    func testUnknownMcpToolUsesGenericVerbAndServerDetail() {
        let mcp = ToolPresentation.of("mcp__linear__create_issue")
        XCTAssertEqual(mcp.verb, "工具调用")
        XCTAssertEqual(mcp.timelineDetail(from: "{}"), "linear")
        let label = mcp.timelineLabel(from: "{}")
        XCTAssertEqual(label, "工具调用 · linear")
        XCTAssertFalse(label.contains("_"))
        XCTAssertFalse(label.lowercased().contains("mcp"))
    }

    func testUnknownToolDoesNotEchoRawName() {
        let unknown = ToolPresentation.of("screen_tap_unknown_xyz")
        XCTAssertEqual(unknown.verb, "工具调用")
        let label = unknown.timelineLabel(from: "{}")
        XCTAssertEqual(label, "工具调用")
        XCTAssertFalse(label.contains("_"))
        XCTAssertFalse(label.contains("screen_tap"))
        XCTAssertFalse(label.contains("unknown"))
    }

    func testSearchFamilyVerbsUseUpdatedCopy() {
        XCTAssertEqual(ToolPresentation.of("web_search").verb, "网络搜索")
        XCTAssertEqual(ToolPresentation.of("code_search").verb, "代码搜索")
        XCTAssertEqual(ToolPresentation.of("grep").verb, "代码搜索")
    }

    func testSummaryReadsNestedRuntimeArguments() {
        let presentation = ToolPresentation.of("execute_command")

        XCTAssertEqual(
            presentation.summary(from: #"{"kwargs":{"command":"pwd"}}"#),
            "pwd"
        )
    }

    func testTimelineDensityUsesCentralPresentationMetadata() {
        XCTAssertEqual(ToolPresentation.of("read_file").timelineStyle, .compact)
        XCTAssertEqual(ToolPresentation.of("glob").timelineStyle, .compact)
        XCTAssertEqual(ToolPresentation.of("tabdoc_list_documents").timelineStyle, .compact)

        XCTAssertEqual(ToolPresentation.of("bash").timelineStyle, .card)
        XCTAssertEqual(ToolPresentation.of("apply_patch").timelineStyle, .card)
        XCTAssertEqual(ToolPresentation.of("request_approval").timelineStyle, .card)
    }

    func testApprovalEvidenceUpgradesNormallyCompactToolToCard() {
        var tool = ToolCall(
            toolCallId: "read-1",
            index: 0,
            name: "read_file",
            inputJson: #"{"path":"/tmp/a.txt"}"#,
            finalized: true
        )
        XCTAssertEqual(ToolPresentation.timelineStyle(for: tool), .compact)

        tool.approvalSource = .user
        XCTAssertEqual(ToolPresentation.timelineStyle(for: tool), .card)
    }

    /// 详情抽屉化后，时间线不再自动展开任何工具；只有需要用户复核的证据
    /// （失败 / 安全护栏命中）才在行上常驻警示。
    func testOnlyFailureAndSuspiciousOutputKeepInlineAlert() {
        var tool = ToolCall(
            toolCallId: "terminal-1",
            index: 0,
            name: "run_terminal_command",
            inputJson: #"{"description":"生成 Word 文档"}"#,
            finalized: true,
            executionPhase: .running
        )
        XCTAssertFalse(ToolStepAlertPresentation.needsInlineAlert(for: tool))

        tool.executionPhase = .succeeded
        XCTAssertFalse(ToolStepAlertPresentation.needsInlineAlert(for: tool))

        tool.executionPhase = .failed
        tool.isError = true
        XCTAssertTrue(ToolStepAlertPresentation.needsInlineAlert(for: tool))

        tool.executionPhase = .succeeded
        tool.isError = false
        tool.hasSuspiciousOutput = true
        XCTAssertTrue(ToolStepAlertPresentation.needsInlineAlert(for: tool))
    }

    func testToolTimelineStatusMatchesElectronVocabulary() {
        XCTAssertNil(ToolTimelineStatusPresentation.label(for: .preparing))
        XCTAssertNil(ToolTimelineStatusPresentation.label(for: .running))
        XCTAssertEqual(ToolTimelineStatusPresentation.label(for: .failed), "失败")
        XCTAssertNil(ToolTimelineStatusPresentation.label(for: .succeeded))
        XCTAssertTrue(ToolTimelineStatusPresentation.usesShimmer(for: .preparing))
        XCTAssertTrue(ToolTimelineStatusPresentation.usesShimmer(for: .running))
        XCTAssertFalse(ToolTimelineStatusPresentation.usesShimmer(for: .failed))
    }

    func testMappedLucideAssetsExist() {
        let representativeTools = [
            "execute_command", "ssh_execute", "Write", "apply_patch", "delete_file",
            "sql_query", "code_search", "git_status", "git_diff", "todo_write",
            "Task", "ask_user", "memory_write", "memory_delete", "show_widget",
            "present_to_user", "get_device_info", "get_battery_info", "get_network_info",
            "read_contacts", "read_sms", "send_sms", "read_call_log", "make_call",
            "read_calendar", "read_notifications", "list_installed_apps", "read_media",
            "get_location", "screen_capture", "screen_ui_tree", "screen_tap",
            "screen_swipe", "screen_long_press", "screen_type_text", "screen_type_secret",
            "screen_key_event", "screen_wait_for_idle", "screen_force_stop",
            "set_system_setting", "set_stealth_mode", "launch_intent", "save_to_device",
            "get_automation_status", "tabmemo_create_memo", "tabsite_publish_site",
        ]

        for tool in representativeTools {
            let icon = ToolPresentation.of(tool).icon
            XCTAssertNotNil(
                UIImage(named: ElectronChatIcon.assetName(for: icon)),
                "\(tool) 映射到不存在的 Lucide asset：\(icon)"
            )
        }
    }

    func testVocabularyFixtureFamiliesMatchPresentation() throws {
        let data = try fixtureData(named: "vocabulary")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let labelKeys = try XCTUnwrap(root["labelKeys"] as? [String: [String: Any]])
        let families = try XCTUnwrap(root["families"] as? [[String: Any]])

        for family in families {
            let labelKey = try XCTUnwrap(family["labelKey"] as? String)
            let icon = try XCTUnwrap(family["icon"] as? String)
            let zh = try XCTUnwrap(labelKeys[labelKey]?["zh"] as? String)
            let names = try XCTUnwrap(family["names"] as? [String])
            for name in names {
                let presentation = ToolPresentation.of(name)
                XCTAssertEqual(presentation.icon, icon, "icon for \(name)")
                XCTAssertEqual(presentation.verb, zh, "verb for \(name) (\(labelKey))")
            }
        }
    }

    func testVocabularyPrefixRulesMatchTabAppPresentation() {
        XCTAssertEqual(ToolPresentation.of("tabdoc_list_documents").verb, "查找内容")
        XCTAssertEqual(ToolPresentation.of("tabdoc_list_documents").icon, "Search")
        XCTAssertEqual(ToolPresentation.of("tabmemo_create_memo").verb, "创建内容")
        XCTAssertEqual(ToolPresentation.of("tabmemo_create_memo").icon, "PlusCircle")
        XCTAssertEqual(ToolPresentation.of("tabsite_publish_site").verb, "发布内容")
        XCTAssertEqual(ToolPresentation.of("tabdoc_update_block").verb, "更新内容")
        XCTAssertEqual(ToolPresentation.of("tabcustom_foo").verb, "工具调用")
        XCTAssertEqual(ToolPresentation.of("tabcustom_foo").icon, "Wrench")
    }

    private func fixtureData(named name: String) throws -> Data {
        let bundle = Bundle(for: Self.self)
        let url = bundle.url(
            forResource: name,
            withExtension: "json",
            subdirectory: "mobile-contract/tool-row"
        ) ?? bundle.url(forResource: name, withExtension: "json")
        return try Data(contentsOf: XCTUnwrap(url, "测试包缺少 \(name).json"))
    }
}
