import Foundation

struct RemoteFile: Identifiable, Hashable {
    var id: String { path }
    let name: String
    let path: String
    let isDirectory: Bool
    let isSymlink: Bool
    let sizeBytes: Int64
    let modifiedAt: Date
    /// Symbolic permission string, e.g. "rwxr-xr-x".
    let mode: String
}

struct RemoteListing {
    let path: String
    let entries: [RemoteFile]
}

enum RemoteFilesError: LocalizedError {
    case notADirectory(String)
    case command(String)

    var errorDescription: String? {
        switch self {
        case .notADirectory(let p): return "Cannot open \(p)"
        case .command(let m): return m
        }
    }
}

/// A remote file manager built on plain shell commands over the existing SSH
/// connection — the same "portable command + parse" approach the status
/// collector uses, so it needs nothing on the host beyond coreutils.
struct RemoteFiles {
    let service: SSHService

    /// Lists `path` (resolving it to an absolute path first).
    func list(_ path: String) async throws -> RemoteListing {
        let cmd = "cd \(quote(path)) 2>/dev/null && pwd && ls -lAL --time-style=+%s 2>/dev/null"
        let out = try await service.run(cmd)
        var lines = out.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard let abs = lines.first, abs.hasPrefix("/") else {
            throw RemoteFilesError.notADirectory(path)
        }
        lines.removeFirst()
        var entries: [RemoteFile] = []
        for line in lines {
            if line.isEmpty || line.hasPrefix("total ") { continue }
            if let f = parse(line, in: abs) { entries.append(f) }
        }
        entries.sort {
            if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        return RemoteListing(path: abs, entries: entries)
    }

    func readText(_ path: String) async throws -> String {
        try await service.run("cat \(quote(path))")
    }

    func writeText(_ path: String, _ content: String) async throws {
        let b64 = Data(content.utf8).base64EncodedString()
        _ = try await service.run("printf %s \(quote(b64)) | base64 -d > \(quote(path))")
    }

    func makeDirectory(_ path: String) async throws {
        _ = try await service.run("mkdir -p \(quote(path))")
    }

    func rename(_ from: String, to: String) async throws {
        _ = try await service.run("mv \(quote(from)) \(quote(to))")
    }

    func remove(_ path: String, isDirectory: Bool) async throws {
        _ = try await service.run((isDirectory ? "rm -r " : "rm -f ") + quote(path))
    }

    /// Downloads a remote file and writes it into the app's Documents dir,
    /// returning the local URL.
    func download(_ file: RemoteFile) async throws -> URL {
        let b64 = try await service.run("base64 \(quote(file.path))")
        guard let data = Data(base64Encoded: b64.replacingOccurrences(of: "\n", with: "")) else {
            throw RemoteFilesError.command("Failed to decode \(file.name)")
        }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = docs.appendingPathComponent(file.name)
        try data.write(to: url)
        return url
    }

    /// Uploads raw bytes to `dir/name` on the remote host.
    func upload(_ data: Data, to dir: String, name: String) async throws {
        let b64 = data.base64EncodedString()
        _ = try await service.run("printf %s \(quote(b64)) | base64 -d > \(quote(join(dir, name)))")
    }

    func join(_ dir: String, _ name: String) -> String {
        let base = dir.hasSuffix("/") ? String(dir.dropLast()) : dir
        return base.isEmpty ? "/\(name)" : "\(base)/\(name)"
    }

    // MARK: Parsing

    private func parse(_ line: String, in dir: String) -> RemoteFile? {
        // perms links owner group size epoch name...
        let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard parts.count >= 7 else { return nil }
        let perms = parts[0]
        let size = Int64(parts[4]) ?? 0
        let epoch = Double(parts[5]) ?? 0
        let name = parts[6...].joined(separator: " ")
        let isDir = perms.hasPrefix("d")
        let isLink = perms.hasPrefix("l")
        return RemoteFile(
            name: name,
            path: join(dir, name),
            isDirectory: isDir,
            isSymlink: isLink,
            sizeBytes: size,
            modifiedAt: Date(timeIntervalSince1970: epoch),
            mode: String(perms.dropFirst())
        )
    }

    private func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
