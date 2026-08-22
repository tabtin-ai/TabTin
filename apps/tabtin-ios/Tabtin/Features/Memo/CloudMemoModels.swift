import Foundation
import SwiftUI

enum CloudMemoStatus: String, CaseIterable, Identifiable, Hashable, Sendable {
    case active
    case archived

    var id: String { rawValue }
    var title: String { self == .active ? L10n.MemoAppHome.statusActive : L10n.MemoAppHome.statusArchived }
}

/// 快捷落笔附件状态机：create Memo → OSS → attachments；失败保留正文。
enum MemoAttachmentPhase: String, Equatable, Sendable {
    case idle
    case selected
    case uploading
    case binding
    case ready
    case failed
}

/// Memo 详情页上下文。云端 tab 与 Space 详情页（经 SpaceAppRouteScreen）共用。
struct CloudMemoDetailContext: Identifiable, Hashable {
    let memoId: String
    let title: String
    let spaceName: String?
    let status: CloudMemoStatus

    init(
        memoId: String,
        title: String,
        spaceName: String?,
        status: CloudMemoStatus = .active
    ) {
        self.memoId = memoId
        self.title = title
        self.spaceName = spaceName
        self.status = status
    }

    var id: String { memoId }
}

enum MemoColor: String, CaseIterable, Identifiable, Hashable, Sendable {
    case none = ""
    case yellow
    case blue
    case green
    case pink
    case purple
    case orange
    case gray

    var id: String { rawValue.isEmpty ? "none" : rawValue }

    static let selectableCases: [MemoColor] = [
        .yellow, .blue, .green, .pink, .purple, .orange, .gray,
    ]

    var displayName: String {
        switch self {
        case .none: return L10n.MemoAppHome.colorNone
        case .yellow: return L10n.MemoAppHome.colorYellow
        case .blue: return L10n.MemoAppHome.colorBlue
        case .green: return L10n.MemoAppHome.colorGreen
        case .pink: return L10n.MemoAppHome.colorPink
        case .purple: return L10n.MemoAppHome.colorPurple
        case .orange: return L10n.MemoAppHome.colorOrange
        case .gray: return L10n.MemoAppHome.colorGray
        }
    }

    var swatch: Color {
        switch self {
        case .none: return .tt.bgSubtle
        case .yellow: return Color(red: 1.0, green: 0.86, blue: 0.35)
        case .blue: return Color(red: 0.45, green: 0.72, blue: 1.0)
        case .green: return Color(red: 0.45, green: 0.82, blue: 0.55)
        case .pink: return Color(red: 1.0, green: 0.55, blue: 0.70)
        case .purple: return Color(red: 0.72, green: 0.55, blue: 0.95)
        case .orange: return Color(red: 1.0, green: 0.65, blue: 0.35)
        case .gray: return Color(red: 0.72, green: 0.70, blue: 0.68)
        }
    }

    var softBackground: Color {
        switch self {
        case .none: return .tt.bgSubtle
        default: return swatch.opacity(0.18)
        }
    }
}

struct CloudMemoListResponse: Decodable, Sendable {
    let items: [CloudMemoSummary]
    let nextCursor: String?
    let hasMore: Bool?

    enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
        case hasMore = "has_more"
    }
}

struct CloudMemoSummary: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let spaceId: String?
    let memoType: String?
    let contentPlaintext: String?
    let contentMarkdown: String?
    let tags: [String]
    let aiTags: [String]
    let color: String?
    let source: String?
    let status: String?
    let isPinned: Bool
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case spaceId = "space_id"
        case memoType = "memo_type"
        case contentPlaintext = "content_plaintext"
        case contentMarkdown = "content_markdown"
        case tags
        case aiTags = "ai_tags"
        case color
        case source
        case status
        case isPinned = "is_pinned"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(
        id: String,
        spaceId: String? = nil,
        memoType: String? = "note",
        contentPlaintext: String? = nil,
        contentMarkdown: String? = nil,
        tags: [String] = [],
        aiTags: [String] = [],
        color: String? = nil,
        source: String? = "manual",
        status: String? = "active",
        isPinned: Bool = false,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.spaceId = spaceId
        self.memoType = memoType
        self.contentPlaintext = contentPlaintext
        self.contentMarkdown = contentMarkdown
        self.tags = tags
        self.aiTags = aiTags
        self.color = color
        self.source = source
        self.status = status
        self.isPinned = isPinned
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        spaceId = try container.decodeIfPresent(String.self, forKey: .spaceId)
        memoType = try container.decodeIfPresent(String.self, forKey: .memoType)
        contentPlaintext = try container.decodeIfPresent(String.self, forKey: .contentPlaintext)
        contentMarkdown = try container.decodeIfPresent(String.self, forKey: .contentMarkdown)
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        aiTags = try container.decodeIfPresent([String].self, forKey: .aiTags) ?? []
        color = try container.decodeIfPresent(String.self, forKey: .color)
        source = try container.decodeIfPresent(String.self, forKey: .source)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        isPinned = try container.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    var displayText: String {
        let text = (contentPlaintext?.isEmpty == false ? contentPlaintext : contentMarkdown) ?? ""
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? L10n.MemoAppHome.emptyMemoTitle
            : text
    }

    var allTags: [String] {
        var seen = Set<String>()
        return (tags + aiTags).filter { seen.insert($0).inserted }
    }

    var memoColor: MemoColor {
        MemoColor(rawValue: color ?? "") ?? .none
    }

    var isAgentSource: Bool {
        (source ?? "").lowercased() == "agent"
    }

    func withPinned(_ pinned: Bool) -> CloudMemoSummary {
        CloudMemoSummary(
            id: id,
            spaceId: spaceId,
            memoType: memoType,
            contentPlaintext: contentPlaintext,
            contentMarkdown: contentMarkdown,
            tags: tags,
            aiTags: aiTags,
            color: color,
            source: source,
            status: status,
            isPinned: pinned,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    private nonisolated(unsafe) static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private nonisolated(unsafe) static let isoBasic: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parseDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return isoFractional.date(from: raw) ?? isoBasic.date(from: raw)
    }

    var createdDate: Date? { Self.parseDate(createdAt) }

    var sortTimestamp: Date {
        Self.parseDate(updatedAt) ?? Self.parseDate(createdAt) ?? .distantPast
    }
}
