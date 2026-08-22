import SwiftUI
import UIKit
@preconcurrency import MarkdownUI

/// 会话步骤的语义图标统一来自 Electron 同版本 Lucide；iOS 只负责把同一份 SVG
/// 光栅化为 template asset，避免 SF Symbols 与桌面端形成两套视觉语言。
struct ElectronChatIcon: View {
    let name: String
    var size: CGFloat = 14
    var color: Color = .tt.textTertiary

    var body: some View {
        Image("Lucide\(name)")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    static func assetName(for name: String) -> String {
        "Lucide\(name)"
    }
}

/// 中间步骤的统一图标槽。所有 Lucide 图标以同一视觉尺寸居中在 16pt 槽内，
/// 让思考、只读工具和终端等副作用工具的文字共享同一条起始线。
struct ConversationStepIcon: View {
    let name: String

    var body: some View {
        ElectronChatIcon(name: name, size: 14)
            .frame(width: 16, height: 16, alignment: .center)
    }
}

// MARK: - Specialized tool cards

struct ToolCardRegistryView: View {
    let tool: ToolCall

    var body: some View {
        switch ToolPresentation.timelineStyle(for: tool) {
        case .compact:
            CompactToolRow(tool: tool)
        case .card:
            ToolStepCard(tool: tool)
        }
    }
}

private enum ToolKind {
    case terminal, ssh, fileRead, fileWrite, fileEdit, sql, webSearch, webFetch, codeSearch, todo, record, agentTask, generic

    static func of(_ name: String) -> ToolKind {
        switch name {
        case "bash", "terminal_execute", "execute_command", "shell", "Bash", "Shell",
             "run_terminal_command", "execute_in_terminal":
            return .terminal
        case "ssh_execute", "ssh":
            return .ssh
        case "file_read", "read_file", "Read", "document_read":
            return .fileRead
        case "file_write", "write_file", "create_file", "Write":
            return .fileWrite
        case "file_edit", "apply_diff", "edit_file", "Edit", "MultiEdit", "apply_patch", "str_replace":
            return .fileEdit
        case "execute_sql", "sql_execute", "sql_query", "table_query":
            return .sql
        case "web_search", "search", "WebSearch":
            return .webSearch
        case "web_fetch", "fetch_url", "WebFetch", "browse_url":
            return .webFetch
        case "grep", "glob", "code_search", "semantic_search", "code_grep",
             "Grep", "Glob", "GlobTool", "SearchFiles", "code_glob", "code_semantic_search", "list_files":
            return .codeSearch
        case "todo_write", "TodoWrite":
            return .todo
        case "Task", "Dispatch", "dispatch_agent", "delegate_task", "subagent", "subagent_run":
            return .agentTask
        default:
            if name.hasPrefix("create_record") || name.hasPrefix("update_record") || name.hasPrefix("delete_record")
                || name.hasPrefix("batch_create") || name.hasPrefix("batch_update") || name.hasPrefix("batch_delete") {
                return .record
            }
            return .generic
        }
    }
}

private struct ToolFailureNotice: View {
    let errorMessage: String?

    private var presentation: ToolErrorPresentation {
        ToolErrorPresentation.from(errorMessage)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            HStack(alignment: .top, spacing: TTSpacing.xs) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textCritical)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(presentation.title)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textCritical)
                    if let detail = presentation.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textCritical.opacity(0.85))
                            .lineLimit(3)
                    }
                }
            }
        }
        .padding(TTSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgCritical.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.bgCritical.opacity(0.18), lineWidth: 0.5))
    }
}

struct ToolErrorPresentation: Equatable {
    let title: String
    let detail: String?

    static func from(_ raw: String?) -> ToolErrorPresentation {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return .init(title: "工具执行失败", detail: nil)
        }
        if let envelope = ToolErrorEnvelope.parse(raw) {
            if let kind = envelope.errorKind,
               let mapped = toolErrorKindMap[kind] {
                return .init(title: mapped.title, detail: envelope.message ?? mapped.detail)
            }
            if let message = envelope.message {
                return .init(title: "工具执行失败", detail: message)
            }
        }
        return .init(title: "工具执行失败", detail: raw)
    }

    var displayText: String {
        guard let detail, !detail.isEmpty else { return title }
        return "\(title)\n\(detail)"
    }

    private static let toolErrorKindMap: [String: ToolErrorPresentation] = [
        "file_not_found": .init(title: "文件不存在", detail: "请确认绝对路径是否正确。"),
        "file_too_large": .init(title: "AI 暂时看不了这个文件", detail: "文件较大，请点 + 用聊天附件上传，让 AI 走云端解析。"),
        "encrypted": .init(title: "文件已加密", detail: "请提供未加密版本，云端也无法绕过密码。"),
        "corrupted": .init(title: "文件已损坏", detail: "请联系发件方，或在源应用里重新导出后再试。"),
        "scanned_pdf": .init(title: "扫描件 PDF", detail: "请点 + 用聊天附件上传，AI 会用图像识别提取文字；按页计费，处理时间较长。"),
        "garbled_text_layer": .init(title: "PDF 文字提取不准", detail: "请点 + 用聊天附件上传，AI 会用图像识别重新提取；按页计费，处理时间较长。"),
        "unsupported_format": .init(title: "格式不支持", detail: "PPTX/DOC/XLS 等办公文档请点 + 上传走云端解析；压缩包、可执行文件等暂不支持。"),
        "parse_timeout": .init(title: "本地解析超时", detail: "请点 + 用聊天附件上传，改走云端异步解析。"),
        "permission_denied": .init(title: "权限被拒", detail: "文件可能在工作区外或被标记敏感，请授权后重试。"),
        "network_failed": .init(title: "网络异常", detail: "请检查网络后重试；如果是临时链接过期，建议重新上传。"),
        "invalid_param_format": .init(title: "参数格式错误", detail: "请检查工具入参后重试。"),
        "aborted": .init(title: "已停止", detail: "你中止了本次工具运行。"),
        "upstream_error": .init(title: "未知错误", detail: "请重试一次；如果持续失败，请反馈给我们。"),
    ]
}

enum ToolResultPresentation {
    static func displayText(_ raw: String, isError: Bool) -> String {
        guard isError,
              let envelope = ToolErrorEnvelope.parse(raw),
              envelope.errorKind != nil || envelope.message != nil
        else { return raw }
        return ToolErrorPresentation.from(raw).displayText
    }
}

private struct ToolErrorEnvelope {
    let errorKind: String?
    let message: String?

    static func parse(_ raw: String) -> ToolErrorEnvelope? {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        else { return nil }

        if let dict = object as? [String: Any] {
            let metadata = dict["metadata"] as? [String: Any]
            return ToolErrorEnvelope(
                errorKind: stringValue(dict["error_kind"]) ?? stringValue(metadata?["error_kind"]),
                message: firstMessage(in: dict) ?? metadata.flatMap(firstMessage)
            )
        }
        if let array = object as? [[String: Any]] {
            for item in array {
                if let message = firstMessage(in: item) {
                    return ToolErrorEnvelope(errorKind: stringValue(item["error_kind"]), message: message)
                }
            }
        }
        return nil
    }

    private static func firstMessage(in dict: [String: Any]) -> String? {
        for key in ["error", "error_message", "message", "detail", "hint"] {
            if let value = stringValue(dict[key]), !value.isEmpty { return value }
        }
        return nil
    }

    private static func stringValue(_ value: Any?) -> String? {
        switch value {
        case let string as String:
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case let number as NSNumber:
            return number.stringValue
        default:
            return nil
        }
    }
}

private struct ToolStatusBadge: View {
    let text: String
    let color: Color
    let background: Color

    var body: some View {
        Text(text)
            .font(.tt.codeXS)
            .foregroundStyle(color)
            .padding(.horizontal, TTSpacing.xs)
            .padding(.vertical, 2)
            .background(Capsule(style: .continuous).fill(background))
    }
}

private struct ToolTerminalOutputPreview: View {
    let text: String
    let isError: Bool
    @State private var expanded = false

    private var lines: [String] { text.components(separatedBy: "\n") }
    private var displayText: String {
        guard !expanded, lines.count > 24 else { return text }
        return lines.prefix(24).joined(separator: "\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(displayText)
                    .font(.tt.codeSM)
                    .foregroundStyle(isError ? .tt.textCritical : .tt.textPrimary)
                    .padding(TTSpacing.xs)
                    .copyOnLongPress(text)
            }
            if lines.count > 24 {
                Button(expanded ? "收起输出" : "显示剩余 \(lines.count - 24) 行") {
                    withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
                }
                .font(.tt.caption)
                .buttonStyle(.plain)
                .foregroundStyle(.tt.textAccent)
                .padding(.horizontal, TTSpacing.xs)
                .padding(.bottom, TTSpacing.xs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtleSecondary))
    }
}

private struct ToolDiffPreview: View {
    let diff: String
    let isError: Bool
    @State private var expanded = false

    private var lines: [ToolDiffLine] {
        diff.components(separatedBy: "\n").enumerated().map { index, line in
            ToolDiffLine(id: index, raw: line, type: ToolDiffLineType.parse(line))
        }
    }

    private var displayLines: ArraySlice<ToolDiffLine> {
        lines.prefix(expanded ? 160 : 48)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(displayLines) { line in
                HStack(spacing: TTSpacing.xs) {
                    Text(line.type.prefix)
                        .font(.tt.codeXS)
                        .foregroundStyle(line.type.textColor)
                        .frame(width: 12, alignment: .center)
                    Text(line.content)
                        .font(.tt.codeXS)
                        .foregroundStyle(isError ? .tt.textCritical : line.type.textColor)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, TTSpacing.xs)
                .padding(.vertical, 1)
                .background(line.type.backgroundColor)
            }
            if lines.count > displayLines.count {
                Button(expanded ? "收起 diff" : "显示 \(min(lines.count, 160)) / \(lines.count) 行") {
                    withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
                }
                .font(.tt.caption)
                .buttonStyle(.plain)
                .foregroundStyle(.tt.textAccent)
                .padding(.horizontal, TTSpacing.xs)
                .padding(.vertical, TTSpacing.xs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtleSecondary))
        .copyOnLongPress(diff)
    }
}

private struct ToolDiffLine: Identifiable {
    let id: Int
    let raw: String
    let type: ToolDiffLineType

    var content: String {
        guard raw.first == "+" || raw.first == "-" else { return raw }
        return String(raw.dropFirst())
    }
}

private enum ToolDiffLineType {
    case added, removed, hunk, fileHeader, context

    static func parse(_ line: String) -> ToolDiffLineType {
        if line.hasPrefix("@@") { return .hunk }
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff --git") { return .fileHeader }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        return .context
    }

    var prefix: String {
        switch self {
        case .added: return "+"
        case .removed: return "-"
        case .hunk: return "@"
        case .fileHeader: return "·"
        case .context: return " "
        }
    }

    var textColor: Color {
        switch self {
        case .added: return .tt.textSuccess
        case .removed: return .tt.textCritical
        case .hunk: return .tt.textAccent
        case .fileHeader: return .tt.textSecondary
        case .context: return .tt.textPrimary
        }
    }

    var backgroundColor: Color {
        switch self {
        case .added: return Color.tt.bgSuccess.opacity(0.08)
        case .removed: return Color.tt.bgCritical.opacity(0.08)
        case .hunk: return Color.tt.bgAccent.opacity(0.08)
        default: return .clear
        }
    }
}

private struct CodeSearchMatchRow: View {
    let match: [String: Any]

    private var file: String {
        string("file", "path", "filename", "uri") ?? "匹配结果"
    }

    private var lineNumber: Int? {
        int("line_number", "lineNumber", "line", "start_line")
    }

    private var snippet: String {
        string("content", "text", "line_text", "snippet", "match") ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: TTSpacing.xxs) {
                Text((file as NSString).lastPathComponent.isEmpty ? file : (file as NSString).lastPathComponent)
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textAccent)
                    .lineLimit(1)
                if let lineNumber {
                    Text(":\(lineNumber)")
                        .font(.tt.codeXS)
                        .foregroundStyle(.tt.textTertiary)
                }
                Spacer(minLength: 0)
            }
            if file != (file as NSString).lastPathComponent {
                Text(file)
                    .font(.tt.codeXS)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if !snippet.isEmpty {
                Text(snippet.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.tt.codeXS)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                    .copyOnLongPress(snippet)
            }
        }
        .padding(.vertical, 2)
    }

    private func string(_ keys: String...) -> String? {
        for key in keys {
            if let value = match[key] {
                let text = ToolDisplayHelpers.cellText(value).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty && text != "null" { return text }
            }
        }
        return nil
    }

    private func int(_ keys: String...) -> Int? {
        for key in keys {
            if let int = match[key] as? Int { return int }
            if let int64 = match[key] as? Int64 { return Int(int64) }
            if let double = match[key] as? Double { return Int(double) }
            if let string = match[key] as? String, let int = Int(string) { return int }
        }
        return nil
    }
}

private struct ToolSearchResultRow: View {
    let result: [String: Any]

    private var title: String {
        result["title"] as? String ?? result["name"] as? String ?? result["url"] as? String ?? "搜索结果"
    }
    private var url: String {
        result["url"] as? String ?? result["link"] as? String ?? ""
    }
    private var snippet: String {
        result["snippet"] as? String ?? result["description"] as? String ?? result["content"] as? String ?? ""
    }
    private var sourceURL: URL? {
        guard !url.isEmpty, let candidate = URL(string: url), candidate.scheme != nil else { return nil }
        return candidate
    }

    var body: some View {
        Group {
            if let sourceURL {
                Button {
                    UIApplication.shared.open(sourceURL)
                } label: {
                    rowContent(showChevron: true)
                }
                .buttonStyle(.plain)
            } else {
                rowContent(showChevron: false)
            }
        }
    }

    private func rowContent(showChevron: Bool) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.xs) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textAccent)
                    .lineLimit(1)
                if !url.isEmpty {
                    Text(URL(string: url)?.host ?? url)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
                if !snippet.isEmpty {
                    Text(snippet)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if showChevron {
                Image(systemName: "arrow.up.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
                    .padding(.top, 3)
            }
        }
    }
}

private struct ToolMiniTable: View {
    let rows: [[String: Any]]
    let columns: [String]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(columns, id: \.self) { column in
                        Text(column)
                            .font(.tt.codeXSSemibold)
                            .foregroundStyle(.tt.textSecondary)
                            .frame(minWidth: 84, alignment: .leading)
                            .padding(.horizontal, TTSpacing.xs)
                            .padding(.vertical, TTSpacing.xxs)
                    }
                }
                .background(.tt.bgSubtleSecondary)

                ForEach(Array(rows.enumerated()), id: \.offset) { offset, row in
                    HStack(spacing: 0) {
                        ForEach(columns, id: \.self) { column in
                            Text(ToolDisplayHelpers.cellText(row[column]))
                                .font(.tt.codeXS)
                                .foregroundStyle(.tt.textPrimary)
                                .frame(minWidth: 84, alignment: .leading)
                                .padding(.horizontal, TTSpacing.xs)
                                .padding(.vertical, TTSpacing.xxs)
                                .lineLimit(1)
                        }
                    }
                    if offset < rows.count - 1 { Divider() }
                }
            }
        }
    }
}

private struct ToolRunningRow: View {
    let text: String

    var body: some View {
        HStack(spacing: TTSpacing.xs) {
            ProgressView().controlSize(.mini)
            Text(text)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
        }
        .padding(.vertical, TTSpacing.xxs)
    }
}

private struct ToolCodePreview: View {
    let text: String
    var language: String? = nil
    var maxCharacters = 1800
    var isError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.tt.codeXS)
                    .foregroundStyle(.tt.textTertiary)
                    .padding(.horizontal, TTSpacing.xs)
                    .padding(.top, TTSpacing.xxs)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(ToolDisplayHelpers.truncate(text, max: maxCharacters))
                    .font(.tt.codeXS)
                    .foregroundStyle(isError ? .tt.textCritical : .tt.textPrimary)
                    .padding(TTSpacing.xs)
                    .copyOnLongPress(text)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: TTRadius.sm).fill(.tt.bgSubtleSecondary))
    }
}

private enum ToolDisplayHelpers {
    static func truncate(_ text: String, max: Int) -> String {
        text.count <= max ? text : String(text.prefix(max)) + "…"
    }

    static func language(for path: String) -> String? {
        let ext = (path as NSString).pathExtension.lowercased()
        let map: [String: String] = [
            "swift": "swift", "ts": "typescript", "tsx": "typescript",
            "js": "javascript", "jsx": "javascript", "py": "python",
            "rs": "rust", "go": "go", "java": "java", "kt": "kotlin",
            "rb": "ruby", "css": "css", "html": "html", "json": "json",
            "yaml": "yaml", "yml": "yaml", "toml": "toml", "sql": "sql",
            "sh": "shell", "bash": "shell", "md": "markdown", "diff": "diff",
        ]
        return map[ext]
    }

    static func cellText(_ value: Any?) -> String {
        switch value {
        case .none, .some(_ as NSNull): return "null"
        case let string as String: return string
        case let number as NSNumber: return number.stringValue
        case let bool as Bool: return bool ? "true" : "false"
        case let dict as [String: Any]:
            return dict["text"] as? String ?? dict["value"] as? String ?? String(describing: dict)
        case .some(let value): return String(describing: value)
        }
    }
}

private extension ToolCall {
    var inputObject: [String: Any]? {
        Self.jsonObject(from: inputJson) as? [String: Any]
    }

    var resultObject: [String: Any]? {
        guard let resultText else { return nil }
        return Self.jsonObject(from: resultText) as? [String: Any]
    }

    var resultArray: [Any]? {
        guard let resultText else { return nil }
        return Self.jsonObject(from: resultText) as? [Any]
    }

    func stringValue(_ keys: String..., in object: [String: Any]) -> String? {
        stringValue(keys, in: object)
    }

    func stringValue(_ keys: [String], in object: [String: Any]) -> String? {
        for key in keys {
            if let value = object[key] {
                let text = ToolDisplayHelpers.cellText(value).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty && text != "null" { return text }
            }
        }
        return nil
    }

    func intValue(_ keys: String..., in object: [String: Any]) -> Int? {
        for key in keys {
            if let int = object[key] as? Int { return int }
            if let int64 = object[key] as? Int64 { return Int(int64) }
            if let double = object[key] as? Double { return Int(double) }
            if let string = object[key] as? String, let int = Int(string) { return int }
        }
        return nil
    }

    func boolValue(_ keys: String..., in object: [String: Any]) -> Bool? {
        for key in keys {
            if let bool = object[key] as? Bool { return bool }
            if let number = object[key] as? NSNumber { return number.boolValue }
            if let string = object[key] as? String {
                switch string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
                case "true", "1", "yes", "y": return true
                case "false", "0", "no", "n": return false
                default: break
                }
            }
        }
        return nil
    }

    private static func jsonObject(from raw: String) -> Any? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
}

// MARK: - Compact tool row（只读工具）

/// 只读 / 呈现类工具的紧凑行：无背景，弱化图标 + 动词 + 输入摘要（对齐 Electron CompactToolUseRow）。
/// 真实工具图标全程稳定；仅运行文案 shimmer，成功后不再保留“成功”或绿色勾。
/// 输入与结果不进时间线，点行开 `ExecutionDetailSheet` 看。
private struct CompactToolRow: View {
    let tool: ToolCall

    var body: some View {
        ToolTimelineStepRow(tool: tool, showsStatusLabel: false)
    }
}

// MARK: - Tool step card（副作用工具）

/// 副作用工具（bash / sql / edit / write…）的一行 step。时间线只留这一行；
/// 命令、diff、SQL 结果等详情一律进底部抽屉，不再内联展开把正文和 Composer 顶走。
/// 失败时行下方保留一段失败提要——用户不点开也该知道出了什么事。
private struct ToolStepCard: View {
    let tool: ToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            ToolTimelineStepRow(tool: tool, showsStatusLabel: true)

            if tool.isError {
                ToolFailureNotice(errorMessage: tool.resultText)
                    .padding(.leading, TTSpacing.lg)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 工具在时间线上的统一一行：图标 + 「AI 正在做什么」+（可选）状态，点开走执行详情抽屉。
private struct ToolTimelineStepRow: View {
    let tool: ToolCall
    let showsStatusLabel: Bool

    @State private var showDetailSheet = false

    private var presentation: ToolPresentation { .of(tool.name) }

    var body: some View {
        Button {
            showDetailSheet = true
        } label: {
            HStack(spacing: TTSpacing.xs) {
                ConversationStepIcon(name: presentation.icon)
                timelineLabel
                    .layoutPriority(1)
                if showsStatusLabel {
                    ToolExecutionStatusLabel(tool: tool)
                }
                Image(systemName: "chevron.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
                Spacer(minLength: 0)
            }
            .padding(.vertical, TTSpacing.xxs)
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(L10n.Agent.executionDetailHint)
        .sheet(isPresented: $showDetailSheet) {
            ExecutionDetailSheet(blocks: [.tool(tool)])
        }
    }

    private var timelineLabel: some View {
        let text = presentation.timelineLabel(
            from: tool.inputJson,
            runtimeTitle: tool.runtimeTitle
        )
        let detail = presentation.timelineDetail(from: tool.inputJson)
        let usesTwoTone = detail.map { text == "\(presentation.verb) · \($0)" } ?? false
        return ConversationStepLabel(
            text: usesTwoTone ? presentation.verb : text,
            detail: usesTwoTone ? detail : nil,
            isRunning: ToolTimelineStatusPresentation.usesShimmer(
                for: tool.resolvedExecutionPhase
            )
        )
    }
}

private struct ToolExecutionStatusLabel: View {
    let tool: ToolCall

    var body: some View {
        HStack(spacing: 3) {
            if tool.hasSuspiciousOutput {
                Image(systemName: "shield.lefthalf.filled")
                    .foregroundStyle(.tt.textWarning)
                    .accessibilityLabel("检测到可疑输出")
            } else if tool.approvalSource != nil {
                Image(systemName: "checkmark.shield.fill")
                    .foregroundStyle(.tt.textSuccess)
                    .accessibilityLabel("已获授权")
            }
            if let status = ToolTimelineStatusPresentation.label(
                for: tool.resolvedExecutionPhase
            ) {
                Text(status)
            }
        }
        .font(.tt.codeXS)
        .foregroundStyle(statusColor)
        .lineLimit(1)
    }

    private var statusColor: Color {
        switch tool.resolvedExecutionPhase {
        case .preparing, .running: return .tt.textTertiary
        case .succeeded: return .clear
        case .failed: return .tt.textCritical
        }
    }
}

enum ToolExecutionDisplay {
    static func duration(_ milliseconds: Int) -> String {
        if milliseconds < 1_000 { return "\(milliseconds) ms" }
        return String(format: "%.1f s", Double(milliseconds) / 1_000)
    }
}

// MARK: - Tool detail（展开态：输入 + 结果）

/// 工具 step 的展开内容：终端 / diff / SQL / 搜索等走专用详情，其余工具回退到
/// 「输入」「结果 / 错误」两段文本化展示。时间线不再内联挂它，只有
/// `ExecutionDetailSheet` 会渲染。
struct ToolDetailSections: View {
    let tool: ToolCall

    var body: some View {
        ToolSpecificDetailBody(tool: tool)
    }
}

private struct ToolSpecificDetailBody: View {
    let tool: ToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            ToolRuntimeMetadataView(tool: tool)
            switch ToolKind.of(tool.name) {
            case .terminal:
                ToolTerminalDetailBody(tool: tool)
            case .ssh:
                ToolSSHDetailBody(tool: tool)
            case .fileRead:
                ToolFileDetailBody(tool: tool, mode: .read)
            case .fileWrite:
                ToolFileDetailBody(tool: tool, mode: .write)
            case .fileEdit:
                ToolDiffDetailBody(tool: tool)
            case .sql:
                ToolSQLDetailBody(tool: tool)
            case .webSearch:
                ToolWebSearchDetailBody(tool: tool)
            case .webFetch:
                ToolWebFetchDetailBody(tool: tool)
            case .codeSearch:
                ToolCodeSearchDetailBody(tool: tool)
            case .todo:
                ToolTodoDetailBody(tool: tool)
            case .record, .agentTask, .generic:
                ToolGenericDetailBody(tool: tool)
            }
        }
    }
}

private struct ToolRuntimeMetadataView: View {
    let tool: ToolCall

    var body: some View {
        if hasMetadata {
            HStack(spacing: TTSpacing.xs) {
                if let approvalSource = tool.approvalSource {
                    Label(
                        approvalSource == .user ? "用户已批准" : "按始终允许执行",
                        systemImage: "checkmark.shield.fill"
                    )
                    .foregroundStyle(.tt.textSuccess)
                }
                if tool.hasSuspiciousOutput {
                    Label("检测到可疑输出", systemImage: "shield.lefthalf.filled")
                        .foregroundStyle(.tt.textWarning)
                }
                if let outputBytes = tool.progressOutputBytes {
                    Text("\(outputBytes) B")
                        .foregroundStyle(.tt.textTertiary)
                }
                if tool.progressIsTruncated {
                    Text("输出已截断")
                        .foregroundStyle(.tt.textWarning)
                }
            }
            .font(.tt.codeXS)
            .lineLimit(1)
        }
    }

    private var hasMetadata: Bool {
        tool.approvalSource != nil || tool.hasSuspiciousOutput
            || tool.progressOutputBytes != nil || tool.progressIsTruncated
    }
}

private struct ToolGenericDetailBody: View {
    let tool: ToolCall

    private var inputRows: [ToolInputRow] {
        ToolPresentation.of(tool.name).humanizedInputRows(from: tool.inputJson)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            if !inputRows.isEmpty {
                ForEach(inputRows, id: \.label) { row in
                    ToolDetailBlock(label: row.label, text: row.value, isError: false)
                }
            }
            if let result = tool.visibleOutputText, !result.isEmpty {
                ToolDetailBlock(
                    label: tool.isError ? L10n.Agent.toolDrawerError : L10n.Agent.toolDrawerResult,
                    text: ToolResultPresentation.displayText(result, isError: tool.isError),
                    isError: tool.isError
                )
            } else if tool.isExecutionRunning {
                ToolRunningRow(text: L10n.Agent.toolDrawerRunning)
            }
            if !tool.inputJson.isEmpty {
                DisclosureGroup {
                    Text(ToolPresentation.prettyJSON(tool.inputJson))
                        .font(.tt.codeXS)
                        .foregroundStyle(.tt.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .copyOnLongPress(tool.inputJson)
                } label: {
                    Text(L10n.Agent.toolDrawerViewRaw)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ToolTerminalDetailBody: View {
    let tool: ToolCall

    private var input: [String: Any] { tool.inputObject ?? [:] }
    private var output: [String: Any] { tool.resultObject ?? [:] }
    private var command: String {
        tool.stringValue("command", "cmd", "script", in: input) ?? tool.name
    }
    private var cwd: String? {
        tool.stringValue("cwd", "working_dir", in: output) ?? tool.stringValue("cwd", "working_dir", in: input)
    }
    private var exitCode: Int? {
        tool.intValue("exit_code", "exitCode", "code", in: output)
    }
    private var outputText: String {
        let stdout = tool.stringValue("stdout", "output", in: output)
        let stderr = tool.stringValue("stderr", "error", in: output)
        return [stdout, stderr].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
    }
    private var effectiveOutput: String? {
        if !outputText.isEmpty { return outputText }
        return tool.visibleOutputText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? tool.visibleOutputText
            : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            HStack(spacing: TTSpacing.xs) {
                Text("$")
                    .font(.tt.codeSMSemibold)
                    .foregroundStyle(.tt.textTertiary)
                Text(command)
                    .font(.tt.codeSM)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                if let exitCode {
                    ToolStatusBadge(
                        text: "exit \(exitCode)",
                        color: exitCode == 0 ? .tt.textSuccess : .tt.textCritical,
                        background: (exitCode == 0 ? Color.tt.bgSuccess : Color.tt.bgCritical).opacity(0.12)
                    )
                }
            }
            if tool.isExecutionRunning, effectiveOutput == nil {
                ToolRunningRow(text: "执行中…")
            } else if tool.isError, effectiveOutput == nil {
                ToolFailureNotice(errorMessage: tool.resultText)
            } else if let effectiveOutput, !effectiveOutput.isEmpty {
                ToolTerminalOutputPreview(text: effectiveOutput, isError: tool.isError || (exitCode.map { $0 != 0 } ?? false))
            }
            if let cwd {
                Label(cwd, systemImage: "folder")
                    .font(.tt.codeXS)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }
}

private struct ToolSSHDetailBody: View {
    let tool: ToolCall

    private var input: [String: Any] { tool.inputObject ?? [:] }
    private var host: String {
        tool.stringValue("host", "hostname", "server", in: input) ?? "远端主机"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label(host, systemImage: "server.rack")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
            ToolTerminalDetailBody(tool: tool)
        }
    }
}

private struct ToolFileDetailBody: View {
    enum Mode { case read, write }
    let tool: ToolCall
    let mode: Mode

    private var input: [String: Any] { tool.inputObject ?? [:] }
    private var output: [String: Any] { tool.resultObject ?? [:] }
    private var path: String {
        tool.stringValue("path", "file_path", "filePath", "filename", "target_file", in: input) ?? tool.name
    }
    private var content: String? {
        if tool.isError, let result = tool.visibleOutputText, !result.isEmpty {
            return ToolResultPresentation.displayText(result, isError: true)
        }
        switch mode {
        case .read:
            return tool.stringValue("content", "text", in: output) ?? tool.resultText
        case .write:
            return tool.stringValue("content", "text", in: input) ?? tool.resultText
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label(path, systemImage: mode == .read ? "doc.text" : "square.and.pencil")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let content, !content.isEmpty {
                ToolCodePreview(
                    text: content,
                    language: ToolDisplayHelpers.language(for: path),
                    maxCharacters: 2400,
                    isError: tool.isError
                )
            } else if tool.isExecutionRunning {
                ToolRunningRow(text: mode == .read ? "读取中…" : "写入中…")
            } else if let result = tool.visibleOutputText, !result.isEmpty {
                ToolCodePreview(text: result, isError: tool.isError)
            }
        }
    }
}

private struct ToolDiffDetailBody: View {
    let tool: ToolCall

    private var input: [String: Any] { tool.inputObject ?? [:] }
    private var path: String {
        tool.stringValue("path", "file_path", "filePath", "target_file", in: input) ?? "文件变更"
    }
    private var diff: String? {
        tool.stringValue("diff", "patch", in: input)
            ?? tool.stringValue("diff", "patch", in: tool.resultObject ?? [:])
            ?? replacementPreview
            ?? tool.resultText
    }
    private var replacementPreview: String? {
        guard let old = tool.stringValue("old_string", "oldText", "old", in: input),
              let new = tool.stringValue("new_string", "newText", "new", "replacement", in: input) else {
            return nil
        }
        let oldLines = old.components(separatedBy: "\n")
        let newLines = new.components(separatedBy: "\n")
        var lines = ["--- old", "+++ new"]
        lines.append(contentsOf: oldLines.prefix(80).map { "-\($0)" })
        lines.append(contentsOf: newLines.prefix(80).map { "+\($0)" })
        if oldLines.count > 80 || newLines.count > 80 {
            lines.append("… replacement preview truncated")
        }
        return lines.joined(separator: "\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label(path, systemImage: "pencil.line")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let diff, !diff.isEmpty {
                ToolDiffPreview(diff: diff, isError: tool.isError)
            } else if tool.isExecutionRunning {
                ToolRunningRow(text: "编辑中…")
            } else if let result = tool.visibleOutputText, !result.isEmpty {
                ToolCodePreview(text: result, isError: tool.isError)
            }
        }
    }
}

private struct ToolSQLDetailBody: View {
    let tool: ToolCall
    @State private var showMore = false

    private var input: [String: Any] { tool.inputObject ?? [:] }
    private var output: [String: Any] { tool.resultObject ?? [:] }
    private var query: String? { tool.stringValue("query", "sql", "statement", in: input) }
    private var rows: [[String: Any]] {
        if let rows = output["rows"] as? [[String: Any]] { return rows }
        if let rows = tool.resultArray as? [[String: Any]] { return rows }
        return []
    }
    private var columns: [String] {
        if let cols = output["columns"] as? [String], !cols.isEmpty { return cols }
        return Array(rows.flatMap(\.keys)).reduce(into: [String]()) { acc, key in
            if !acc.contains(key) { acc.append(key) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            if let query, !query.isEmpty {
                ToolCodePreview(text: query, language: "sql", maxCharacters: 1200, isError: false)
            }
            if !rows.isEmpty, !columns.isEmpty {
                ToolMiniTable(rows: Array(rows.prefix(showMore ? 40 : 8)), columns: columns)
                if rows.count > 8 && !showMore {
                    Button("显示 \(min(rows.count, 40)) / \(rows.count) 行") {
                        showMore = true
                    }
                    .font(.tt.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(.tt.textAccent)
                }
            } else if tool.isExecutionRunning {
                ToolRunningRow(text: "查询中…")
            } else if let result = tool.visibleOutputText, !result.isEmpty {
                ToolCodePreview(text: result, maxCharacters: 1800, isError: tool.isError)
            }
        }
    }
}

private struct ToolWebSearchDetailBody: View {
    let tool: ToolCall

    private var input: [String: Any] { tool.inputObject ?? [:] }
    private var output: [String: Any] { tool.resultObject ?? [:] }
    private var query: String { tool.stringValue("query", "q", "search_term", in: input) ?? "网页搜索" }
    private var results: [[String: Any]] {
        if let results = output["results"] as? [[String: Any]] { return results }
        if let results = tool.resultArray as? [[String: Any]] { return results }
        return []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label(query, systemImage: "magnifyingglass")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
            if !results.isEmpty {
                ForEach(Array(results.prefix(5).enumerated()), id: \.offset) { _, result in
                    ToolSearchResultRow(result: result)
                }
            } else if !tool.finalized {
                ToolRunningRow(text: "搜索中…")
            } else if let result = tool.resultText, !result.isEmpty {
                ToolCodePreview(text: result, maxCharacters: 1600, isError: tool.isError)
            }
        }
    }
}

private struct ToolWebFetchDetailBody: View {
    let tool: ToolCall

    private var input: [String: Any] { tool.inputObject ?? [:] }
    private var output: [String: Any] { tool.resultObject ?? [:] }
    private var url: String { tool.stringValue("url", "uri", "link", in: input) ?? "网页" }
    private var content: String? {
        tool.stringValue("content", "text", "markdown", in: output) ?? tool.visibleOutputText
    }
    private var sourceURL: URL? { URL(string: url).flatMap { $0.scheme == nil ? nil : $0 } }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label(url, systemImage: "globe")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let content, !content.isEmpty {
                Text(ToolDisplayHelpers.truncate(content, max: 900))
                    .font(.tt.meta)
                    .foregroundStyle(tool.isError ? .tt.textCritical : .tt.textPrimary)
                    .copyOnLongPress(content)
            } else if tool.isExecutionRunning {
                ToolRunningRow(text: "抓取中…")
            }
            if let sourceURL {
                Button {
                    UIApplication.shared.open(sourceURL)
                } label: {
                    Label("打开来源", systemImage: "safari")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textAccent)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct ToolCodeSearchDetailBody: View {
    let tool: ToolCall
    @State private var showMore = false

    private var input: [String: Any] {
        let root = tool.inputObject ?? [:]
        if let kwargs = root["kwargs"] as? [String: Any] {
            return root.merging(kwargs) { current, _ in current }
        }
        return root
    }
    private var output: [String: Any] { tool.resultObject ?? [:] }
    private var pattern: String {
        tool.stringValue("pattern", "query", "regex", "path", "glob", in: input) ?? tool.name
    }
    private var matches: [[String: Any]] {
        if let results = output["results"] as? [[String: Any]] { return results }
        if let results = output["matches"] as? [[String: Any]] { return results }
        if let files = output["files"] as? [[String: Any]] { return files }
        return tool.resultArray?.compactMap { $0 as? [String: Any] } ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label(pattern, systemImage: "text.magnifyingglass")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if !matches.isEmpty {
                ForEach(Array(matches.prefix(showMore ? 20 : 6).enumerated()), id: \.offset) { _, match in
                    CodeSearchMatchRow(match: match)
                }
                if matches.count > 6 && !showMore {
                    Button("显示 \(min(matches.count, 20)) / \(matches.count) 条") {
                        showMore = true
                    }
                    .font(.tt.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(.tt.textAccent)
                }
            } else if tool.isExecutionRunning {
                ToolRunningRow(text: "搜索中…")
            } else if let result = tool.visibleOutputText, !result.isEmpty {
                ToolCodePreview(text: result, maxCharacters: 1600, isError: tool.isError)
            }
        }
    }
}

private struct ToolTodoDetailBody: View {
    let tool: ToolCall

    private var input: [String: Any] {
        let root = tool.inputObject ?? [:]
        if let kwargs = root["kwargs"] as? [String: Any] {
            return root.merging(kwargs) { current, _ in current }
        }
        return root
    }
    private var todos: [[String: Any]] {
        input["todos"] as? [[String: Any]]
            ?? input["items"] as? [[String: Any]]
            ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            if !todos.isEmpty {
                ForEach(Array(todos.prefix(8).enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: TTSpacing.xs) {
                        Image(systemName: icon(for: item))
                            .font(.tt.iconCaption)
                            .foregroundStyle(color(for: item))
                        Text(label(for: item))
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(2)
                    }
                }
            } else if tool.isExecutionRunning {
                ToolRunningRow(text: "更新中…")
            } else {
                ToolGenericDetailBody(tool: tool)
            }
        }
    }

    private func label(for item: [String: Any]) -> String {
        tool.stringValue("content", "text", "title", "task", in: item) ?? String(describing: item)
    }

    private func icon(for item: [String: Any]) -> String {
        switch (tool.stringValue("status", "state", in: item) ?? "").lowercased() {
        case "completed", "done": return "checkmark.circle.fill"
        case "in_progress", "running": return "play.circle.fill"
        default: return "circle"
        }
    }

    private func color(for item: [String: Any]) -> Color {
        switch (tool.stringValue("status", "state", in: item) ?? "").lowercased() {
        case "completed", "done": return .tt.textSuccess
        case "in_progress", "running": return .tt.textWarning
        default: return .tt.textTertiary
        }
    }
}

/// 带小标题的等宽文本块（输入 / 结果）：横向可滚动保留代码不换行。
private struct ToolDetailBlock: View {
    let label: String
    let text: String
    let isError: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            Text(label)
                .font(.tt.captionMedium)
                .foregroundStyle(isError ? .tt.textCritical : .tt.textTertiary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.tt.codeXS)
                    .foregroundStyle(isError ? .tt.textCritical : .tt.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .copyOnLongPress(text)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
