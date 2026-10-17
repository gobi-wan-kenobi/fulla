# Fulla for iPhone

A native iPhone app (Swift and SwiftUI, iOS 17+). Right now it is only a
scaffold: one placeholder screen and an empty `FullaCore` package. No logic
has been written yet.

## Layout

- `FullaCore/`: a Swift package for the domain logic. It uses Foundation
  only, so it builds and tests on Linux as well as macOS.
- `Fulla/`: the SwiftUI app.
- `project.yml`: the [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec.
  The `.xcodeproj` is generated from it and not committed.

## Build

```sh
cd ios/FullaCore && swift test     # the package, on macOS or Linux
cd ios && xcodegen generate         # then open Fulla.xcodeproj in Xcode
```

CI (`.github/workflows/ios.yml`) runs the package tests and builds the app
for the iOS Simulator without signing.

## Licence

GPL-3.0-or-later, the same as the rest of the repository.
