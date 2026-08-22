import XCTest
@testable import Tabtin

/// HITL（Phase 3）解码与投射纯逻辑单测：覆盖 envelope → 强类型 HITLPrompt、阻断分类、
/// approval_resolved 镜像识别，以及 ConversationProjector 的 inline 提案卡注入 / 去重 / 收起。
final class HITLModelsTests: XCTestCase {
    private let decoder = WireDecoder()

    private func envelope(_ short: String, payload: [String: Any]) -> WSEnvelope {
        WSEnvelope.build(type: AgentStreamEvent.fullType(short), deviceId: "ios-test", payload: payload)
    }

    // MARK: - decode

    func testAskUserDecodes() {
        let env = envelope(AgentStreamEvent.askUserRequired, payload: [
            "request_id": "rq1",
            "tool_name": "ask_user",
            "interaction_type": "choice",
            "blocking_policy": "blocking",
            "intent": "clarify",
            "form_mode": "single",
            "questions": [[
                "id": "q1", "prompt": "选哪个？", "header": "方向",
                "options": [["id": "a", "label": "A", "description": ""]],
                "allow_multiple": false,
            ]],
        ])
        guard case let .hitl(kind, hitlEnv) = decoder.decode(env), kind == .askUser else {
            return XCTFail("expected askUser hitl")
        }
        guard case let .askUser(req)? = HITLPrompt.decode(kind: kind, envelope: hitlEnv) else {
            return XCTFail("expected decoded askUser prompt")
        }
        XCTAssertEqual(req.requestId, "rq1")
        XCTAssertEqual(req.questions.first?.options.first?.id, "a")
        XCTAssertTrue(kind.isBlocking)
    }

    func testApprovalBatchDecodesAndBlocking() {
        let env = envelope(AgentStreamEvent.approvalRequested, payload: [
            "batch_id": "b1",
            "approval_type": "tool_permission",
            "runtime_mode": "interactive",
            "expires_at": 123.0,
            "schema_version": 1,
            "action_requests": [[
                "request_id": "r1", "tool_call_id": "tc1", "tool_name": "Shell",
                "decision_reason": ["type": "user_interactive", "scope": "once"],
                "allowed_scopes": ["once", "thread"],
                "allowed_outcomes": ["allow", "deny"],
                "risk_level": "medium",
            ]],
        ])
        guard case let .hitl(kind, hitlEnv) = decoder.decode(env), kind == .approvalRequested else {
            return XCTFail("expected approvalRequested hitl")
        }
        guard case let .approvalBatch(p)? = HITLPrompt.decode(kind: kind, envelope: hitlEnv) else {
            return XCTFail("expected decoded approvalBatch")
        }
        XCTAssertEqual(p.batchId, "b1")
        XCTAssertEqual(p.actionRequests.first?.toolName, "Shell")
        XCTAssertEqual(HITLPrompt.approvalBatch(p).hitlRequestId, "b1")
    }

    func testRedactedTeamSpaceApprovalDecodesAsWaitingState() {
        let env = envelope(AgentStreamEvent.approvalRequested, payload: [
            "batch_id": "batch-team-redacted",
            "approval_type": "tool_permission",
            "action_requests": [[
                "request_id": "req-team-redacted",
                "tool_call_id": "tc-team-redacted",
                "tool_name": "redacted_tool",
            ]],
            "runtime_mode": "interactive",
            "expires_at": 1_788_888_000.0,
            "details_redacted": true,
            "team_space_execution": [
                "collaboration_space_id": "space-team",
                "execution_space_id": "space-owner",
                "initiator_user_id": "user-member",
                "execution_owner_user_id": "user-owner",
            ],
            "schema_version": 1,
        ])
        guard case let .hitl(kind, hitlEnv) = decoder.decode(env), kind == .approvalRequested else {
            return XCTFail("expected approvalRequested hitl")
        }
        guard case let .approvalBatch(p)? = HITLPrompt.decode(kind: kind, envelope: hitlEnv) else {
            return XCTFail("expected decoded redacted approvalBatch")
        }

        XCTAssertEqual(p.batchId, "batch-team-redacted")
        XCTAssertTrue(p.hasRedactedTeamApprovalDetails)
        XCTAssertEqual(p.actionRequests.count, 1)
        XCTAssertEqual(p.actionRequests.first?.requestId, "req-team-redacted")
        XCTAssertEqual(p.actionRequests.first?.toolCallId, "tc-team-redacted")
        XCTAssertEqual(p.actionRequests.first?.toolName, "redacted_tool")
        XCTAssertNil(p.actionRequests.first?.toolInput)
        XCTAssertEqual(p.actionRequests.first?.allowedScopes, [.once])
        XCTAssertEqual(p.actionRequests.first?.allowedOutcomes, [.allow, .deny])
    }

    func testPlanProposalIsNonBlocking() {
        let env = envelope(AgentStreamEvent.planProposal, payload: [
            "plan_document_id": "doc1",
            "plan_name": "迁移计划",
            "overview": "概览",
            "description_markdown": "## 步骤",
            "todos": [["id": "t1", "content": "做事", "status": "pending"]],
        ])
        guard case let .hitl(kind, hitlEnv) = decoder.decode(env), kind == .planProposal else {
            return XCTFail("expected planProposal hitl")
        }
        XCTAssertFalse(kind.isBlocking)
        guard case let .planProposal(p)? = HITLPrompt.decode(kind: kind, envelope: hitlEnv) else {
            return XCTFail("expected decoded planProposal")
        }
        XCTAssertEqual(p.planDocumentId, "doc1")
        XCTAssertEqual(p.todos.count, 1)
    }

    func testApprovalResolvedBatchId() {
        let env = envelope(AgentStreamEvent.approvalResolved, payload: [
            "batch_id": "b9",
            "schema_version": 1,
            "decisions": [["request_id": "r1", "tool_call_id": "tc1", "outcome": "allow"]],
        ])
        XCTAssertEqual(HITLPrompt.decodeResolvedBatchId(envelope: env), "b9")
    }

    // MARK: - Project HITL access

    func testHITLResolutionAccessDefaultsToResolvableWithoutTeamMetadata() {
        let access = HITLResolutionAccess.resolve(
            envelope: askUserEnvelope(requestId: "personal"),
            currentUserId: nil
        )

        XCTAssertTrue(access.canResolve)
        XCTAssertNil(access.executionOwnerDisplayName)
    }

    func testHITLResolutionAccessAllowsOnlyExecutionOwner() {
        let env = askUserEnvelope(
            requestId: "team-request",
            teamSpaceExecution: [
                "execution_owner_user_id": "user-owner",
                "execution_owner_display_name": "王负责人",
            ]
        )

        let ownerAccess = HITLResolutionAccess.resolve(envelope: env, currentUserId: "user-owner")
        let memberAccess = HITLResolutionAccess.resolve(envelope: env, currentUserId: "user-member")
        let signedOutAccess = HITLResolutionAccess.resolve(envelope: env, currentUserId: nil)

        XCTAssertTrue(ownerAccess.canResolve)
        XCTAssertFalse(memberAccess.canResolve)
        XCTAssertFalse(signedOutAccess.canResolve)
        XCTAssertEqual(memberAccess.executionOwnerDisplayName, "王负责人")
    }

    func testHITLResolutionAccessFailsClosedWhenTeamMetadataIsPresentButInvalid() {
        let corrupt = askUserEnvelope(
            requestId: "corrupt-team",
            teamSpaceExecutionValue: "not-an-object"
        )
        let empty = askUserEnvelope(
            requestId: "empty-team",
            teamSpaceExecution: [:]
        )
        let blankOwner = askUserEnvelope(
            requestId: "blank-owner",
            teamSpaceExecution: ["execution_owner_user_id": "   "]
        )

        XCTAssertFalse(
            HITLResolutionAccess.resolve(envelope: corrupt, currentUserId: "user-owner").canResolve
        )
        XCTAssertFalse(
            HITLResolutionAccess.resolve(envelope: empty, currentUserId: "user-owner").canResolve
        )
        XCTAssertFalse(
            HITLResolutionAccess.resolve(envelope: blankOwner, currentUserId: "user-owner").canResolve
        )
    }

    func testHITLResolutionAccessFailsClosedWhenBackendMarksMissingTeamEnrichment() {
        let env = envelope(AgentStreamEvent.askUserRequired, payload: [
            "request_id": "redaction-required",
            "__team_space_execution_redaction_required": true,
        ])

        let access = HITLResolutionAccess.resolve(
            envelope: env,
            currentUserId: "user-owner"
        )

        XCTAssertFalse(access.canResolve)
        XCTAssertNil(access.executionOwnerDisplayName)
    }

    @MainActor
    func testDetailsRedactedApprovalWithoutTeamMetadataIsReadonlyAndCannotSubmit() async {
        var sentRequests: [HITLOutboundRequest] = []
        let coordinator = HITLCoordinator(
            sessionId: "relay-redacted-approval",
            currentUserIdProvider: { "user-owner" },
            requestSender: { request in
                sentRequests.append(request)
                return .ok(payload: [:])
            }
        )
        let env = envelope(AgentStreamEvent.approvalRequested, payload: [
            "batch_id": "relay-redacted-batch",
            "approval_type": "tool_permission",
            "details_redacted": true,
            "action_requests": [[
                "request_id": "relay-redacted-request",
                "tool_call_id": "relay-redacted-call",
                "tool_name": RedactedApprovalDisplay.toolName,
            ]],
        ])

        XCTAssertFalse(
            HITLResolutionAccess.resolve(
                envelope: env,
                currentUserId: "user-owner"
            ).canResolve
        )
        coordinator.ingest(kind: .approvalRequested, envelope: env)
        await coordinator.submitCapsuleHITLIntent(
            .deny,
            promptId: "approval:relay-redacted-batch"
        )

        XCTAssertEqual(coordinator.pending?.id, "approval:relay-redacted-batch")
        XCTAssertFalse(coordinator.canResolvePending)
        XCTAssertTrue(sentRequests.isEmpty)
        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: coordinator.pending,
                canResolve: coordinator.canResolvePending
            )?.actions.map(\.intent),
            [.openConversation]
        )
    }

    @MainActor
    func testReadonlyRedactedAskUserHydrateRestoresGenericPendingBubble() {
        let coordinator = readonlyCoordinator(sessionId: "redacted-ask-user")

        coordinator.ingest(
            kind: .askUser,
            envelope: redactedHydrateEnvelope(
                event: AgentStreamEvent.askUserRequired,
                requestId: "redacted-ask-user"
            )
        )

        XCTAssertEqual(coordinator.pending?.id, "ask_user:redacted-ask-user")
        XCTAssertFalse(coordinator.canResolvePending)
        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: coordinator.pending,
                canResolve: coordinator.canResolvePending
            )?.actions.map(\.intent),
            [.openConversation]
        )
    }

    @MainActor
    func testReadonlyRedactedAskFormHydrateRestoresGenericPendingBubble() {
        let coordinator = readonlyCoordinator(sessionId: "redacted-ask-form")

        coordinator.ingest(
            kind: .askForm,
            envelope: redactedHydrateEnvelope(
                event: AgentStreamEvent.askFormRequired,
                requestId: "redacted-ask-form"
            )
        )

        XCTAssertEqual(coordinator.pending?.id, "ask_form:redacted-ask-form")
        XCTAssertFalse(coordinator.canResolvePending)
        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: coordinator.pending,
                canResolve: coordinator.canResolvePending
            )?.message,
            L10n.Agent.capsuleHITLWaitingOwnerAnswer
        )
    }

    @MainActor
    func testReadonlyRedactedRequestApprovalHydrateRestoresGenericPendingBubble() {
        let coordinator = readonlyCoordinator(sessionId: "redacted-request-approval")

        coordinator.ingest(
            kind: .requestApproval,
            envelope: redactedHydrateEnvelope(
                event: AgentStreamEvent.requestApprovalRequired,
                requestId: "redacted-request-approval"
            )
        )

        XCTAssertEqual(
            coordinator.pending?.id,
            "request_approval:redacted-request-approval"
        )
        XCTAssertFalse(coordinator.canResolvePending)
        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: coordinator.pending,
                canResolve: coordinator.canResolvePending
            )?.actions.map(\.intent),
            [.openConversation]
        )
    }

    @MainActor
    func testResolvableOrPersonalCroppedHydrateStillRejectsInvalidPayload() {
        let owner = HITLCoordinator(
            sessionId: "owner-cropped",
            currentUserIdProvider: { "user-owner" }
        )
        owner.ingest(
            kind: .askUser,
            envelope: redactedHydrateEnvelope(
                event: AgentStreamEvent.askUserRequired,
                requestId: "owner-cropped"
            )
        )

        let personal = HITLCoordinator(sessionId: "personal-cropped")
        personal.ingest(
            kind: .askUser,
            envelope: envelope(AgentStreamEvent.askUserRequired, payload: [
                "request_id": "personal-cropped",
                "message_id": "message-personal-cropped",
            ])
        )

        XCTAssertNil(owner.pending)
        XCTAssertNil(personal.pending)
    }

    @MainActor
    func testCoordinatorUpgradesRedactedApprovalWhenFullPayloadArrivesLater() {
        let coordinator = HITLCoordinator(
            sessionId: "redacted-then-full",
            currentUserIdProvider: { "user-owner" }
        )

        coordinator.ingest(
            kind: .approvalRequested,
            envelope: redactedApprovalEnvelope(batchId: "same-batch")
        )
        XCTAssertEqual(pendingApprovalToolName(coordinator), RedactedApprovalDisplay.toolName)

        coordinator.ingest(
            kind: .approvalRequested,
            envelope: approvalEnvelope(
                batchId: "same-batch",
                teamSpaceExecution: teamMetadata
            )
        )

        XCTAssertEqual(pendingApprovalToolName(coordinator), "Shell")
        XCTAssertTrue(coordinator.canResolvePending)
    }

    @MainActor
    func testCoordinatorDoesNotDowngradeFullApprovalWhenRedactedPayloadArrivesLater() {
        let coordinator = HITLCoordinator(
            sessionId: "full-then-redacted",
            currentUserIdProvider: { "user-owner" }
        )

        coordinator.ingest(
            kind: .approvalRequested,
            envelope: approvalEnvelope(
                batchId: "same-batch",
                teamSpaceExecution: teamMetadata
            )
        )
        coordinator.ingest(
            kind: .approvalRequested,
            envelope: redactedApprovalEnvelope(batchId: "same-batch")
        )

        XCTAssertEqual(pendingApprovalToolName(coordinator), "Shell")
        XCTAssertTrue(coordinator.canResolvePending)
    }

    @MainActor
    func testReadonlyCoordinatorNeverSendsUserResponse() async {
        var sentRequests: [HITLOutboundRequest] = []
        let coordinator = HITLCoordinator(
            sessionId: "readonly-submit",
            currentUserIdProvider: { "user-member" },
            requestSender: { request in
                sentRequests.append(request)
                return .ok(payload: [:])
            }
        )
        coordinator.ingest(
            kind: .askUser,
            envelope: askUserEnvelope(
                requestId: "readonly-ask",
                teamSpaceExecution: teamMetadata
            )
        )

        await coordinator.submitAskUser(
            [
                AskUserAnswerInput(
                    questionId: "q1",
                    selectedOptions: ["a"],
                    freeText: nil
                ),
            ],
            requestId: "readonly-ask"
        )
        await coordinator.skipAskUser(requestId: "readonly-ask")

        XCTAssertTrue(sentRequests.isEmpty)
        XCTAssertEqual(coordinator.pending?.id, "ask_user:readonly-ask")
        XCTAssertFalse(coordinator.isSubmitting)
    }

    @MainActor
    func testCoordinatorAppliesReadOnlyAccessToAllBlockingHITLKinds() {
        let coordinator = HITLCoordinator(
            sessionId: "team-hitl",
            currentUserIdProvider: { "user-member" }
        )
        let teamMetadata: [String: Any] = [
            "execution_owner_user_id": "user-owner",
            "execution_owner_display_name": "Owner User",
        ]
        let requests: [(HITLKind, WSEnvelope, String)] = [
            (
                .askUser,
                askUserEnvelope(
                    requestId: "ask-1",
                    teamSpaceExecution: teamMetadata
                ),
                "ask_user:ask-1"
            ),
            (
                .askForm,
                askFormEnvelope(
                    requestId: "form-1",
                    teamSpaceExecution: teamMetadata
                ),
                "ask_form:form-1"
            ),
            (
                .requestApproval,
                requestApprovalEnvelope(
                    requestId: "permission-1",
                    teamSpaceExecution: teamMetadata
                ),
                "request_approval:permission-1"
            ),
            (
                .approvalRequested,
                approvalEnvelope(
                    batchId: "approval-1",
                    teamSpaceExecution: teamMetadata
                ),
                "approval:approval-1"
            ),
        ]

        for (kind, env, expectedId) in requests {
            coordinator.ingest(kind: kind, envelope: env)
            XCTAssertEqual(coordinator.pending?.id, expectedId)
            XCTAssertFalse(coordinator.canResolvePending)
            XCTAssertEqual(coordinator.pendingExecutionOwnerDisplayName, "Owner User")
            coordinator.dismiss()
        }
    }

    @MainActor
    func testCoordinatorKeepsAccessBoundToQueuedPrompt() {
        let coordinator = HITLCoordinator(
            sessionId: "mixed-hitl",
            currentUserIdProvider: { "user-member" }
        )
        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "personal"))
        coordinator.ingest(
            kind: .askUser,
            envelope: askUserEnvelope(
                requestId: "team",
                teamSpaceExecution: ["execution_owner_user_id": "user-owner"]
            )
        )

        XCTAssertTrue(coordinator.canResolvePending)
        coordinator.dismiss()
        XCTAssertEqual(coordinator.pending?.id, "ask_user:team")
        XCTAssertFalse(coordinator.canResolvePending)
    }

    // MARK: - coordinator queue

    @MainActor
    func testCoordinatorQueuesBlockingPromptsInArrivalOrder() {
        let coordinator = HITLCoordinator(sessionId: "queue-session")

        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "rq1"))
        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "rq2"))

        XCTAssertEqual(coordinator.pending?.id, "ask_user:rq1")
        XCTAssertEqual(coordinator.pendingCount, 2)
        XCTAssertEqual(coordinator.additionalPendingCount, 1)

        coordinator.dismiss()

        XCTAssertEqual(coordinator.pending?.id, "ask_user:rq2")
        XCTAssertEqual(coordinator.pendingCount, 1)
    }

    @MainActor
    func testCoordinatorDeduplicatesRepeatedPrompt() {
        let coordinator = HITLCoordinator(sessionId: "dedupe-session")
        let repeated = askUserEnvelope(requestId: "same-request")

        coordinator.ingest(kind: .askUser, envelope: repeated)
        coordinator.ingest(kind: .askUser, envelope: repeated)

        XCTAssertEqual(coordinator.pending?.id, "ask_user:same-request")
        XCTAssertEqual(coordinator.pendingCount, 1)
    }

    @MainActor
    func testCoordinatorDoesNotReopenResolvedAskUserFromLateStream() async {
        let coordinator = HITLCoordinator(
            sessionId: "late-stream-session",
            requestSender: { _ in .ok(payload: [:]) }
        )
        let delayed = askUserEnvelope(requestId: "late-request")

        coordinator.ingest(kind: .askUser, envelope: delayed)
        await coordinator.skipAskUser(requestId: "late-request")
        XCTAssertNil(coordinator.pending)

        coordinator.ingest(kind: .askUser, envelope: delayed)

        XCTAssertNil(coordinator.pending)
        XCTAssertEqual(coordinator.pendingCount, 0)
    }

    @MainActor
    func testCoordinatorTerminalBeforeRequiredPreventsAskUserFromOpening() {
        let coordinator = HITLCoordinator(sessionId: "terminal-first-session")
        coordinator.ingest(
            kind: .singleHitlResolved,
            envelope: envelope(AgentStreamEvent.singleHitlResolved, payload: [
                "request_id": "terminal-first-request",
                "outcome": "skipped",
            ])
        )

        coordinator.ingest(
            kind: .askUser,
            envelope: askUserEnvelope(requestId: "terminal-first-request")
        )

        XCTAssertNil(coordinator.pending)
        XCTAssertEqual(coordinator.pendingCount, 0)
    }

    @MainActor
    func testCoordinatorCanResolveQueuedPromptWithoutReplacingCurrent() {
        let coordinator = HITLCoordinator(sessionId: "resolved-session")

        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "rq-current"))
        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "rq-queued"))
        coordinator.dismissResolvedInteraction(
            kind: "ask_choice",
            threadId: "chat-session-resolved-session",
            requestKey: "rq-queued"
        )

        XCTAssertEqual(coordinator.pending?.id, "ask_user:rq-current")
        XCTAssertEqual(coordinator.pendingCount, 1)
    }

    @MainActor
    func testCoordinatorAdvancesWhenCurrentPromptResolvesOnAnotherDevice() {
        let coordinator = HITLCoordinator(sessionId: "remote-session")

        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "rq-current"))
        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "rq-next"))
        coordinator.dismissResolvedInteraction(
            kind: "ask_choice",
            threadId: "chat-session-remote-session",
            requestKey: "rq-current"
        )

        XCTAssertEqual(coordinator.pending?.id, "ask_user:rq-next")
        XCTAssertEqual(coordinator.pendingCount, 1)
    }

    // MARK: - pending interaction HTTP restore order

    func testPendingInteractionDecodesCreatedAt() throws {
        let interaction = try pendingInteraction(
            id: "interaction-created-at",
            requestKey: "request-created-at",
            createdAt: 1_700_000_000_123,
            expiresAt: 1_800_000_000_000
        )

        XCTAssertEqual(interaction.createdAt, 1_700_000_000_123)
    }

    func testPendingInteractionRestoreUsesCreatedAtFIFOInsteadOfExpiry() throws {
        let firstCreated = try pendingInteraction(
            id: "interaction-first",
            requestKey: "request-first",
            createdAt: 100,
            expiresAt: 9_000
        )
        let secondCreatedButSoonerExpiry = try pendingInteraction(
            id: "interaction-second",
            requestKey: "request-second",
            createdAt: 200,
            expiresAt: 1_000
        )

        let restored = PendingInteraction.fifoOrdered([
            secondCreatedButSoonerExpiry,
            firstCreated,
        ])

        XCTAssertEqual(restored.map(\.requestKey), ["request-first", "request-second"])
    }

    func testPendingInteractionRestoreOrderIsDeterministicForCreatedAtTies() throws {
        let alpha = try pendingInteraction(
            id: "interaction-alpha",
            requestKey: "alpha",
            createdAt: 100,
            expiresAt: nil
        )
        let beta = try pendingInteraction(
            id: "interaction-beta",
            requestKey: "beta",
            createdAt: 100,
            expiresAt: nil
        )

        XCTAssertEqual(
            PendingInteraction.fifoOrdered([beta, alpha]).map(\.requestKey),
            ["alpha", "beta"]
        )
        XCTAssertEqual(
            PendingInteraction.fifoOrdered([alpha, beta]).map(\.requestKey),
            ["alpha", "beta"]
        )
    }

    // MARK: - HITL presentation parity

    func testAskUserOtherRequiresCustomAnswerAndOrdinaryChoiceDropsHiddenText() {
        let question = AskUserRequestQuestionsItem(
            id: "q1",
            prompt: "选择实现",
            header: "方案",
            options: [
                AskUserRequestQuestionsItemOptionsItem(
                    id: "fast",
                    label: "快速",
                    description: "快速实现"
                ),
                AskUserRequestQuestionsItemOptionsItem(
                    id: AskUserAnswerDraft.otherOptionId,
                    label: "Other",
                    description: "Custom"
                ),
            ],
            allowMultiple: false,
            allowFreeText: true
        )

        XCTAssertFalse(AskUserAnswerDraft.canSubmit(
            question: question,
            selected: [AskUserAnswerDraft.otherOptionId],
            freeText: "   "
        ))
        XCTAssertTrue(AskUserAnswerDraft.canSubmit(
            question: question,
            selected: [AskUserAnswerDraft.otherOptionId],
            freeText: "自定义方案"
        ))

        let ordinary = AskUserAnswerDraft.answer(
            question: question,
            selected: ["fast"],
            freeText: "之前输入但当前已隐藏"
        )
        XCTAssertEqual(ordinary.selectedOptions, ["fast"])
        XCTAssertNil(ordinary.freeText)

        let custom = AskUserAnswerDraft.answer(
            question: question,
            selected: [AskUserAnswerDraft.otherOptionId],
            freeText: "  自定义方案  "
        )
        XCTAssertEqual(custom.freeText, "自定义方案")
    }

    func testAskUserMultiSelectionUsesServerOptionOrder() {
        let question = AskUserRequestQuestionsItem(
            id: "q1",
            prompt: "选择功能",
            header: "",
            options: [
                AskUserRequestQuestionsItemOptionsItem(id: "a", label: "A", description: ""),
                AskUserRequestQuestionsItemOptionsItem(id: "b", label: "B", description: ""),
                AskUserRequestQuestionsItemOptionsItem(id: "c", label: "C", description: ""),
            ],
            allowMultiple: true,
            allowFreeText: false
        )

        XCTAssertEqual(
            AskUserAnswerDraft.answer(
                question: question,
                selected: ["c", "a", "b"],
                freeText: ""
            ).selectedOptions,
            ["a", "b", "c"]
        )
    }

    func testApprovalPresentationBuildsStructuredRowsWithoutRawJSON() {
        let input = JSONValue.object([
            "command": .string("git status"),
            "path": .string("/tmp/project"),
            "explanation": .string("检查工作区状态"),
            "headers": .object([
                "accept": .string("application/json"),
                "trace": .bool(true),
            ]),
        ])

        XCTAssertEqual(ApprovalPresentation.explanation(from: input), "检查工作区状态")
        let rows = ApprovalPresentation.parameterRows(from: input)
        XCTAssertEqual(rows.map(\.label), ["命令", "路径", "headers"])
        XCTAssertEqual(rows[0].value, "git status")
        XCTAssertEqual(rows[1].style, .path)
        XCTAssertEqual(rows[2].value, "accept：application/json；trace：是")
        XCTAssertFalse(rows.map(\.value).joined().contains("{"))
        XCTAssertFalse(rows.map(\.value).joined().contains("\""))
    }

    func testApprovalRiskDetailIncludesWorkspaceImpact() {
        XCTAssertEqual(
            ApprovalPresentation.riskDetail(level: .high, workspaceZone: "sensitive"),
            "高风险：可能产生不可逆或敏感影响，请仔细核对。 将触达受保护资源。"
        )
        XCTAssertEqual(
            ApprovalPresentation.riskDetail(level: .medium, workspaceZone: "outside"),
            "需留意：此操作会修改状态或访问受限资源。 目标位于当前工作区之外。"
        )
        XCTAssertNil(
            ApprovalPresentation.riskDetail(level: nil, workspaceZone: "sensitive"),
            "Wire 未提供风险等级时，不应仅凭工作区区域伪造风险提示"
        )
    }

    // MARK: - 审批展示策略（S1–S5，与 Android 必须逐条对齐）

    /// S1：`cwd` 这类「在哪执行」不能掉进按字母序排的未知字段，必须作为「目录」排在「路径」之后。
    func testApprovalPresentationPromotesWorkingDirectoryToNamedField() {
        for key in ["cwd", "working_dir", "workdir", "directory", "dir"] {
            let rows = ApprovalPresentation.parameterRows(from: .object([key: .string("/tmp/project")]))
            XCTAssertEqual(rows.map(\.label), ["目录"], "\(key) 应归入「目录」字段组")
            XCTAssertEqual(rows.first?.style, .path)
        }

        let ordered = ApprovalPresentation.parameterRows(from: .object([
            "cwd": .string("/tmp/project"),
            "path": .string("/tmp/project/a.swift"),
            "command": .string("swift build"),
        ]))
        XCTAssertEqual(ordered.map(\.label), ["命令", "路径", "目录"])
    }

    /// S2：命令独立成块，主区最多两条已知语义字段，其余一律进折叠区。
    func testApprovalLayoutSplitsCommandPrimaryAndCollapsedRows() {
        let shellCall = ApprovalPresentation.layout(from: .object([
            "command": .string("pnpm install"),
            "cwd": .string("/tmp/project"),
            "timeout": .int(120),
        ]))
        XCTAssertEqual(shellCall.command?.label, "命令")
        XCTAssertEqual(shellCall.command?.value, "pnpm install")
        XCTAssertEqual(shellCall.primaryRows.map(\.label), ["目录"])
        XCTAssertEqual(shellCall.collapsedRows.map(\.label), ["timeout"])

        let readFile = ApprovalPresentation.layout(from: .object([
            "path": .string("/tmp/a.swift"),
            "explanation": .string("读取实现"),
        ]))
        XCTAssertNil(readFile.command)
        XCTAssertEqual(readFile.primaryRows.map(\.label), ["路径"])
        XCTAssertTrue(
            readFile.collapsedRows.isEmpty,
            "explanation 已由 parameterRows 排除，不应作为参数行泄漏到折叠区"
        )

        // 未知字段按 key 字母序展开（headers < method），主区只留已知语义字段。
        let fetch = ApprovalPresentation.layout(from: .object([
            "url": .string("https://example.com"),
            "method": .string("GET"),
            "headers": .string("accept: */*"),
        ]))
        XCTAssertNil(fetch.command)
        XCTAssertEqual(fetch.primaryRows.map(\.label), ["地址"])
        XCTAssertEqual(fetch.collapsedRows.map(\.label), ["headers", "method"])

        let overflow = ApprovalPresentation.layout(from: .object([
            "command": .string("rm -rf build"),
            "path": .string("/tmp/build"),
            "cwd": .string("/tmp"),
            "foo": .string("bar"),
        ]))
        XCTAssertEqual(overflow.command?.value, "rm -rf build")
        XCTAssertEqual(overflow.primaryRows.map(\.label), ["路径", "目录"])
        XCTAssertEqual(overflow.collapsedRows.map(\.label), ["foo"])

        let empty = ApprovalPresentation.layout(from: .object([:]))
        XCTAssertNil(empty.command)
        XCTAssertTrue(empty.primaryRows.isEmpty)
        XCTAssertTrue(empty.collapsedRows.isEmpty)

        let missing = ApprovalPresentation.layout(from: nil)
        XCTAssertNil(missing.command)
        XCTAssertTrue(missing.primaryRows.isEmpty)
        XCTAssertTrue(missing.collapsedRows.isEmpty)
    }

    /// S3：普通低风险不占一行「安全」小字；越界或触达敏感资源时仍需提醒。
    func testApprovalRiskHintOnlySurfacesWhenItChangesTheDecision() {
        let high = ApprovalPresentation.riskHint(level: .high, workspaceZone: nil)
        XCTAssertEqual(high?.emphasis, .critical)
        XCTAssertEqual(high?.text, ApprovalPresentation.riskDetail(level: .high, workspaceZone: nil))

        let highSensitive = ApprovalPresentation.riskHint(level: .high, workspaceZone: "sensitive")
        XCTAssertEqual(highSensitive?.emphasis, .critical)
        XCTAssertEqual(
            highSensitive?.text,
            ApprovalPresentation.riskDetail(level: .high, workspaceZone: "sensitive")
        )

        XCTAssertEqual(
            ApprovalPresentation.riskHint(level: .medium, workspaceZone: "sensitive")?.emphasis,
            .warning
        )
        XCTAssertEqual(
            ApprovalPresentation.riskHint(level: .medium, workspaceZone: "outside")?.emphasis,
            .warning
        )
        XCTAssertNil(ApprovalPresentation.riskHint(level: .medium, workspaceZone: nil))
        XCTAssertNil(ApprovalPresentation.riskHint(level: .medium, workspaceZone: "inside"))
        XCTAssertEqual(
            ApprovalPresentation.riskHint(level: nil, workspaceZone: "sensitive")?.emphasis,
            .warning
        )
        XCTAssertEqual(
            ApprovalPresentation.riskHint(level: nil, workspaceZone: "outside")?.emphasis,
            .warning
        )
        XCTAssertEqual(
            ApprovalPresentation.riskHint(level: .low, workspaceZone: "sensitive")?.emphasis,
            .warning
        )
        XCTAssertEqual(
            ApprovalPresentation.riskHint(level: .low, workspaceZone: "outside")?.emphasis,
            .warning
        )
        XCTAssertNil(ApprovalPresentation.riskHint(level: .low, workspaceZone: nil))
        XCTAssertNil(ApprovalPresentation.riskHint(level: nil, workspaceZone: nil))
    }

    /// S3 配套：工作区归属只认明确越界 / 敏感资源，其余保持 nil，不臆造风险。
    func testApprovalWorkspaceZoneOnlyFlagsExplicitBoundaryCrossings() {
        XCTAssertEqual(
            ApprovalPresentation.workspaceZone(for: .workspaceOut(.init(
                type: "workspace_out", path: "/etc", kind: .path
            ))),
            "outside"
        )
        XCTAssertEqual(
            ApprovalPresentation.workspaceZone(for: .sensitiveInAsk(.init(
                type: "sensitive_in_ask", path: "~/.ssh", category: "credentials"
            ))),
            "sensitive"
        )
        XCTAssertNil(ApprovalPresentation.workspaceZone(for: Self.interactiveReason))
    }

    /// S4：手机上单手误触代价高——只有单条、非高风险、工作区内才允许 Dock 一键放行。
    func testDockDirectApprovalOnlyForSingleLowStakesAction() {
        XCTAssertTrue(ApprovalDockPolicy.allowsDirectApproval([
            Self.approvalAction(requestId: "a", riskLevel: .low),
        ]))
        XCTAssertTrue(ApprovalDockPolicy.allowsDirectApproval([
            Self.approvalAction(requestId: "a", riskLevel: .medium),
        ]))
        XCTAssertFalse(ApprovalDockPolicy.allowsDirectApproval([
            Self.approvalAction(requestId: "a", riskLevel: .high),
        ]))
        XCTAssertFalse(ApprovalDockPolicy.allowsDirectApproval([
            Self.approvalAction(requestId: "a", riskLevel: .low, reason: .workspaceOut(.init(
                type: "workspace_out", path: "/etc", kind: .path
            ))),
        ]))
        XCTAssertFalse(ApprovalDockPolicy.allowsDirectApproval([
            Self.approvalAction(requestId: "a", riskLevel: .low, reason: .sensitiveInAsk(.init(
                type: "sensitive_in_ask", path: "~/.ssh", category: "credentials"
            ))),
        ]))
        XCTAssertFalse(ApprovalDockPolicy.allowsDirectApproval([
            Self.approvalAction(requestId: "a", riskLevel: .low),
            Self.approvalAction(requestId: "b", riskLevel: .low),
        ]))
        XCTAssertFalse(ApprovalDockPolicy.allowsDirectApproval([]))
    }

    /// 胶囊气泡只把现有 Dock 已允许的一键能力搬到工作台现场；提交 scope 仍取服务端交集的最小值。
    func testCapsuleBubbleProjectsLowStakesApprovalIntoRealDecisionIntents() {
        let request = ApprovalRequested(
            batchId: "bubble-approval",
            approvalType: "tool_permission",
            actionRequests: [
                Self.approvalAction(requestId: "action-1", riskLevel: .low),
            ],
            runtimeMode: .interactive,
            expiresAt: 0,
            schemaVersion: 1
        )

        let bubble = CapsuleHITLBubbleProjection.presentation(
            for: .approvalBatch(request),
            canResolve: true
        )

        XCTAssertEqual(bubble?.kind, .approval)
        XCTAssertEqual(
            bubble?.actions.map(\.intent),
            [.approve(scope: "once"), .deny, .openConversation]
        )
        XCTAssertEqual(
            bubble?.actions.map(\.title),
            [
                L10n.Agent.capsuleHITLApprove,
                L10n.Agent.capsuleHITLDeny,
                L10n.Agent.capsuleHITLViewDetails,
            ]
        )
    }

    func testCapsuleBubbleApprovalAlwaysUsesLeastPrivilegedCommonScope() {
        let request = ApprovalRequested(
            batchId: "least-privilege",
            approvalType: "tool_permission",
            actionRequests: [
                Self.approvalAction(
                    requestId: "action",
                    riskLevel: .low,
                    allowedScopes: [.once, .thread, .always],
                    suggestedScope: .thread
                ),
            ],
            runtimeMode: .interactive,
            expiresAt: 0,
            schemaVersion: 1
        )

        let approve = CapsuleHITLBubbleProjection.presentation(
            for: .approvalBatch(request),
            canResolve: true
        )?.actions.first?.intent

        XCTAssertEqual(approve, .approve(scope: "once"))
    }

    func testCapsuleBubbleDoesNotInventApprovalScopeWhenServerAllowsNone() {
        let request = ApprovalRequested(
            batchId: "no-scope",
            approvalType: "tool_permission",
            actionRequests: [
                Self.approvalAction(
                    requestId: "action",
                    riskLevel: .low,
                    allowedScopes: []
                ),
            ],
            runtimeMode: .interactive,
            expiresAt: 0,
            schemaVersion: 1
        )

        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: .approvalBatch(request),
                canResolve: true
            )?.actions.map(\.intent),
            [.deny, .openConversation]
        )
    }

    /// 高风险 / 批量不绕过完整审批面板，但拒绝仍是协议已有的安全终止动作。
    func testCapsuleBubbleDoesNotDirectlyApproveHighRiskOrBatchRequests() {
        let highRisk = ApprovalRequested(
            batchId: "high-risk",
            approvalType: "tool_permission",
            actionRequests: [
                Self.approvalAction(requestId: "danger", riskLevel: .high),
            ],
            runtimeMode: .interactive,
            expiresAt: 0,
            schemaVersion: 1
        )
        let batch = ApprovalRequested(
            batchId: "batch",
            approvalType: "tool_permission",
            actionRequests: [
                Self.approvalAction(requestId: "a", riskLevel: .low),
                Self.approvalAction(requestId: "b", riskLevel: .low),
            ],
            runtimeMode: .interactive,
            expiresAt: 0,
            schemaVersion: 1
        )

        for request in [highRisk, batch] {
            XCTAssertEqual(
                CapsuleHITLBubbleProjection.presentation(
                    for: .approvalBatch(request),
                    canResolve: true
                )?.actions.map(\.intent),
                [.deny, .openConversation]
            )
        }
    }

    func testCapsuleBubbleNeverOffersSubmissionToReadonlyMember() {
        let request = ApprovalRequested(
            batchId: "readonly",
            approvalType: "tool_permission",
            actionRequests: [
                Self.approvalAction(requestId: "a", riskLevel: .low),
            ],
            runtimeMode: .interactive,
            expiresAt: 0,
            schemaVersion: 1
        )

        let bubble = CapsuleHITLBubbleProjection.presentation(
            for: .approvalBatch(request),
            canResolve: false
        )

        XCTAssertEqual(bubble?.actions.map(\.intent), [.openConversation])
        XCTAssertEqual(bubble?.message, L10n.Agent.capsuleHITLWaitingOwnerApproval)
    }

    @MainActor
    func testCapsuleBubbleProjectsAndSubmitsRequestApprovalThroughExistingAction() async {
        var sentRequests: [HITLOutboundRequest] = []
        let coordinator = HITLCoordinator(
            sessionId: "request-approval-bubble",
            requestSender: { request in
                sentRequests.append(request)
                return .ok(payload: [:])
            }
        )
        coordinator.ingest(
            kind: .requestApproval,
            envelope: requestApprovalEnvelope(requestId: "request-approval", riskLevel: "safe")
        )
        guard let prompt = coordinator.pending,
              let bubble = CapsuleHITLBubbleProjection.presentation(for: prompt, canResolve: true) else {
            return XCTFail("expected request approval bubble")
        }

        XCTAssertEqual(
            bubble.actions.map(\.intent),
            [.approveRequest, .denyRequest, .openConversation]
        )
        await coordinator.submitCapsuleHITLIntent(.approveRequest, promptId: bubble.id)

        let response = sentRequests.first?.payload["response"] as? [String: Any]
        XCTAssertEqual(response?["approved"] as? Bool, true)
    }

    func testCapsuleBubbleDoesNotDirectlyApproveReviewOrHighRequestApproval() {
        for riskLevel in [RequestApprovalRequestRiskLevel.review, .high] {
            let request = RequestApprovalRequest(
                requestId: "request-\(riskLevel.rawValue)",
                toolName: "request_approval",
                title: "确认执行",
                rationale: "将修改外部数据",
                riskLevel: riskLevel,
                interactionType: "ask_user",
                blockingPolicy: "hard",
                intent: "approve",
                formMode: "approval"
            )

            XCTAssertEqual(
                CapsuleHITLBubbleProjection.presentation(
                    for: .requestApproval(request),
                    canResolve: true
                )?.actions.map(\.intent),
                [.denyRequest, .openConversation]
            )
        }
    }

    @MainActor
    func testCapsuleCoordinatorRejectsForgedHighRiskRequestApprovalIntent() async {
        var sentRequests: [HITLOutboundRequest] = []
        let coordinator = HITLCoordinator(
            sessionId: "high-risk-request-approval",
            requestSender: { request in
                sentRequests.append(request)
                return .ok(payload: [:])
            }
        )
        coordinator.ingest(
            kind: .requestApproval,
            envelope: requestApprovalEnvelope(requestId: "high-risk")
        )

        await coordinator.submitCapsuleHITLIntent(
            .approveRequest,
            promptId: "request_approval:high-risk"
        )

        XCTAssertTrue(sentRequests.isEmpty)
        XCTAssertEqual(coordinator.pending?.id, "request_approval:high-risk")
    }

    func testCapsuleBubbleProjectsSingleChoiceOptionsIntoExistingAskAnswerIntent() {
        let request = AskUserRequest(
            requestId: "choice",
            toolName: "ask_user",
            title: "展示方式",
            questions: [
                AskUserRequestQuestionsItem(
                    id: "billing",
                    prompt: "定价按什么周期展示？",
                    header: "定价",
                    options: [
                        .init(id: "month", label: "月付", description: ""),
                        .init(id: "year", label: "年付", description: ""),
                    ],
                    allowMultiple: false,
                    allowFreeText: false
                ),
            ],
            interactionType: "choice",
            blockingPolicy: "blocking",
            intent: "clarify",
            formMode: "single"
        )

        let bubble = CapsuleHITLBubbleProjection.presentation(
            for: .askUser(request),
            canResolve: true
        )

        XCTAssertEqual(bubble?.kind, .choice)
        XCTAssertEqual(bubble?.message, "定价按什么周期展示？")
        XCTAssertEqual(
            bubble?.actions.map(\.intent),
            [
                .answer(questionId: "billing", optionId: "month"),
                .answer(questionId: "billing", optionId: "year"),
            ]
        )
    }

    func testCapsuleBubbleRoutesComplexAskUserToConversationWithoutPartialSubmission() {
        let question = AskUserRequestQuestionsItem(
            id: "multi",
            prompt: "选择要保留的栏目",
            header: "栏目",
            options: [
                .init(id: "price", label: "价格", description: ""),
                .init(id: "rating", label: "评分", description: ""),
            ],
            allowMultiple: true,
            allowFreeText: false
        )
        let request = AskUserRequest(
            requestId: "complex",
            toolName: "ask_user",
            questions: [question],
            interactionType: "choice",
            blockingPolicy: "blocking",
            intent: "clarify",
            formMode: "multi"
        )

        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: .askUser(request),
                canResolve: true
            )?.actions.map(\.intent),
            [.openConversation]
        )
        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: .askUser(request),
                canResolve: false
            )?.actions.map(\.intent),
            [.openConversation]
        )
    }

    func testCapsuleBubbleDoesNotOfferQuickOptionsWhenAskAllowsFreeText() {
        let request = AskUserRequest(
            requestId: "free-text",
            toolName: "ask_user",
            questions: [
                AskUserRequestQuestionsItem(
                    id: "q",
                    prompt: "给一个方向",
                    header: "方向",
                    options: [.init(id: "known", label: "现有方案", description: "")],
                    allowMultiple: false,
                    allowFreeText: true
                ),
            ],
            interactionType: "choice",
            blockingPolicy: "blocking",
            intent: "clarify",
            formMode: "single"
        )

        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: .askUser(request),
                canResolve: true
            )?.actions.map(\.intent),
            [.openConversation]
        )
    }

    func testCapsuleBubbleRoutesLargeChoiceSetToConversationInsteadOfTruncating() {
        let request = AskUserRequest(
            requestId: "many-options",
            toolName: "ask_user",
            questions: [
                AskUserRequestQuestionsItem(
                    id: "q",
                    prompt: "选择一种方案",
                    header: "方案",
                    options: (1...5).map {
                        .init(id: "option-\($0)", label: "方案 \($0)", description: "")
                    },
                    allowMultiple: false,
                    allowFreeText: false
                ),
            ],
            interactionType: "choice",
            blockingPolicy: "blocking",
            intent: "clarify",
            formMode: "single"
        )

        XCTAssertEqual(
            CapsuleHITLBubbleProjection.presentation(
                for: .askUser(request),
                canResolve: true
            )?.actions.map(\.intent),
            [.openConversation]
        )
    }

    @MainActor
    func testCapsuleCoordinatorRejectsForgedQuickAnswerForLargeChoiceSet() async {
        var sentRequests: [HITLOutboundRequest] = []
        let coordinator = HITLCoordinator(
            sessionId: "large-choice-defense",
            requestSender: { request in
                sentRequests.append(request)
                return .ok(payload: [:])
            }
        )
        coordinator.ingest(
            kind: .askUser,
            envelope: envelope(AgentStreamEvent.askUserRequired, payload: [
                "request_id": "large-choice",
                "tool_name": "ask_user",
                "interaction_type": "choice",
                "blocking_policy": "blocking",
                "intent": "clarify",
                "form_mode": "single",
                "questions": [[
                    "id": "q",
                    "prompt": "选择一种方案",
                    "header": "方案",
                    "options": (1...5).map { [
                        "id": "option-\($0)",
                        "label": "方案 \($0)",
                        "description": "",
                    ] },
                    "allow_multiple": false,
                    "allow_free_text": false,
                ]],
            ])
        )

        await coordinator.submitCapsuleHITLIntent(
            .answer(questionId: "q", optionId: "option-1"),
            promptId: "ask_user:large-choice"
        )

        XCTAssertTrue(sentRequests.isEmpty)
        XCTAssertEqual(coordinator.pending?.id, "ask_user:large-choice")
    }

    func testCapsuleBubbleRoutesAskFormToConversationWithFormSummary() {
        let envelope = askFormEnvelope(
            requestId: "bubble-form",
            teamSpaceExecution: [:]
        )
        guard case let .askForm(request)? = HITLPrompt.decode(
            kind: .askForm,
            envelope: envelope
        ) else {
            return XCTFail("expected ask form prompt")
        }

        let bubble = CapsuleHITLBubbleProjection.presentation(
            for: .askForm(request),
            canResolve: true
        )

        XCTAssertEqual(bubble?.kind, .choice)
        XCTAssertEqual(bubble?.message, "补充资料\n姓名")
        XCTAssertEqual(bubble?.actions.map(\.intent), [.openConversation])
        XCTAssertEqual(
            bubble?.actions.map(\.title),
            [L10n.Agent.capsuleHITLAnswerInConversation]
        )
    }

    @MainActor
    func testCapsuleChoiceIntentUsesExistingAskUserWireAction() async {
        var sentRequests: [HITLOutboundRequest] = []
        let coordinator = HITLCoordinator(
            sessionId: "bubble-choice",
            requestSender: { request in
                sentRequests.append(request)
                return .ok(payload: [:])
            }
        )
        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "bubble-request"))
        guard let prompt = coordinator.pending,
              let bubble = CapsuleHITLBubbleProjection.presentation(
                for: prompt,
                canResolve: coordinator.canResolvePending
              ),
              let choice = bubble.actions.first?.intent else {
            return XCTFail("expected quick choice action")
        }

        await coordinator.submitCapsuleHITLIntent(choice, promptId: bubble.id)

        XCTAssertEqual(sentRequests.count, 1)
        XCTAssertEqual(sentRequests.first?.type, "localrt.user_response")
        XCTAssertEqual(sentRequests.first?.payload["request_id"] as? String, "bubble-request")
        let response = sentRequests.first?.payload["response"] as? [String: Any]
        let answers = response?["answers"] as? [[String: Any]]
        XCTAssertEqual(answers?.first?["question_id"] as? String, "q1")
        XCTAssertEqual(answers?.first?["selected_options"] as? [String], ["a"])
    }

    @MainActor
    func testCapsuleApprovalIntentUsesExistingApprovalBatchWireAction() async {
        var sentRequests: [HITLOutboundRequest] = []
        let coordinator = HITLCoordinator(
            sessionId: "bubble-approval",
            requestSender: { request in
                sentRequests.append(request)
                return .ok(payload: [:])
            }
        )
        coordinator.ingest(
            kind: .approvalRequested,
            envelope: approvalEnvelope(
                batchId: "bubble-batch",
                riskLevel: "low"
            )
        )
        guard let prompt = coordinator.pending,
              let bubble = CapsuleHITLBubbleProjection.presentation(
                for: prompt,
                canResolve: coordinator.canResolvePending
              ),
              let approval = bubble.actions.first(where: {
                if case .approve = $0.intent { return true }
                return false
              })?.intent else {
            return XCTFail("expected direct approval action")
        }

        await coordinator.submitCapsuleHITLIntent(approval, promptId: bubble.id)

        XCTAssertEqual(sentRequests.count, 1)
        XCTAssertEqual(sentRequests.first?.type, "localrt.user_response")
        let response = sentRequests.first?.payload["response"] as? [String: Any]
        let decisions = response?["decisions"] as? [[String: Any]]
        XCTAssertEqual(decisions?.first?["outcome"] as? String, "allow")
        XCTAssertEqual(decisions?.first?["scope"] as? String, "once")
    }

    @MainActor
    func testCapsuleSubmissionStaysVisibleOnRetryableErrorAndCanRetry() async {
        var attempts = 0
        let coordinator = HITLCoordinator(
            sessionId: "bubble-retry",
            requestSender: { _ in
                attempts += 1
                if attempts == 1 {
                    return .nak(
                        code: "temporarily_unavailable",
                        message: "稍后重试",
                        category: nil,
                        retryable: true,
                        delivery: nil,
                        executionState: nil,
                        messageId: nil,
                        clientEventId: nil
                    )
                }
                return .ok(payload: [:])
            }
        )
        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "retry-request"))
        guard let prompt = coordinator.pending,
              let bubble = CapsuleHITLBubbleProjection.presentation(
                for: prompt,
                canResolve: true
              ),
              let intent = bubble.actions.first?.intent else {
            return XCTFail("expected answer intent")
        }

        await coordinator.submitCapsuleHITLIntent(intent, promptId: bubble.id)
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(coordinator.pending?.id, bubble.id)
        XCTAssertEqual(coordinator.submitError, "稍后重试")
        XCTAssertFalse(coordinator.isSubmitting)

        await coordinator.submitCapsuleHITLIntent(intent, promptId: bubble.id)
        XCTAssertEqual(attempts, 2)
        XCTAssertNil(coordinator.pending)
        XCTAssertNil(coordinator.submitError)
    }

    @MainActor
    func testCapsuleSubmissionDeduplicatesRapidRepeatedTap() async {
        var requestCount = 0
        var ackContinuation: CheckedContinuation<AckResult, Never>?
        let coordinator = HITLCoordinator(
            sessionId: "bubble-dedupe",
            requestSender: { _ in
                requestCount += 1
                return await withCheckedContinuation { continuation in
                    ackContinuation = continuation
                }
            }
        )
        coordinator.ingest(kind: .askUser, envelope: askUserEnvelope(requestId: "dedupe-request"))
        guard let prompt = coordinator.pending,
              let bubble = CapsuleHITLBubbleProjection.presentation(for: prompt, canResolve: true),
              let intent = bubble.actions.first?.intent else {
            return XCTFail("expected answer intent")
        }

        let first = Task { @MainActor in
            await coordinator.submitCapsuleHITLIntent(intent, promptId: bubble.id)
        }
        while !coordinator.isSubmitting {
            await Task.yield()
        }
        await coordinator.submitCapsuleHITLIntent(intent, promptId: bubble.id)

        XCTAssertEqual(requestCount, 1)
        ackContinuation?.resume(returning: .ok(payload: [:]))
        await first.value
        XCTAssertNil(coordinator.pending)
    }

    /// S5：授权范围的标题与后果说明。「始终」必须讲清可撤销，否则用户不知道自己签了什么。
    func testApprovalScopeCopyExplainsConsequences() {
        XCTAssertEqual(ApprovalScopePresentation.label("once"), "仅此次")
        XCTAssertEqual(ApprovalScopePresentation.label("thread"), "本会话")
        XCTAssertEqual(ApprovalScopePresentation.label("always"), "始终")
        XCTAssertEqual(ApprovalScopePresentation.label("unknown_scope"), "仅此次")

        XCTAssertEqual(
            ApprovalScopePresentation.consequence("once"),
            "只批准这一次，下次同样操作还会问你。"
        )
        XCTAssertEqual(
            ApprovalScopePresentation.consequence("thread"),
            "本次对话内同类操作不再询问。"
        )
        XCTAssertEqual(
            ApprovalScopePresentation.consequence("always"),
            "以后同类操作都自动执行，可在设置里撤销。"
        )
        XCTAssertEqual(
            ApprovalScopePresentation.consequence("unknown_scope"),
            ApprovalScopePresentation.consequence("once")
        )
    }

    private static let interactiveReason = ApprovalRequestedPayloadActionRequestsItemDecisionReason
        .userInteractive(.init(type: "user_interactive", scope: .once))

    private static func approvalAction(
        requestId: String,
        riskLevel: ApprovalRequestedPayloadActionRequestsItemRiskLevel,
        reason: ApprovalRequestedPayloadActionRequestsItemDecisionReason = HITLModelsTests.interactiveReason,
        allowedScopes: [ApprovalRequestedPayloadActionRequestsItemAllowedScopesItem] = [.once],
        suggestedScope: ApprovalRequestedPayloadActionRequestsItemAskHintSuggestedScope? = nil
    ) -> ApprovalRequestedPayloadActionRequestsItem {
        ApprovalRequestedPayloadActionRequestsItem(
            requestId: requestId,
            toolCallId: requestId,
            toolName: "run_terminal_command",
            toolInput: .object(["command": .string("echo hi")]),
            decisionReason: reason,
            askHint: suggestedScope.map {
                ApprovalRequestedPayloadActionRequestsItemAskHint(
                    summary: "",
                    suggestedScope: $0
                )
            },
            allowedScopes: allowedScopes,
            allowedOutcomes: [.allow, .deny],
            riskLevel: riskLevel
        )
    }

    func testPlanExecutionTransactionIsIdempotentAndFailureCanRetry() {
        var transaction = PlanExecutionTransaction()

        XCTAssertTrue(transaction.begin())
        XCTAssertTrue(transaction.isExecuting)
        XCTAssertFalse(transaction.begin())

        transaction.finish(.failed("网络错误"))
        XCTAssertEqual(transaction.errorMessage, "网络错误")
        XCTAssertTrue(transaction.begin())

        transaction.finish(.accepted)
        XCTAssertTrue(transaction.isSucceeded)
        XCTAssertFalse(transaction.begin())

        transaction.finish(.failed("迟到失败"))
        XCTAssertTrue(transaction.isSucceeded)
        XCTAssertNil(transaction.errorMessage)
    }

    // MARK: - projector inline cards

    func testProjectorInjectsAndDedupesProposalCard() {
        var projector = ConversationProjector()
        let plan = PlanProposal(planDocumentId: "d1", planName: "P", overview: "o",
                                todos: [], descriptionMarkdown: "md")
        projector.appendProposalCard(.planProposal(plan))
        projector.appendProposalCard(.planProposal(plan)) // 重复应去重
        XCTAssertEqual(projector.messages.count, 1)
        XCTAssertEqual(projector.messages.first?.planProposal?.planDocumentId, "d1")
        XCTAssertFalse(projector.messages.first?.proposalResolved ?? true)

        projector.markProposalResolved(id: "plan_d1")
        XCTAssertTrue(projector.messages.first?.proposalResolved ?? false)
    }

    func testProjectorModeSwitchCard() {
        var projector = ConversationProjector()
        let mode = ModeSwitchProposal(proposalId: "m1", targetModeId: .agent, reason: "需要写文件")
        projector.appendProposalCard(.modeSwitch(mode))
        XCTAssertEqual(projector.messages.count, 1)
        XCTAssertEqual(projector.messages.first?.modeSwitchProposal?.proposalId, "m1")
    }

    private func askUserEnvelope(
        requestId: String,
        teamSpaceExecution: [String: Any]? = nil,
        teamSpaceExecutionValue: Any? = nil
    ) -> WSEnvelope {
        var payload: [String: Any] = [
            "request_id": requestId,
            "tool_name": "ask_user",
            "interaction_type": "choice",
            "blocking_policy": "blocking",
            "intent": "clarify",
            "form_mode": "single",
            "questions": [[
                "id": "q1",
                "prompt": "请选择",
                "header": "方向",
                "options": [["id": "a", "label": "A", "description": ""]],
                "allow_multiple": false,
            ]],
        ]
        if let teamSpaceExecutionValue {
            payload["team_space_execution"] = teamSpaceExecutionValue
        } else if let teamSpaceExecution {
            payload["team_space_execution"] = teamSpaceExecution
        }
        return envelope(AgentStreamEvent.askUserRequired, payload: payload)
    }

    @MainActor
    private func readonlyCoordinator(sessionId: String) -> HITLCoordinator {
        HITLCoordinator(
            sessionId: sessionId,
            currentUserIdProvider: { "user-member" }
        )
    }

    private func redactedHydrateEnvelope(
        event: String,
        requestId: String
    ) -> WSEnvelope {
        envelope(event, payload: [
            "request_id": requestId,
            "message_id": "message-\(requestId)",
            "team_space_execution": [
                "execution_owner_user_id": "user-owner",
                "execution_owner_display_name": "Owner User",
            ],
        ])
    }

    private func askFormEnvelope(
        requestId: String,
        teamSpaceExecution: [String: Any]
    ) -> WSEnvelope {
        envelope(AgentStreamEvent.askFormRequired, payload: [
            "request_id": requestId,
            "tool_name": "ask_form",
            "title": "补充资料",
            "fields": [["key": "name", "label": "姓名", "type": "input"]],
            "interaction_type": "ask_user",
            "blocking_policy": "hard",
            "intent": "collect",
            "form_mode": "fields",
            "team_space_execution": teamSpaceExecution,
        ])
    }

    private func requestApprovalEnvelope(
        requestId: String,
        teamSpaceExecution: [String: Any]? = nil,
        riskLevel: String = "high"
    ) -> WSEnvelope {
        var payload: [String: Any] = [
            "request_id": requestId,
            "tool_name": "request_approval",
            "title": "确认执行",
            "rationale": "将修改外部数据",
            "risk_level": riskLevel,
            "interaction_type": "ask_user",
            "blocking_policy": "hard",
            "intent": "approve",
            "form_mode": "approval",
        ]
        if let teamSpaceExecution {
            payload["team_space_execution"] = teamSpaceExecution
        }
        return envelope(AgentStreamEvent.requestApprovalRequired, payload: payload)
    }

    private func approvalEnvelope(
        batchId: String,
        teamSpaceExecution: [String: Any]? = nil,
        riskLevel: String = "high"
    ) -> WSEnvelope {
        var payload: [String: Any] = [
            "batch_id": batchId,
            "approval_type": "tool_permission",
            "runtime_mode": "interactive",
            "expires_at": 0.0,
            "schema_version": 1,
            "action_requests": [[
                "request_id": "request-\(batchId)",
                "tool_call_id": "call-\(batchId)",
                "tool_name": "Shell",
                "decision_reason": ["type": "user_interactive", "scope": "once"],
                "allowed_scopes": ["once"],
                "allowed_outcomes": ["allow", "deny"],
                "risk_level": riskLevel,
            ]],
        ]
        if let teamSpaceExecution {
            payload["team_space_execution"] = teamSpaceExecution
        }
        return envelope(AgentStreamEvent.approvalRequested, payload: payload)
    }

    private func redactedApprovalEnvelope(batchId: String) -> WSEnvelope {
        envelope(AgentStreamEvent.approvalRequested, payload: [
            "batch_id": batchId,
            "approval_type": "tool_permission",
            "action_requests": [[
                "request_id": "request-\(batchId)",
                "tool_call_id": "call-\(batchId)",
                "tool_name": RedactedApprovalDisplay.toolName,
            ]],
            "runtime_mode": "interactive",
            "expires_at": 0.0,
            "details_redacted": true,
            "team_space_execution": teamMetadata,
            "schema_version": 1,
        ])
    }

    @MainActor
    private func pendingApprovalToolName(_ coordinator: HITLCoordinator) -> String? {
        guard case let .approvalBatch(request) = coordinator.pending else { return nil }
        return request.actionRequests.first?.toolName
    }

    private var teamMetadata: [String: Any] {
        [
            "execution_owner_user_id": "user-owner",
            "execution_owner_display_name": "Owner User",
        ]
    }

    private func pendingInteraction(
        id: String,
        requestKey: String,
        createdAt: Int?,
        expiresAt: Int?
    ) throws -> PendingInteraction {
        var raw: [String: Any] = [
            "id": id,
            "kind": "ask_choice",
            "status": "pending",
            "thread_id": "chat-session-restore",
            "session_id": "restore",
            "request_key": requestKey,
            "source": "agent_stream",
            "payload": [:],
        ]
        if let createdAt { raw["created_at"] = createdAt }
        if let expiresAt { raw["expires_at"] = expiresAt }
        let data = try JSONSerialization.data(withJSONObject: raw)
        return try JSONDecoder().decode(PendingInteraction.self, from: data)
    }
}
