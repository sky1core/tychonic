// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TychonicNotify",
    platforms: [.macOS(.v11)],
    targets: [
        .executableTarget(
            name: "TychonicNotify",
            path: "Sources/TychonicNotify"
        )
    ]
)
