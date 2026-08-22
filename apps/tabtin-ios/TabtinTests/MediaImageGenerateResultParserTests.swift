import XCTest
@testable import Tabtin

final class MediaImageGenerateResultParserTests: XCTestCase {
    private let url = "https://example.com/apple.png"

    func testExtractsResultUrls() {
        let raw = #"{"success":true,"status":"succeeded","result_urls":["\#(url)"]}"#
        XCTAssertEqual(MediaImageGenerateResultParser.parse(raw), url)
    }

    func testPrefersStoredUrls() {
        let raw = #"{"stored_urls":["https://cdn.example.com/stored.png"],"result_urls":["\#(url)"]}"#
        XCTAssertEqual(
            MediaImageGenerateResultParser.parse(raw),
            "https://cdn.example.com/stored.png"
        )
    }

    func testUnwrapsShellStdoutEnvelope() throws {
        let inner = #"{"ok":true,"data":{"result_urls":["\#(url)"]}}"#
        let envelopeObj: [String: Any] = ["stdout": inner, "exit_code": 0]
        let data = try JSONSerialization.data(withJSONObject: envelopeObj)
        let envelope = String(data: data, encoding: .utf8)!
        XCTAssertEqual(MediaImageGenerateResultParser.parse(envelope), url)
    }

    func testNilWhenNoUrl() {
        XCTAssertNil(MediaImageGenerateResultParser.parse(#"{"stdout":"ok","exit_code":0}"#))
        XCTAssertNil(MediaImageGenerateResultParser.parse(nil as String?))
    }

    func testNormalizesUnicodeAmpersand() {
        // 原始字符串保留字面 `\u0026`，对齐 Electron 截断 stdout 形态。
        let truncated =
            #""result_urls": [ "https://ark.example.com/a.png?X-Tos-Algorithm=TOS4-HMAC-SHA256\u0026X-Tos-Signature=abc" ]"#
        XCTAssertEqual(
            MediaImageGenerateResultParser.parse(truncated),
            "https://ark.example.com/a.png?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Signature=abc"
        )
    }

    func testParseJsonObjectDirectly() {
        let payload: [String: Any] = [
            "stored_urls": ["https://cdn.example.com/stored.png"],
            "result_urls": [url],
        ]
        XCTAssertEqual(
            MediaImageGenerateResultParser.parse(jsonObject: payload),
            "https://cdn.example.com/stored.png"
        )
    }

    func testStripsApprovalNotePrefix() {
        let envelope = #"{"stdout":"{\"result_urls\":[\"\#(url)\"]}","exit_code":0}"#
        let wrapped = """
        <approval_note>
        User approved tool 'run_terminal_command'.
        </approval_note>

        \(envelope)
        """
        XCTAssertEqual(MediaImageGenerateResultParser.parse(wrapped), url)
    }
}

final class ImageGeneratingProgressTests: XCTestCase {
    func testElapsedZeroNearZero() {
        let value = ImageGeneratingProgress.compute(elapsedMs: 0, tauMs: 18_000, done: false)
        XCTAssertGreaterThanOrEqual(value, 0)
        XCTAssertLessThan(value, 5)
    }

    func testElapsedEqualsTauCapsBelow93() {
        let value = ImageGeneratingProgress.compute(elapsedMs: 18_000, tauMs: 18_000, done: false)
        XCTAssertLessThan(value, 93)
    }

    func testLongElapsedCapsAt92() {
        XCTAssertEqual(
            ImageGeneratingProgress.compute(elapsedMs: 600_000, tauMs: 18_000, done: false),
            92,
            accuracy: 0.000_1
        )
    }

    func testDoneIs100() {
        XCTAssertEqual(
            ImageGeneratingProgress.compute(elapsedMs: 5_000, tauMs: 18_000, done: true),
            100,
            accuracy: 0.000_1
        )
    }

    func testDefaultTauMatchesExplicit() {
        XCTAssertEqual(ImageGeneratingProgress.defaultTauMs, 18_000)
        XCTAssertEqual(
            ImageGeneratingProgress.compute(elapsedMs: 18_000, done: false),
            ImageGeneratingProgress.compute(elapsedMs: 18_000, tauMs: 18_000, done: false),
            accuracy: 0.000_1
        )
    }

    func testFormulaContinuous() {
        let elapsedMs: Double = 5_000
        let tauMs: Double = 18_000
        let expected = min(92, 100 * (1 - exp(-elapsedMs / tauMs)))
        XCTAssertEqual(
            ImageGeneratingProgress.compute(elapsedMs: elapsedMs, tauMs: tauMs, done: false),
            expected,
            accuracy: 0.000_1
        )
    }

    func testContinuousAdvanceWithoutIntegerSteps() {
        let a = ImageGeneratingProgress.compute(elapsedMs: 1_000, tauMs: 18_000, done: false)
        let b = ImageGeneratingProgress.compute(elapsedMs: 1_016, tauMs: 18_000, done: false)
        XCTAssertGreaterThan(b, a)
        XCTAssertLessThan(b - a, 1)
    }
}
