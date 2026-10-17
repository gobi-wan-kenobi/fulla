// swift-tools-version:5.9
// SPDX-License-Identifier: GPL-3.0-or-later
import PackageDescription

let package = Package(
    name: "FullaCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "FullaCore", targets: ["FullaCore"]),
    ],
    targets: [
        .target(name: "FullaCore"),
        .testTarget(name: "FullaCoreTests", dependencies: ["FullaCore"]),
    ]
)
