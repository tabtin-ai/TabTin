import Foundation

enum NativeTabDataEmptyKind: Equatable {
    case noViews
    case noRecords
    case noMatches
    case emptyKanban
}

enum NativeTabDataEmptyPolicy {
    static func kind(
        hasViews: Bool,
        isKanban: Bool,
        recordCount: Int,
        hasActiveQuery: Bool
    ) -> NativeTabDataEmptyKind? {
        if !hasViews { return .noViews }
        if recordCount > 0 { return nil }
        if isKanban { return .emptyKanban }
        return hasActiveQuery ? .noMatches : .noRecords
    }
}
