import Foundation

struct MobileEnvironmentConfiguration: Equatable, Sendable {
    let apiURL: String
    let websocketURL: String
    let webURL: String
    let centrifugoURL: String
}

enum MobileEnvironmentQRCodeError: Error {
    case invalidPayload
}

enum MobileEnvironmentQRCode {
    private static let scheme = "tabtin"
    private static let host = "mobile-environment"
    private static let supportedVersion = "1"
    private static let maximumPayloadLength = 4_096

    static func parse(_ rawValue: String) throws -> MobileEnvironmentConfiguration {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count <= maximumPayloadLength,
              let components = URLComponents(string: value),
              components.scheme?.lowercased() == scheme,
              components.host?.lowercased() == host else {
            throw MobileEnvironmentQRCodeError.invalidPayload
        }

        var values: [String: String] = [:]
        for item in components.queryItems ?? [] {
            guard let value = item.value, values.updateValue(value, forKey: item.name) == nil else {
                throw MobileEnvironmentQRCodeError.invalidPayload
            }
        }
        guard values["v"] == supportedVersion,
              let apiURL = validatedURL(values["api"], schemes: ["http", "https"]),
              let websocketURL = validatedURL(values["ws"], schemes: ["ws", "wss"]),
              let webURL = validatedURL(values["web"], schemes: ["http", "https"]),
              let centrifugoURL = validatedURL(values["centrifugo"], schemes: ["ws", "wss"]) else {
            throw MobileEnvironmentQRCodeError.invalidPayload
        }

        return MobileEnvironmentConfiguration(
            apiURL: apiURL,
            websocketURL: websocketURL,
            webURL: webURL,
            centrifugoURL: centrifugoURL
        )
    }

    private static func validatedURL(_ rawValue: String?, schemes: Set<String>) -> String? {
        guard let rawValue else { return nil }
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              schemes.contains(scheme),
              url.host != nil else {
            return nil
        }
        return value
    }
}
