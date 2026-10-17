// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI
import FullaCore

struct ContentView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "Fulla for iPhone",
                systemImage: "house",
                description: Text("Coming soon. Version \(FullaCore.version)")
            )
            .navigationTitle("Fulla")
        }
    }
}

#Preview {
    ContentView()
}
