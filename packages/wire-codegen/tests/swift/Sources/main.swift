import Foundation

/// Swift round-trip 测试（W0-L1 / L2 / L5 / L6 实测）。
///
/// 验证点：
///   1. 所有 generated .swift 文件能 compile（type-safe enum + Codable）
///   2. 22 case ContentBlock parse + re-encode → re-parse → 数据一致
///   3. 6 envelope parse + re-encode 一致
///   4. **W0-L6 type-safe 关键证据**：switch ContentBlock 时 Swift 编译器
///      要求穷尽所有 22 case（编译器层面禁止漏 case）
///   5. emoji / 浮点 / 大 base64 round-trip 不失真
///   6. **W0-L2 严格 byte-level**：encoded JSONString 解析后的字段全等
///
/// 跑法（被 roundtrip-swift.sh 调用）：
///   swift build && swift run WireRoundTrip <fixture-dir>

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("Usage: WireRoundTrip <fixture-samples-dir>")
    exit(2)
}
let fixturesDir = URL(fileURLWithPath: args[1])

let decoder = JSONDecoder()
let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]

var failures: [String] = []

// ════════════════════════════════════════════════════════════════════
// Suite 1: 22 case ContentBlock
// ════════════════════════════════════════════════════════════════════

func loadFixture(_ name: String) throws -> Data {
    let url = fixturesDir.appendingPathComponent(name)
    return try Data(contentsOf: url)
}

print("\n[Suite 1] 22 case ContentBlock parse + byte-level round-trip + 原始 fixture 字段保真")
do {
    let data = try loadFixture("content_block_22cases.json")
    // **W1-Review P0-2 修复**：先把原始 JSON 解析为 [String: Any] 一份，留作真值对照
    // （只比 s1 == s2 是盲点——第一次 decode 已丢字段时 s1 == s2 也成立）
    guard let rawArr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        failures.append("Suite 1: fixture 格式不是 JSON 数组")
        throw NSError(domain: "WireRoundTrip", code: 1, userInfo: nil)
    }
    let blocks = try decoder.decode([ContentBlock].self, from: data)
    if blocks.count != 22 {
        failures.append("expected 22, got \(blocks.count)")
    }
    if rawArr.count != blocks.count {
        failures.append("Suite 1: raw count(\(rawArr.count)) ≠ decoded count(\(blocks.count))")
    }
    for (idx, block) in blocks.enumerated() {
        let s1 = try encoder.encode(block)
        let block2 = try decoder.decode(ContentBlock.self, from: s1)
        let s2 = try encoder.encode(block2)
        if s1 != s2 {
            failures.append("#\(idx + 1) \(block.type): re-encode 字节不等")
            continue
        }
        // **关键闸**：原始 fixture 的 input / payload / params / field_values
        // 等任意 JSON record 字段必须保留所有 key。
        let raw = rawArr[idx]
        if let s1Obj = try JSONSerialization.jsonObject(with: s1) as? [String: Any] {
            let recordKeys = ["input", "payload", "params", "field_values", "block_id_overrides"]
            for key in recordKeys {
                if let rawDict = raw[key] as? [String: Any] {
                    let s1Dict = (s1Obj[key] as? [String: Any]) ?? [:]
                    let rawKeys = Set(rawDict.keys)
                    let s1Keys = Set(s1Dict.keys)
                    if rawKeys != s1Keys {
                        failures.append("#\(idx + 1) \(block.type).\(key): 字段丢失（raw=\(rawKeys.sorted()), got=\(s1Keys.sorted())）")
                        continue
                    }
                }
            }
        }
        print("  ✔ #\(idx + 1) \(block.type)")
    }
} catch {
    failures.append("Suite 1: \(error)")
    print("  ✘ Suite 1 failed: \(error)")
}

// ════════════════════════════════════════════════════════════════════
// Suite 2: W0-L6 type-safe 关键证据 —— 编译期穷尽 22 case
// ════════════════════════════════════════════════════════════════════

print("\n[Suite 2] W0-L6 编译期 type-safe 穷尽（如果改 ContentBlock case 不更新此处会编译失败）")
do {
    let data = try loadFixture("content_block_22cases.json")
    let blocks = try decoder.decode([ContentBlock].self, from: data)
    var typeCounts: [String: Int] = [:]
    for block in blocks {
        // ⚠️ 这个 switch 是 type-safe 关键证据：Swift 编译器强制穷尽 22 case
        // 如果未来加 ContentBlock case 但漏更新此处 → 编译失败 → CI 拦截
        switch block {
        case .text: typeCounts["text", default: 0] += 1
        case .toolUse: typeCounts["tool_use", default: 0] += 1
        case .toolResult: typeCounts["tool_result", default: 0] += 1
        case .thinking: typeCounts["thinking", default: 0] += 1
        case .redactedThinking: typeCounts["redacted_thinking", default: 0] += 1
        case .image: typeCounts["image", default: 0] += 1
        case .document: typeCounts["document", default: 0] += 1
        case .serverToolUse: typeCounts["server_tool_use", default: 0] += 1
        case .webSearchToolResult: typeCounts["web_search_tool_result", default: 0] += 1
        case .codeExecutionToolResult: typeCounts["code_execution_tool_result", default: 0] += 1
        case .bashCodeExecutionToolResult: typeCounts["bash_code_execution_tool_result", default: 0] += 1
        case .textEditorCodeExecutionToolResult: typeCounts["text_editor_code_execution_tool_result", default: 0] += 1
        case .mcpToolUse: typeCounts["mcp_tool_use", default: 0] += 1
        case .mcpToolResult: typeCounts["mcp_tool_result", default: 0] += 1
        case .containerUpload: typeCounts["container_upload", default: 0] += 1
        case .searchResult: typeCounts["search_result", default: 0] += 1
        case .tabtinRichContent: typeCounts["tabtin_rich_content", default: 0] += 1
        case .tabtinComposerPreset: typeCounts["tabtin_composer_preset", default: 0] += 1
        case .tabtinAskUserFields: typeCounts["tabtin_ask_user_fields", default: 0] += 1
        case .tabtinSkillInvocation: typeCounts["tabtin_skill_invocation", default: 0] += 1
        case .tabtinSourceRef: typeCounts["tabtin_source_ref", default: 0] += 1
        case .tabtinApprovalRequest: typeCounts["tabtin_approval_request", default: 0] += 1
        }
    }
    if typeCounts.count == 22 {
        print("  ✔ 22 case 全部命中")
    } else {
        failures.append("expected 22 distinct types, got \(typeCounts.count): \(typeCounts.keys.sorted())")
    }
}

// ════════════════════════════════════════════════════════════════════
// Suite 3: 边界 case
// ════════════════════════════════════════════════════════════════════

print("\n[Suite 3] 6 边界 case (W0-L2 严格 byte-level)")
do {
    let data = try loadFixture("content_block_edge_cases.json")
    let blocks = try decoder.decode([ContentBlock].self, from: data)
    for (idx, block) in blocks.enumerated() {
        let s1 = try encoder.encode(block)
        let block2 = try decoder.decode(ContentBlock.self, from: s1)
        let s2 = try encoder.encode(block2)
        if s1 != s2 {
            failures.append("edge #\(idx + 1): re-encode 不等")
        } else {
            print("  ✔ edge #\(idx + 1) \(block.type)")
        }
    }

    // 浮点不丢精度（ref_kind=doc bbox=[0.123, 0.4567, 0.89012, 0.999]）
    for block in blocks {
        if case .tabtinSourceRef(let payload) = block,
           case .doc(let docSnap) = payload.snapshot {
            let bbox = docSnap.bbox ?? []
            if bbox != [0.123, 0.4567, 0.89012, 0.999] {
                failures.append("浮点 bbox 失真: \(bbox)")
            } else {
                print("  ✔ 浮点 bbox 不丢精度: \(bbox)")
            }
            break
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// Suite 4: 6 envelope round-trip
// ════════════════════════════════════════════════════════════════════

print("\n[Suite 4] 6 envelope round-trip")

func roundTripOne<T: Codable & Equatable>(_ type: T.Type, fixture: String, label: String) {
    do {
        let data = try loadFixture(fixture)
        if let arr = try? decoder.decode([T].self, from: data) {
            for (i, item) in arr.enumerated() {
                let s1 = try encoder.encode(item)
                let item2 = try decoder.decode(T.self, from: s1)
                let s2 = try encoder.encode(item2)
                if s1 != s2 {
                    failures.append("\(label)[\(i)]: re-encode 不等")
                }
            }
            print("  ✔ \(label) (\(arr.count) 个 fixture)")
        } else {
            let item = try decoder.decode(T.self, from: data)
            let s1 = try encoder.encode(item)
            let item2 = try decoder.decode(T.self, from: s1)
            let s2 = try encoder.encode(item2)
            if s1 != s2 {
                failures.append("\(label): re-encode 不等")
            }
            print("  ✔ \(label) (1 个 fixture)")
        }
    } catch {
        failures.append("\(label): \(error)")
        print("  ✘ \(label): \(error)")
    }
}

roundTripOne(MessageStart.self, fixture: "envelope_message_start.json", label: "MessageStart")
roundTripOne(MessageDelta.self, fixture: "envelope_message_delta.json", label: "MessageDelta")
roundTripOne(MessageStop.self, fixture: "envelope_message_stop.json", label: "MessageStop")
// W4c-L5 · W4.5 第二波 B1：error_info.partial_reason 三档
roundTripOne(
    MessageStop.self,
    fixture: "envelope_message_stop_partial_reasons.json",
    label: "MessageStop (partial_reason × 3)"
)
roundTripOne(ContentBlockStart.self, fixture: "envelope_content_block_start.json", label: "ContentBlockStart")
roundTripOne(ContentBlockDelta.self, fixture: "envelope_content_block_delta_6types.json", label: "ContentBlockDelta")
roundTripOne(ContentBlockStop.self, fixture: "envelope_content_block_stop.json", label: "ContentBlockStop")

// W4c-L5：三档 partial_reason 字面量正确解码
print("\n[Suite 4b] partial_reason 三档字面量 decode（W4c-L5）")
do {
    let data = try loadFixture("envelope_message_stop_partial_reasons.json")
    let stops = try decoder.decode([MessageStop].self, from: data)
    let reasons = stops.compactMap { $0.errorInfo?.partialReason?.rawValue }
    let want: Set<String> = ["aborted", "stream_interrupted", "message_stop_fallback"]
    let got: Set<String> = Set(reasons)
    if got == want {
        print("  ✔ 三档 partial_reason 全部正确：\(reasons.sorted())")
    } else {
        failures.append("partial_reason 三档不符：want=\(want.sorted()), got=\(got.sorted())")
    }
} catch {
    failures.append("Suite 4b: \(error)")
    print("  ✘ Suite 4b failed: \(error)")
}

// ════════════════════════════════════════════════════════════════════
// Suite 5: any_event 顶层 union (W0-L6 type-safe 6 case 穷尽)
// ════════════════════════════════════════════════════════════════════

print("\n[Suite 5] AnyContentBlockStreamEvent 6 case 编译期穷尽")
do {
    let data = try loadFixture("envelope_any_event_stream.json")
    let stream = try decoder.decode([AnyContentBlockStreamEvent].self, from: data)
    var counts: [String: Int] = [:]
    for ev in stream {
        // ⚠️ Swift 编译器强制穷尽 6 case
        switch ev {
        case .agentStreamMessageStart: counts["message_start", default: 0] += 1
        case .agentStreamMessageDelta: counts["message_delta", default: 0] += 1
        case .agentStreamMessageStop: counts["message_stop", default: 0] += 1
        case .agentStreamContentBlockStart: counts["content_block_start", default: 0] += 1
        case .agentStreamContentBlockDelta: counts["content_block_delta", default: 0] += 1
        case .agentStreamContentBlockStop: counts["content_block_stop", default: 0] += 1
        }
    }
    if counts.count == 6 {
        print("  ✔ 6 envelope case 全部命中")
    } else {
        failures.append("expected 6 envelope case, got \(counts.count)")
    }
} catch {
    failures.append("Suite 5: \(error)")
    print("  ✘ Suite 5 failed: \(error)")
}

// ════════════════════════════════════════════════════════════════════
// Suite 6: 未知 type 必须被拒绝
// ════════════════════════════════════════════════════════════════════

print("\n[Suite 6] 未知 type 字面量必须 fail-fast")
let unknownData = "{\"type\":\"fictional_v3_block\"}".data(using: .utf8)!
do {
    _ = try decoder.decode(ContentBlock.self, from: unknownData)
    failures.append("未知 type 应被拒绝但 decode 成功了")
    print("  ✘ 未知 type 没被拒")
} catch {
    print("  ✔ 未知 type 被 type-safe enum decoder 拒绝（expected）")
}

// ════════════════════════════════════════════════════════════════════
// Suite 7: W4.5 B3 · StreamEventIdValidator 跨语言契约 fixture replay
// ────────────────────────────────────────────────────────────────────
// 与 TS / Python / Kotlin 端跑同一份 fixture（cp 自
// packages/agent-wire/src/cross-lang-fixtures/wave45-isStreamEventId.json）。
// 4 端必须 byte-by-byte 一致。
// ════════════════════════════════════════════════════════════════════

struct WaveFixCase: Decodable {
    let name: String
    let input: String
    let expected: Bool
}
struct WaveFixDoc: Decodable {
    let spec_version: String
    let cases: [WaveFixCase]
}

print("\n[Suite 7] W4.5 B3 · StreamEventIdValidator 跨语言契约 replay (case 数随 fixture)")
do {
    let data = try loadFixture("wave45-isStreamEventId.json")
    let doc = try decoder.decode(WaveFixDoc.self, from: data)
    if doc.spec_version != "v1" {
        failures.append("Suite 7: spec_version 期望 v1，实际 \(doc.spec_version)")
    }
    var pass = 0
    var fail = 0
    for c in doc.cases {
        let actual = StreamEventIdValidator.isStreamEventId(c.input)
        if actual == c.expected {
            pass += 1
        } else {
            fail += 1
            failures.append(
                "Suite 7 case '\(c.name)': input='\(c.input)' expected=\(c.expected) actual=\(actual)"
            )
        }
    }
    if fail == 0 {
        print("  ✔ \(pass)/\(doc.cases.count) case 全 PASS（4 端契约 Swift 落地）")
    } else {
        print("  ✘ \(fail)/\(doc.cases.count) case FAIL")
    }
} catch {
    failures.append("Suite 7: \(error)")
    print("  ✘ Suite 7 failed: \(error)")
}

// ════════════════════════════════════════════════════════════════════
// 总结
// ════════════════════════════════════════════════════════════════════

print("")
print("═══════════════════════════════════════════════════════════════")
if failures.isEmpty {
    print("  ✔ Swift round-trip 全部通过")
    print("═══════════════════════════════════════════════════════════════")
    exit(0)
} else {
    print("  ✘ \(failures.count) 个失败：")
    for f in failures {
        print("     - \(f)")
    }
    print("═══════════════════════════════════════════════════════════════")
    exit(1)
}
