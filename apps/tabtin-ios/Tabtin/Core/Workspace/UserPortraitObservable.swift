import Foundation
import Observation

@MainActor
@Observable
final class UserPortraitObservable {
    private struct Scope: Equatable {
        let organizationId: String
        let agentId: String

        static let empty = Scope(organizationId: "", agentId: "")
        var isValid: Bool { !organizationId.isEmpty && !agentId.isEmpty }
    }

    private static let pollInterval: UInt64 = 3_000_000_000
    private static let pollMaxAttempts = 12

    private(set) var portrait: UserPortrait?
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var isDistilling = false
    private(set) var isStillDistilling = false

    private var scope = Scope.empty
    private var pollingTask: Task<Void, Never>?

    func configure(organizationId: String, agentId: String) {
        let next = Scope(organizationId: organizationId, agentId: agentId)
        guard next != scope || portrait == nil else { return }

        scope = next
        portrait = nil
        loadError = nil
        stopPolling()

        guard next.isValid else { return }
        Task { await refresh() }
    }

    func refresh() async {
        let captured = scope
        guard captured.isValid else { return }

        isLoading = true
        loadError = nil
        defer {
            if scope == captured { isLoading = false }
        }

        do {
            let value = try await UserPortraitService.get(
                organizationId: captured.organizationId,
                agentId: captured.agentId
            )
            guard scope == captured else { return }
            portrait = value
            if value.lastDistillStatus == .pending {
                startPolling(scope: captured)
            } else {
                stopPolling()
            }
        } catch {
            guard scope == captured, !error.isCancellation else { return }
            loadError = error.localizedDescription
            stopPolling()
        }
    }

    func submitHint(_ text: String) async throws -> UserPortrait {
        let captured = scope
        guard captured.isValid else {
            throw APIError.apiErrorWithCode(code: "INVALID_AGENT_SCOPE", message: "AI 分身范围无效")
        }

        let value = try await UserPortraitService.submitHint(
            organizationId: captured.organizationId,
            agentId: captured.agentId,
            text: text
        )
        guard scope == captured else { return value }
        portrait = value
        if value.distillDispatched != false {
            startPolling(scope: captured)
        }
        return value
    }

    private func startPolling(scope captured: Scope) {
        stopPolling()
        isDistilling = true

        pollingTask = Task { [weak self] in
            guard let self else { return }
            var attempts = 0
            while attempts < Self.pollMaxAttempts {
                do {
                    try await Task.sleep(nanoseconds: Self.pollInterval)
                } catch {
                    return
                }
                guard !Task.isCancelled, self.scope == captured else { return }
                attempts += 1

                do {
                    let value = try await UserPortraitService.get(
                        organizationId: captured.organizationId,
                        agentId: captured.agentId
                    )
                    guard !Task.isCancelled, self.scope == captured else { return }
                    self.portrait = value
                    if value.lastDistillStatus != .pending {
                        self.stopPolling()
                        return
                    }
                } catch {
                    if error.isCancellation { return }
                }
            }

            guard self.scope == captured else { return }
            self.stopPolling()
            self.isStillDistilling = true
        }
    }

    private func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
        isDistilling = false
        isStillDistilling = false
    }
}
