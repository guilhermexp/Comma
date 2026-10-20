// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "CommaTranscriber",
    platforms: [
        // Builds for macOS 14 like the other helpers; the helper refuses to
        // run below macOS 15 (FluidAudio issue #878).
        .macOS(.v14),
    ],
    products: [
        .executable(name: "CommaTranscriber", targets: ["CommaTranscriber"]),
    ],
    dependencies: [
        // No traits: drops the NeMo text-normalization engine, which only
        // TTS and inverse text normalization use.
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            exact: "0.17.7",
            traits: []
        ),
    ],
    targets: [
        // Everything that does not touch FluidAudio: manifest, install
        // staging, word/speaker merge and the HTTP server.
        .target(
            name: "TranscriberCore",
            resources: [
                .embedInCode("models-manifest.json"),
            ]
        ),
        .executableTarget(
            name: "CommaTranscriber",
            dependencies: [
                "TranscriberCore",
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        ),
        .testTarget(
            name: "TranscriberCoreTests",
            dependencies: ["TranscriberCore"]
        ),
    ]
)
