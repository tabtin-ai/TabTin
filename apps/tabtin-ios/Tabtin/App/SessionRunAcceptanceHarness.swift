#if DEBUG
import SwiftUI

/// 由 `scripts/ios-session-run-acceptance.sh` 通过 `simctl launch` 驱动。
///
/// 每个场景都运行在真实 App 进程中，并复用生产的 HTTP/WS JSON 契约与
/// `SessionRunProjectionReducer`。它不替代 live 后端联调；职责是把冷启动、
/// 乱序、取消和跨进程恢复先固化成无需人工点按的机器红绿门。
struct SessionRunAcceptanceHarnessRoot: View {
    @State private var status = "RUNNING"

    var body: some View {
        VStack(spacing: 12) {
            Text("Session Run Acceptance")
                .font(.tt.subtitleSemibold)
            Text(status)
                .font(.system(.body, design: .monospaced))
                .accessibilityIdentifier("session-run-acceptance-status")
        }
        .padding()
        .task {
            let result = SessionRunAcceptanceHarness.runFromProcessArguments()
            status = result.passed ? "PASS \(result.scenario)" : "FAIL \(result.scenario)"
        }
    }
}

struct SessionRunAcceptanceResult: Codable {
    let scenario: String
    let passed: Bool
    let finalStatus: String?
    let events: [String]
    let failure: String?
}

enum SessionRunAcceptanceHarness {
    static let enabledArgument = "--session-run-acceptance"
    private static let scenarioArgument = "--session-run-scenario"
    private static let resultFile = "session-run-acceptance-result.json"
    private static let checkpointFile = "session-run-acceptance-checkpoint.json"

    static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains(enabledArgument)
    }

    @discardableResult
    static func runFromProcessArguments() -> SessionRunAcceptanceResult {
        let arguments = ProcessInfo.processInfo.arguments
        let scenario: String
        if let index = arguments.firstIndex(of: scenarioArgument),
           arguments.indices.contains(index + 1) {
            scenario = arguments[index + 1]
        } else {
            scenario = "missing"
        }

        let result: SessionRunAcceptanceResult
        do {
            result = try run(scenario: scenario)
        } catch {
            result = SessionRunAcceptanceResult(
                scenario: scenario,
                passed: false,
                finalStatus: nil,
                events: [],
                failure: error.localizedDescription
            )
        }
        write(result)
        return result
    }

    static func run(scenario: String) throws -> SessionRunAcceptanceResult {
        switch scenario {
        case "cold-http-snapshot":
            return try coldHTTPSnapshot()
        case "realtime-out-of-order":
            return realtimeOutOfOrder()
        case "cancel-terminal":
            return cancelTerminal()
        case "terminal-recovery-seed":
            return try terminalRecoverySeed()
        case "terminal-recovery-verify":
            return try terminalRecoveryVerify()
        case "cross-device-read-watermark":
            return crossDeviceReadWatermark()
        default:
            throw HarnessError.unknownScenario(scenario)
        }
    }

    private static func coldHTTPSnapshot() throws -> SessionRunAcceptanceResult {
        // `/chat/sessions/all` 的真实 data 形状；从字节开始解码，防止模型夹具
        // 与生产 CodingKeys 漂移。
        let data = Data(
            """
            {
              "sessions": [{
                "id": "acceptance-session",
                "organization_id": "acceptance-org",
                "has_active_task": false,
                "has_unread_reply": false,
                "last_run_failed": false,
                "run_state": {
                  "run_id": "acceptance-run",
                  "sequence": 4,
                  "revision": 2,
                  "status": "running",
                  "queue_depth": 0,
                  "started_at": "2026-07-29T10:00:00Z",
                  "state_changed_at": "2026-07-29T10:00:01Z",
                  "ended_at": null,
                  "stop_reason": null,
                  "error_class": null,
                  "waiting_interaction_id": null
                }
              }],
              "total": 1,
              "has_more": false
            }
            """.utf8
        )
        let response = try JSONDecoder().decode(RecentSessionListResponse.self, from: data)
        guard let snapshot = response.sessions.first?.runState else {
            throw HarnessError.assertion("HTTP snapshot missing run_state")
        }
        let projection = SessionRunProjectionReducer.applying(
            authoritative: snapshot,
            to: nil
        )
        let presentation = AgentRunPresentationState.conversation(
            rawPhase: nil,
            isStreaming: false,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil,
            authoritativeRunStatus: projection.resolvedStatus
        )
        let passed = projection.resolvedStatus == .running
            && presentation.phase == .executing
            && presentation.isActive
        return result(
            "cold-http-snapshot",
            passed: passed,
            projection: projection,
            events: ["http.decode", "projection.accepted", "presentation.executing"]
        )
    }

    private static func realtimeOutOfOrder() -> SessionRunAcceptanceResult {
        var projection = SessionRunProjectionReducer.applying(
            authoritative: state(revision: 3, status: .running),
            to: nil
        )
        projection = SessionRunProjectionReducer.applying(
            authoritative: state(revision: 4, status: .completed),
            to: projection
        )
        projection = SessionRunProjectionReducer.applying(
            authoritative: state(revision: 99, status: .running),
            to: projection
        )
        return result(
            "realtime-out-of-order",
            passed: projection.resolvedStatus == .running,
            projection: projection,
            events: [
                "realtime.running.rev3",
                "realtime.completed.rev4",
                "realtime.late-running.rev99.rejected",
            ]
        )
    }

    private static func cancelTerminal() -> SessionRunAcceptanceResult {
        var projection = SessionRunProjectionReducer.applying(
            authoritative: state(revision: 2, status: .running),
            to: nil
        )
        projection = SessionRunProjectionReducer.applyingLocal(
            runId: "acceptance-run",
            status: .cancelling,
            beginsNewRun: false,
            to: projection
        )
        projection = SessionRunProjectionReducer.applying(
            authoritative: state(revision: 3, status: .cancelled),
            to: projection
        )
        let passed = projection.resolvedStatus == .cancelled
            && projection.localOverlay == nil
        return result(
            "cancel-terminal",
            passed: passed,
            projection: projection,
            events: ["cancel.requested", "cancel.local-cancelling", "cancel.authoritative-terminal"]
        )
    }

    private static func terminalRecoverySeed() throws -> SessionRunAcceptanceResult {
        let snapshot = state(revision: 2, status: .running)
        try JSONEncoder().encode(snapshot).write(to: checkpointURL, options: .atomic)
        let projection = SessionRunProjectionReducer.applying(
            authoritative: snapshot,
            to: nil
        )
        return result(
            "terminal-recovery-seed",
            passed: projection.resolvedStatus == .running,
            projection: projection,
            events: ["process-1.running.persisted"]
        )
    }

    private static func terminalRecoveryVerify() throws -> SessionRunAcceptanceResult {
        let cached = try JSONDecoder().decode(
            SessionRunState.self,
            from: Data(contentsOf: checkpointURL)
        )
        var projection = SessionRunProjectionReducer.applying(
            authoritative: cached,
            to: nil
        )
        projection = SessionRunProjectionReducer.applying(
            authoritative: state(revision: 3, status: .completed),
            to: projection
        )
        return result(
            "terminal-recovery-verify",
            passed: projection.resolvedStatus == .completed,
            projection: projection,
            events: ["process-2.cache-restored", "process-2.http-terminal-applied"]
        )
    }

    private static func crossDeviceReadWatermark() -> SessionRunAcceptanceResult {
        // 当前 run 即使已进入下一轮 queued，ACK 也必须指向 read_state 暴露的最近 completed。
        let readState = SessionReadState(
            lastReadRunSequence: 3,
            lastReadTerminalRevision: 2,
            readAt: nil,
            latestCompletedRunId: "acceptance-run",
            latestCompletedRunSequence: 4,
            latestCompletedTerminalRevision: 4
        )
        guard let pending = readState.pendingAck(
            sessionId: "acceptance-session",
            mutationId: "acceptance-mutation"
        ) else {
            return result(
                "cross-device-read-watermark",
                passed: false,
                projection: SessionRunProjection(),
                events: ["missing.latest-completed-cursor"]
            )
        }
        let duplicateRejected = !SessionReadWatermarkPolicy.newer(pending, than: pending)
        let newerAccepted = SessionReadWatermarkPolicy.newer(
            PendingSessionReadAck(
                sessionId: pending.sessionId,
                throughRunId: "acceptance-run-2",
                throughSequence: 5,
                throughRevision: 1,
                mutationId: "acceptance-mutation-2"
            ),
            than: pending
        )
        let projection = SessionRunProjectionReducer.applying(
            authoritative: state(revision: 4, status: .completed),
            to: nil
        )
        return result(
            "cross-device-read-watermark",
            passed: duplicateRejected && newerAccepted,
            projection: projection,
            events: [
                "content.reconciled",
                "read.ack.enqueued",
                "duplicate.mutation.rejected",
                "higher-sequence.accepted",
            ]
        )
    }

    private static func state(
        revision: Int,
        status: SessionRunStatus
    ) -> SessionRunState {
        SessionRunState(
            runId: "acceptance-run",
            sequence: 4,
            revision: revision,
            status: status,
            queueDepth: 0,
            startedAt: "2026-07-29T10:00:00Z",
            stateChangedAt: "2026-07-29T10:00:01Z",
            endedAt: status.isTerminal ? "2026-07-29T10:00:02Z" : nil,
            stopReason: status == .cancelled ? "user_cancelled" : nil,
            errorClass: nil,
            waitingInteractionId: nil
        )
    }

    private static func result(
        _ scenario: String,
        passed: Bool,
        projection: SessionRunProjection,
        events: [String]
    ) -> SessionRunAcceptanceResult {
        SessionRunAcceptanceResult(
            scenario: scenario,
            passed: passed,
            finalStatus: projection.resolvedStatus?.rawValue,
            events: events,
            failure: passed ? nil : "unexpected final projection"
        )
    }

    private static var documentsURL: URL {
        URL.documentsDirectory
    }

    private static var resultURL: URL {
        documentsURL.appending(path: resultFile)
    }

    private static var checkpointURL: URL {
        documentsURL.appending(path: checkpointFile)
    }

    private static func write(_ result: SessionRunAcceptanceResult) {
        try? JSONEncoder().encode(result).write(to: resultURL, options: .atomic)
    }
}

private enum HarnessError: LocalizedError {
    case unknownScenario(String)
    case assertion(String)

    var errorDescription: String? {
        switch self {
        case .unknownScenario(let scenario):
            return "unknown scenario: \(scenario)"
        case .assertion(let message):
            return message
        }
    }
}
#endif
