import SwiftUI
import UniformTypeIdentifiers

/// A FileZilla-style remote file manager, adapted to a single navigable pane
/// for phones: a path header, a file list, and per-row actions, backed by the
/// command-based `RemoteFiles` service.
struct FilesView: View {
    @EnvironmentObject private var model: AppModel
    let server: ServerConfig

    @State private var path = "."
    @State private var listing: RemoteListing?
    @State private var loading = false
    @State private var message: String?

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
            if loading && listing == nil {
                ProgressView().padding(40)
                Spacer()
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
            if let message {
                Text(message)
                    .font(.caption).foregroundStyle(.secondary)
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
        } catch {
            message = error.localizedDescription
        }
    }

    private func goUp() async {
        let current = listing?.path ?? path
        let parent = current.split(separator: "/").dropLast().joined(separator: "/")
        await load(parent.isEmpty ? "/" : "/" + parent)
    }

    private func open(_ entry: RemoteFile) {
        if entry.isDirectory {
            Task { await load(entry.path) }
            return
        }
        guard entry.sizeBytes <= Self.maxEditBytes else {
            message = "\(entry.name) is too large to edit — use Save to download it."
            return
        }
        Task {
            guard let files else { return }
            do {
                let content = try await files.readText(entry.path)
                editing = EditingFile(entry: entry, content: content)
            } catch {
                message = error.localizedDescription
            }
        }
    }

    private func save(_ file: EditingFile) {
        Task {
            guard let files, let content = editing?.content else { return }
            do {
                try await files.writeText(file.entry.path, content)
                message = "Saved \(file.entry.name)"
                editing = nil
            } catch {
                message = error.localizedDescription
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
                message = error.localizedDescription
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
                message = error.localizedDescription
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
                message = error.localizedDescription
            }
        }
    }

    private func download(_ entry: RemoteFile) {
        Task {
            guard let files else { return }
            do {
                let url = try await files.download(entry)
                message = "Saved to \(url.lastPathComponent) in Files"
            } catch {
                message = error.localizedDescription
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
                    message = "Uploaded \(url.lastPathComponent)"
                    await load(path)
                } catch {
                    message = error.localizedDescription
                }
            }
        case .failure(let error):
            message = error.localizedDescription
        }
    }

    private func icon(_ entry: RemoteFile) -> String {
        if entry.isDirectory { return "folder.fill" }
        if entry.isSymlink { return "link" }
        return "doc.text"
    }

    private func detail(_ entry: RemoteFile) -> String {
        let when = entry.modifiedAt.formatted(date: .abbreviated, time: .shortened)
        if entry.isDirectory { return "\(entry.mode) · \(when)" }
        return "\(Format.bytes(Double(entry.sizeBytes))) · \(entry.mode) · \(when)"
    }
}

private struct EditingFile: Identifiable {
    let id = UUID()
    let entry: RemoteFile
    var content: String
}
