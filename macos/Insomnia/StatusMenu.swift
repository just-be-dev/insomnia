import AppKit
import ServiceManagement

/// The menu bar item. Holds no session logic: it renders the daemon's latest Status and sends requests.
final class StatusMenu: NSObject, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let daemon: DaemonClient
    private var status: Status?
    private var connected = false
    private var ticker: Timer?

    private static let durations: [(String, Int?)] = [
        ("Until Stopped", nil),
        ("15 Minutes", 15 * 60),
        ("30 Minutes", 30 * 60),
        ("1 Hour", 60 * 60),
        ("2 Hours", 2 * 60 * 60),
        ("4 Hours", 4 * 60 * 60),
        ("8 Hours", 8 * 60 * 60),
    ]
    private static let thresholds: [Int?] = [nil, 10, 20, 30, 50]

    init(daemon: DaemonClient) {
        self.daemon = daemon
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        daemon.onEvent = { [weak self] event in self?.handle(event) }
        daemon.onConnectionChange = { [weak self] connected in
            self?.connected = connected
            if !connected { self?.status = nil }
            self?.render()
        }
        // Keeps the remaining-time title current.
        ticker = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.renderButton()
        }
        render()
    }

    // MARK: Events

    private func handle(_ event: Event) {
        switch event {
        case .status(let next):
            status = next
            render()
        case .error(let kind, let message):
            showError(kind: kind, message: message)
        case .unknown:
            break
        }
    }

    private func showError(kind: String, message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = Self.errorTitle(kind)
        alert.informativeText = message
        if kind == "PrivilegesMissing" {
            alert.addButton(withTitle: "Install Permissions…")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn { daemon.send(.installPrivileges) }
        } else {
            alert.runModal()
        }
    }

    private static func errorTitle(_ kind: String) -> String {
        switch kind {
        case "BatteryTooLow": return "Battery too low to keep awake"
        case "PrivilegesMissing": return "Insomnia needs permission"
        case "PrivilegeInstallFailed": return "Couldn't install permissions"
        default: return "Insomnia"
        }
    }

    // MARK: Rendering

    func menuNeedsUpdate(_ menu: NSMenu) {
        daemon.send(.refresh)
        rebuildMenu()
    }

    private func render() {
        renderButton()
        rebuildMenu()
    }

    private func renderButton() {
        guard let button = item.button else { return }
        let symbol: String
        var title = ""
        switch (connected, status) {
        case (false, _), (true, nil):
            symbol = "exclamationmark.triangle"
        case (true, let status?):
            switch status.session {
            case .active(_, let endsAt):
                symbol = "cup.and.heat.waves.fill"
                if let endsAt { title = Self.shortRemaining(until: endsAt) }
            case .idle:
                symbol = status.sleepDisabled ? "exclamationmark.triangle" : "moon.zzz.fill"
            }
        }
        // Newer symbols (steaming cup) fall back to the plain cup on older macOS.
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Insomnia")
            ?? NSImage(systemSymbolName: "cup.and.saucer.fill", accessibilityDescription: "Insomnia")
        button.image?.isTemplate = true
        button.title = title.isEmpty ? "" : " \(title)"
        button.imagePosition = .imageLeading
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        guard connected, let status else {
            menu.addItem(info("Starting daemon…"))
            menu.addItem(info("Logs: ~/Library/Logs/insomnia.log"))
            menu.addItem(.separator())
            menu.addItem(action("Quit Insomnia", #selector(quit), key: "q"))
            return
        }

        switch status.session {
        case .active(_, let endsAt?):
            menu.addItem(info("Awake · \(Self.longRemaining(until: endsAt)) left (until \(Self.clock(endsAt)))"))
        case .active(_, nil):
            menu.addItem(info("Awake until stopped"))
        case .idle where status.sleepDisabled:
            menu.addItem(info("Sleep is disabled outside Insomnia"))
        case .idle:
            menu.addItem(info("Sleeping normally"))
        }
        if let battery = status.battery {
            menu.addItem(info("Battery \(battery.percent)% · \(battery.onAC ? "on power adapter" : "on battery")"))
        }
        if case .idle = status.session, let ended = status.lastEnded {
            menu.addItem(info("Last session \(Self.describe(ended.reason)) at \(Self.clock(ended.at))"))
        }

        menu.addItem(.separator())

        let keepAwake = NSMenuItem(title: isActive ? "Keep Awake For" : "Keep Awake", action: nil, keyEquivalent: "")
        let durations = NSMenu()
        for (title, seconds) in Self.durations {
            let entry = action(title, #selector(startSession(_:)))
            entry.representedObject = seconds
            durations.addItem(entry)
        }
        keepAwake.submenu = durations
        keepAwake.isEnabled = status.privilegesGranted
        menu.addItem(keepAwake)

        if isActive {
            menu.addItem(action("Stop Keeping Awake", #selector(stopSession), key: "s"))
        } else if status.sleepDisabled {
            menu.addItem(action("Restore Normal Sleep", #selector(stopSession)))
        }

        menu.addItem(.separator())

        let safety = NSMenuItem(title: "Low Battery Stop", action: nil, keyEquivalent: "")
        let thresholds = NSMenu()
        for threshold in Self.thresholds {
            let entry = action(threshold.map { "At \($0)%" } ?? "Off", #selector(setThreshold(_:)))
            entry.representedObject = threshold
            entry.state = threshold == status.settings.lowBatteryThreshold ? .on : .off
            thresholds.addItem(entry)
        }
        safety.submenu = thresholds
        menu.addItem(safety)

        if !status.privilegesGranted {
            menu.addItem(action("Install Permissions…", #selector(installPrivileges)))
        }

        let login = action("Launch at Login", #selector(toggleLaunchAtLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)

        menu.addItem(.separator())
        menu.addItem(action("Quit Insomnia", #selector(quit), key: "q"))
    }

    private var isActive: Bool {
        if case .active = status?.session { return true }
        return false
    }

    private func info(_ title: String) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        entry.isEnabled = false
        return entry
    }

    private func action(_ title: String, _ selector: Selector, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        entry.target = self
        return entry
    }

    // MARK: Actions

    @objc private func startSession(_ sender: NSMenuItem) {
        daemon.send(.start(durationSeconds: sender.representedObject as? Int))
    }

    @objc private func stopSession() { daemon.send(.stop) }

    @objc private func setThreshold(_ sender: NSMenuItem) {
        daemon.send(.setLowBatteryThreshold(percent: sender.representedObject as? Int))
    }

    @objc private func installPrivileges() { daemon.send(.installPrivileges) }

    @objc private func toggleLaunchAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            showError(kind: "LaunchAtLogin", message: "Couldn't change Launch at Login: \(error.localizedDescription)")
        }
        rebuildMenu()
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: Formatting

    private static func remainingSeconds(until endsAt: Double) -> Int {
        max(0, Int((endsAt / 1000 - Date().timeIntervalSince1970).rounded(.up)))
    }

    /// Menu bar title: "1h 12m", "42m", "<1m".
    static func shortRemaining(until endsAt: Double) -> String {
        let minutes = (remainingSeconds(until: endsAt) + 59) / 60
        if minutes < 1 { return "<1m" }
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }

    static func longRemaining(until endsAt: Double) -> String {
        let minutes = (remainingSeconds(until: endsAt) + 59) / 60
        if minutes >= 60 {
            let h = minutes / 60, m = minutes % 60
            return m == 0 ? "\(h) hr" : "\(h) hr \(m) min"
        }
        return minutes < 1 ? "less than a minute" : "\(minutes) min"
    }

    static func clock(_ epochMillis: Double) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: Date(timeIntervalSince1970: epochMillis / 1000))
    }

    static func describe(_ reason: String) -> String {
        switch reason {
        case "Expired": return "ended on schedule"
        case "LowBattery": return "stopped for low battery"
        case "External": return "ended by another app"
        case "Shutdown": return "ended when Insomnia quit"
        default: return "stopped"
        }
    }
}
