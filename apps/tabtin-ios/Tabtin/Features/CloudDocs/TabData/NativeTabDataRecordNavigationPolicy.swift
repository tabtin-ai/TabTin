import Foundation

struct NativeTabDataRecordNeighbor: Equatable {
    var previousId: String?
    var nextId: String?
}

enum NativeTabDataRecordNavigationPolicy {
    static func neighbors(recordIds: [String], currentId: String) -> NativeTabDataRecordNeighbor {
        guard let index = recordIds.firstIndex(of: currentId) else {
            return NativeTabDataRecordNeighbor(previousId: nil, nextId: nil)
        }
        return NativeTabDataRecordNeighbor(
            previousId: index > 0 ? recordIds[index - 1] : nil,
            nextId: index + 1 < recordIds.count ? recordIds[index + 1] : nil
        )
    }
}
