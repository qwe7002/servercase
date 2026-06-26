import SwiftUI

/// Chooses the layout for the current device: a sidebar + detail split view in
/// regular width (iPad, and iPhone landscape on large models) and the
/// single-column navigation stack in compact width (iPhone).
struct RootView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        if horizontalSizeClass == .regular {
            ServerSplitView()
        } else {
            ServerListView()
        }
    }
}
