import SwiftUI
import WidgetKit

/// Entry point for the widget extension. Only the connection Live Activity is
/// vended for now; home-screen widgets can be added to this bundle later.
@main
struct ServerCaseWidgetBundle: WidgetBundle {
    var body: some Widget {
        ServerActivityWidget()
    }
}
