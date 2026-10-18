import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let daemon = DaemonClient()
    private var statusMenu: StatusMenu?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Writing to a daemon that just died must not kill the app.
        signal(SIGPIPE, SIG_IGN)
        statusMenu = StatusMenu(daemon: daemon)
        daemon.start()
    }

    /// Give the daemon a moment to restore normal sleep before the app exits.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        daemon.stop { sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
