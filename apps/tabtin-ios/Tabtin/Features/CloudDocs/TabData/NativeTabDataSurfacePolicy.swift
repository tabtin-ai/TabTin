import Foundation

enum NativeTabDataSurfaceKind: Equatable {
    case cards
    case kanban
    case summary
}

enum NativeTabDataSurfacePolicy {
    static func kind(viewType: String) -> NativeTabDataSurfaceKind {
        switch viewType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "grid", "list":
            return .cards
        case "kanban":
            return .kanban
        default:
            return .summary
        }
    }

    static func supportsNativeCards(viewType: String) -> Bool {
        let kind = kind(viewType: viewType)
        return kind == .cards || kind == .kanban
    }
}
