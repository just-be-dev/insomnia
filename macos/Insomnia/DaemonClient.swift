import Foundation

/// Runs the Effect daemon as a child process and speaks JSON lines over its stdin/stdout.
///
/// The daemon restores normal sleep when its stdin closes, so if this app quits or crashes the
/// pipe closes and the Mac goes back to sleeping normally. If the daemon dies on its own, it is
/// restarted with backoff, and on startup it recovers or cleans up any saved session.
final class DaemonClient {
    var onEvent: ((Event) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    private var process: Process?
    private var stdin: FileHandle?
    private var buffer = Data()
    private var stopping = false
    private var restartDelay: TimeInterval = 1
    private var launchedAt = Date()

    func start() {
        stopping = false
        launch()
    }

    func send(_ request: Request) {
        guard let stdin else { return }
        do {
            try stdin.write(contentsOf: request.jsonLine())
        } catch {
            log("write failed: \(error)")
        }
    }

    /// Closes stdin so the daemon restores sleep and exits, then waits up to `timeout`.
    func stop(timeout: TimeInterval = 5, completion: @escaping () -> Void) {
        stopping = true
        guard let process, process.isRunning else { return completion() }
        try? stdin?.close()
        stdin = nil
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning && Date() < deadline { usleep(50_000) }
            if process.isRunning { process.terminate() }
            DispatchQueue.main.async(execute: completion)
        }
    }

    private func launch() {
        guard let (executable, arguments) = Self.daemonCommand() else {
            log("daemon executable not found")
            scheduleRestart()
            return
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = Self.logHandle() ?? FileHandle.standardError

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.receive(data) }
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.terminated(status: proc.terminationStatus) }
        }

        do {
            try process.run()
        } catch {
            log("couldn't launch daemon: \(error)")
            scheduleRestart()
            return
        }
        self.process = process
        self.stdin = input.fileHandleForWriting
        self.buffer = Data()
        self.launchedAt = Date()
        onConnectionChange?(true)
    }

    private func receive(_ data: Data) {
        guard !data.isEmpty else { return }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !line.isEmpty else { continue }
            do {
                onEvent?(try JSONDecoder().decode(Event.self, from: line))
            } catch {
                log("undecodable event: \(String(decoding: line, as: UTF8.self))")
            }
        }
    }

    private func terminated(status: Int32) {
        process = nil
        stdin = nil
        onConnectionChange?(false)
        guard !stopping else { return }
        log("daemon exited with status \(status); restarting")
        // Reset backoff after a daemon that ran for a while.
        if Date().timeIntervalSince(launchedAt) > 60 { restartDelay = 1 }
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopping, self.process == nil else { return }
            self.launch()
        }
    }

    /// `INSOMNIA_DEV_ROOT=/path/to/repo` runs the daemon from source with Bun;
    /// otherwise the compiled daemon bundled in Contents/Resources is used.
    static func daemonCommand() -> (URL, [String])? {
        let env = ProcessInfo.processInfo.environment
        if let root = env["INSOMNIA_DEV_ROOT"] {
            let bun = env["INSOMNIA_BUN"] ?? "\(NSHomeDirectory())/.local/share/mise/installs/bun/latest/bin/bun"
            return (URL(fileURLWithPath: bun), ["\(root)/src/main.ts", "daemon"])
        }
        guard let bundled = Bundle.main.url(forResource: "insomnia", withExtension: nil) else { return nil }
        return (bundled, ["daemon"])
    }

    static var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/insomnia.log")
    }

    private static func logHandle() -> FileHandle? {
        let url = logURL
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
        return handle
    }

    private func log(_ message: String) {
        FileHandle.standardError.write(Data("insomnia: \(message)\n".utf8))
    }
}
