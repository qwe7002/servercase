import SwiftUI
import WidgetKit

/// Widget extension entry point. Hosts the connection Live Activity; add more
/// widgets to the bundle here if the app grows Home Screen widgets later.
@main
struct ConnectionWidgetBundle: WidgetBundle {
    var body: some Widget {
        ConnectionLiveActivity()
    }
}
