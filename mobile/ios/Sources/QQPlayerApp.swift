import SwiftUI

@main
struct QQPlayerApp: App {
    @StateObject private var pairingStore = PairingStore.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(pairingStore)
                .preferredColorScheme(.dark)
        }
    }
}
