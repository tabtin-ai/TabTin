import Foundation

enum NativeTabDataSaveIndicatorPolicy {
    static func shows(_ state: NativeTabDataSaveState) -> Bool {
        switch state {
        case .dirty, .saving, .saved, .conflict, .permissionDenied, .failed: true
        case .idle: false
        }
    }

    static func showsRetry(_ state: NativeTabDataSaveState) -> Bool {
        state == .failed
    }
}
