import SwiftUI

@main
struct ServerCaseApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ServerListView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
    }
}
