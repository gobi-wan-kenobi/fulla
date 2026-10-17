// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import FullaCore

final class FullaCoreTests: XCTestCase {
    func testPackageLoads() {
        XCTAssertFalse(FullaCore.version.isEmpty)
    }
}
