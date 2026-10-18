import Foundation

// Mirrors src/daemon/protocol.ts and src/session/model.ts. Times are epoch milliseconds.

struct Settings: Decodable, Equatable {
    let lowBatteryThreshold: Int?
}

struct Battery: Decodable, Equatable {
    let percent: Int
    let onAC: Bool
}

struct Ended: Decodable, Equatable {
    let reason: String
    let at: Double
}

enum Session: Decodable, Equatable {
    case idle
    case active(startedAt: Double, endsAt: Double?)

    private enum CodingKeys: String, CodingKey { case _tag, startedAt, endsAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: ._tag) {
        case "Active":
            self = .active(
                startedAt: try c.decode(Double.self, forKey: .startedAt),
                endsAt: try c.decodeIfPresent(Double.self, forKey: .endsAt)
            )
        default:
            self = .idle
        }
    }
}

struct Status: Decodable, Equatable {
    let session: Session
    let lastEnded: Ended?
    let settings: Settings
    let sleepDisabled: Bool
    let battery: Battery?
    let privileges: String

    var privilegesGranted: Bool { privileges == "Granted" }
}

enum Event: Decodable {
    case status(Status)
    case error(kind: String, message: String)
    case unknown

    private enum CodingKeys: String, CodingKey { case _tag, status, kind, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: ._tag) {
        case "Status":
            self = .status(try c.decode(Status.self, forKey: .status))
        case "Error":
            self = .error(
                kind: try c.decode(String.self, forKey: .kind),
                message: try c.decode(String.self, forKey: .message)
            )
        default:
            self = .unknown
        }
    }
}

enum Request {
    case start(durationSeconds: Int?)
    case stop
    case setLowBatteryThreshold(percent: Int?)
    case installPrivileges
    case refresh

    /// One JSON line. Nulls are explicit because the daemon's schema requires the keys.
    func jsonLine() -> Data {
        let object: [String: Any]
        switch self {
        case .start(let seconds):
            object = ["_tag": "Start", "durationSeconds": seconds.map { $0 as Any } ?? NSNull()]
        case .stop:
            object = ["_tag": "Stop"]
        case .setLowBatteryThreshold(let percent):
            object = ["_tag": "SetLowBatteryThreshold", "percent": percent.map { $0 as Any } ?? NSNull()]
        case .installPrivileges:
            object = ["_tag": "InstallPrivileges"]
        case .refresh:
            object = ["_tag": "Refresh"]
        }
        var data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        data.append(0x0A)
        return data
    }
}
