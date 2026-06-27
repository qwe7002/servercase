import SwiftUI
import UniformTypeIdentifiers

/// A FileZilla-style remote file manager, adapted to a single navigable pane
/// for phones: a path header, a file list, and per-row actions, backed by the
/// command-based `RemoteFiles` service.
struct FilesView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let server: ServerConfig

    @State private var path = "."
    @State private var listing: RemoteListing?
    @State private var loading = false
    @State private var log: [LogEntry] = []
    @State private var selectedPath: String?
    @State private var treeChildren: [String: [RemoteFile]] = [:]
    @State private var expandedPaths: Set<String> = ["/"]

    @State private var editing: EditingFile?
    @State private var renaming: RemoteFile?
    @State private var renameText = ""
    @State private var showNewFolder = false
    @State private var newFolderName = ""
    @State private var showImporter = false

    private static let maxEditBytes: Int64 = 512 * 1024

    private var files: RemoteFiles? {
        model.service(server.id).map { RemoteFiles(service: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if horizontalSizeClass == .regular {
                regularBrowser
            } else {
                compactBrowser
            }
            if horizontalSizeClass != .regular, let last = log.last {
                Text(last.text)
                    .font(.caption)
                    .foregroundStyle(last.isError ? Palette.danger : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal).padding(.vertical, 6)
            }
        }
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showNewFolder = true } label: { Image(systemName: "folder.badge.plus") }
                Button { showImporter = true } label: { Image(systemName: "arrow.up.doc") }
                Button { Task { await load(path) } } label: { Image(systemName: "arrow.clockwise") }
            }
        }
        .task { await load(".") }
        .sheet(item: $editing) { editor($0) }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item]) { result in
            handleUpload(result)
        }
        .alert("New folder", isPresented: $showNewFolder) {
            TextField("Name", text: $newFolderName)
            Button("Create") { createFolder() }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameText)
            Button("Rename") { confirmRename() }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }

    @ViewBuilder
    private var compactBrowser: some View {
        if loading && listing == nil {
            List {
                ForEach(0..<10, id: \.self) { _ in
                    HStack(spacing: 12) {
                        Image(systemName: "doc.text").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Placeholder file name")
                            Text("123 KB · rw-r--r-- · placeholder")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .redacted(reason: .placeholder)
        } else {
            List {
                ForEach(listing?.entries ?? []) { entry in
                    row(entry)
                }
                if (listing?.entries.isEmpty ?? false) {
                    Text("Empty directory.")
                        .foregroundStyle(.secondary)
                }
            }
            .listStyle(.plain)
        }
    }

    private var regularBrowser: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        FileTreeNode(
                            nodePath: "/",
                            name: "/",
                            depth: 0,
                            currentPath: listing?.path ?? path,
                            treeChildren: treeChildren,
                            expandedPaths: $expandedPaths,
                            onSelect: { target in Task { await load(target) } },
                            onToggle: toggleTree
                        )
                    }
                    .padding(.vertical, 6)
                }
                .frame(width: 260)
                .background(Palette.surface.opacity(0.35))

                Divider()

                VStack(spacing: 0) {
                    fileTableHeader
                    Divider()
                    ZStack(alignment: .top) {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                if loading && listing == nil {
                                    ForEach(0..<12, id: \.self) { _ in
                                        skeletonTableRow
                                    }
                                } else if (listing?.entries.isEmpty ?? false) {
                                    Text("Empty directory.")
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 36)
                                } else {
                                    ForEach(listing?.entries ?? []) { entry in
                                        tableRow(entry)
                                    }
                                }
                            }
                        }
                        if loading && listing != nil {
                            ProgressView()
                                .controlSize(.small)
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                    }
                }
            }
            Divider()
            logPanel
        }
    }

    /// FileZilla-style message log: every operation appends a timestamped line
    /// instead of replacing the previous one, and the view auto-scrolls to the
    /// newest entry.
    private var logPanel: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if log.isEmpty {
                        Text("Status messages appear here.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(log) { entry in
                        HStack(alignment: .top, spacing: 8) {
                            Text(entry.time, format: .dateTime.hour().minute().second())
                                .foregroundStyle(.secondary)
                            Text(entry.text)
                                .foregroundStyle(entry.isError ? Palette.danger : Palette.good)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .id(entry.id)
                    }
                }
                .font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            }
            .frame(height: 120)
            .background(Color(red: 0.04, green: 0.05, blue: 0.07))
            .onChange(of: log.count) { _, _ in
                guard let last = log.last else { return }
                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }

    private func appendLog(_ text: String, isError: Bool = false) {
        log.append(LogEntry(text: text, isError: isError))
    }

    private var fileTableHeader: some View {
        HStack(spacing: 12) {
            Text("Name").frame(maxWidth: .infinity, alignment: .leading)
            Text("Size").frame(width: 88, alignment: .trailing)
            Text("Type").frame(width: 110, alignment: .leading)
            Text("Last modified").frame(width: 150, alignment: .leading)
            Text("Permissions").frame(width: 86, alignment: .leading)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var skeletonTableRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.text").foregroundStyle(.secondary)
            RoundedRectangle(cornerRadius: 4).fill(.secondary.opacity(0.18)).frame(height: 12)
            RoundedRectangle(cornerRadius: 4).fill(.secondary.opacity(0.18)).frame(width: 70, height: 12)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .redacted(reason: .placeholder)
    }

    private func tableRow(_ entry: RemoteFile) -> some View {
        Button {
            selectedPath = entry.path
            open(entry)
        } label: {
            HStack(spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: icon(entry))
                        .foregroundStyle(entry.isDirectory ? Palette.warn : .secondary)
                    Text(entry.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Text(entry.isDirectory ? "" : Format.bytes(Double(entry.sizeBytes)))
                    .frame(width: 88, alignment: .trailing)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Text(typeLabel(entry))
                    .frame(width: 110, alignment: .leading)
                    .foregroundStyle(.secondary)
                Text(entry.modifiedAt.formatted(date: .numeric, time: .shortened))
                    .frame(width: 150, alignment: .leading)
                    .foregroundStyle(.secondary)
                Text(entry.mode)
                    .font(.system(.caption, design: .monospaced))
                    .frame(width: 86, alignment: .leading)
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(selectedPath == entry.path ? Palette.accent.opacity(0.18) : Color.clear)
        .contextMenu {
            Button { open(entry) } label: { Label("Open", systemImage: entry.isDirectory ? "folder" : "doc.text") }
            if !entry.isDirectory {
                Button { download(entry) } label: { Label("Save", systemImage: "square.and.arrow.down") }
            }
            Button { renaming = entry; renameText = entry.name } label: { Label("Rename", systemImage: "pencil") }
            Button(role: .destructive) { remove(entry) } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func toggleTree(_ nodePath: String) {
        if expandedPaths.contains(nodePath) {
            expandedPaths.remove(nodePath)
        } else {
            expandedPaths.insert(nodePath)
            if treeChildren[nodePath] == nil {
                Task { await cacheTreeChildren(nodePath) }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button { Task { await goUp() } } label: { Image(systemName: "arrow.up") }
            Text(listing?.path ?? path)
                .font(.system(.footnote, design: .monospaced))
                .lineLimit(1).truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal).padding(.vertical, 8)
    }

    private func row(_ entry: RemoteFile) -> some View {
        Button {
            open(entry)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon(entry))
                    .foregroundStyle(entry.isDirectory ? Palette.warn : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name).foregroundStyle(.primary)
                    Text(detail(entry)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if entry.isDirectory {
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { remove(entry) } label: { Label("Delete", systemImage: "trash") }
            Button { renaming = entry; renameText = entry.name } label: { Label("Rename", systemImage: "pencil") }
                .tint(.gray)
            if !entry.isDirectory {
                Button { download(entry) } label: { Label("Save", systemImage: "square.and.arrow.down") }
                    .tint(Palette.accent)
            }
        }
    }

    private func editor(_ file: EditingFile) -> some View {
        NavigationStack {
            TextEditor(text: Binding(
                get: { editing?.content ?? file.content },
                set: { editing?.content = $0 }
            ))
            .font(.system(.footnote, design: .monospaced))
            .navigationTitle(file.entry.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { editing = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(file) }
                }
            }
        }
    }

    // MARK: Actions

    private func load(_ target: String) async {
        guard let files else { return }
        loading = true
        defer { loading = false }
        do {
            let result = try await files.list(target)
            listing = result
            path = result.path
            selectedPath = nil
            await updateTreeCache(for: result)
            appendLog("Listing \(result.path) — \(result.entries.count) items")
        } catch {
            appendLog(error.localizedDescription, isError: true)
        }
    }

    private func cacheTreeChildren(_ target: String) async {
        guard let files else { return }
        do {
            let result = try await files.list(target)
            treeChildren[result.path] = result.entries.filter { $0.isDirectory }
        } catch {
            appendLog(error.localizedDescription, isError: true)
        }
    }

    private func updateTreeCache(for result: RemoteListing) async {
        treeChildren[result.path] = result.entries.filter { $0.isDirectory }
        let chain = ancestorPaths(result.path)
        for item in chain { expandedPaths.insert(item) }
        guard let files else { return }
        for item in chain where treeChildren[item] == nil {
            if let parent = try? await files.list(item) {
                treeChildren[parent.path] = parent.entries.filter { $0.isDirectory }
            }
        }
    }

    private func goUp() async {
        let current = listing?.path ?? path
        let parent = current.split(separator: "/").dropLast().joined(separator: "/")
        await load(parent.isEmpty ? "/" : "/" + parent)
    }

    private func open(_ entry: RemoteFile) {
        selectedPath = entry.path
        if entry.isDirectory {
            Task { await load(entry.path) }
            return
        }
        guard entry.sizeBytes <= Self.maxEditBytes else {
            appendLog("\(entry.name) is too large to edit — use Save to download it.", isError: true)
            return
        }
        Task {
            guard let files else { return }
            do {
                let content = try await files.readText(entry.path)
                editing = EditingFile(entry: entry, content: content)
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    private func save(_ file: EditingFile) {
        Task {
            guard let files, let content = editing?.content else { return }
            do {
                try await files.writeText(file.entry.path, content)
                appendLog("Saved \(file.entry.name)")
                editing = nil
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    private func remove(_ entry: RemoteFile) {
        Task {
            guard let files else { return }
            do {
                try await files.remove(entry.path, isDirectory: entry.isDirectory)
                await load(path)
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    private func confirmRename() {
        guard let entry = renaming, let files else { return }
        let name = renameText.trimmingCharacters(in: .whitespaces)
        renaming = nil
        guard !name.isEmpty, name != entry.name else { return }
        Task {
            do {
                try await files.rename(entry.path, to: files.join(path, name))
                await load(path)
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    private func createFolder() {
        guard let files else { return }
        let name = newFolderName.trimmingCharacters(in: .whitespaces)
        newFolderName = ""
        guard !name.isEmpty else { return }
        Task {
            do {
                try await files.makeDirectory(files.join(path, name))
                await load(path)
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    private func download(_ entry: RemoteFile) {
        Task {
            guard let files else { return }
            do {
                let url = try await files.download(entry)
                appendLog("Saved to \(url.lastPathComponent) in Files")
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    private func handleUpload(_ result: Result<URL, Error>) {
        guard let files else { return }
        switch result {
        case .success(let url):
            Task {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                do {
                    let data = try Data(contentsOf: url)
                    try await files.upload(data, to: path, name: url.lastPathComponent)
                    appendLog("Uploaded \(url.lastPathComponent)")
                    await load(path)
                } catch {
                    appendLog(error.localizedDescription, isError: true)
                }
            }
        case .failure(let error):
            appendLog(error.localizedDescription, isError: true)
        }
    }

    private func icon(_ entry: RemoteFile) -> String {
        if entry.isDirectory { return "folder.fill" }
        if entry.isSymlink { return "link" }
        return "doc.text"
    }

    private func typeLabel(_ entry: RemoteFile) -> String {
        if entry.isDirectory { return "Directory" }
        if entry.isSymlink { return "Symbolic link" }
        if let dot = entry.name.lastIndex(of: "."), dot > entry.name.startIndex {
            return "\(entry.name[entry.name.index(after: dot)...].lowercased()) file"
        }
        return "File"
    }

    private func detail(_ entry: RemoteFile) -> String {
        let when = entry.modifiedAt.formatted(date: .abbreviated, time: .shortened)
        if entry.isDirectory { return "\(entry.mode) · \(when)" }
        return "\(Format.bytes(Double(entry.sizeBytes))) · \(entry.mode) · \(when)"
    }
}

private func ancestorPaths(_ path: String) -> [String] {
    let parts = path.split(separator: "/").map(String.init)
    var out = ["/"]
    var current = ""
    for part in parts {
        current += "/" + part
        out.append(current)
    }
    return out
}

private struct FileTreeNode: View {
    let nodePath: String
    let name: String
    let depth: Int
    let currentPath: String
    let treeChildren: [String: [RemoteFile]]
    @Binding var expandedPaths: Set<String>
    let onSelect: (String) -> Void
    let onToggle: (String) -> Void

    var body: some View {
        let isExpanded = expandedPaths.contains(nodePath)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                onSelect(nodePath)
            } label: {
                HStack(spacing: 4) {
                    Button {
                        onToggle(nodePath)
                    } label: {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                            .frame(width: 16, height: 16)
                    }
                    .buttonStyle(.plain)

                    Image(systemName: depth == 0 ? "internaldrive" : (isExpanded ? "folder.fill" : "folder"))
                        .foregroundStyle(depth == 0 ? .secondary : Palette.warn)
                    Text(name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .font(.subheadline)
                .foregroundStyle(.primary)
                .padding(.leading, CGFloat(depth * 14 + 6))
                .padding(.trailing, 8)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(currentPath == nodePath ? Palette.accent.opacity(0.18) : Color.clear)
                )
                .padding(.horizontal, 6)
            }
            .buttonStyle(.plain)

            if isExpanded {
                ForEach(treeChildren[nodePath] ?? []) { child in
                    FileTreeNode(
                        nodePath: child.path,
                        name: child.name,
                        depth: depth + 1,
                        currentPath: currentPath,
                        treeChildren: treeChildren,
                        expandedPaths: $expandedPaths,
                        onSelect: onSelect,
                        onToggle: onToggle
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct EditingFile: Identifiable {
    let id = UUID()
    let entry: RemoteFile
    var content: String
}

/// One appended line in the file manager's status log.
private struct LogEntry: Identifiable {
    let id = UUID()
    let time = Date()
    let text: String
    let isError: Bool
}
