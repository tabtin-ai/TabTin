// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WireRoundTrip",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "WireRoundTrip", targets: ["WireRoundTrip"]),
    ],
    targets: [
        .executableTarget(
            name: "WireRoundTrip",
            path: "Sources",
            exclude: []
        ),
    ]
)
