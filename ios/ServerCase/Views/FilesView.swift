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
    /// Directory the new folder will be created in; nil means the current path.
    @State private var newFolderParent: String?
    @State private var showImporter = false
    @State private var sort = FileSort(column: .name, ascending: true)
    @State private var tableColumnWidths = FileTableColumnWidths()
    @State private var resizeDragStart: FileTableColumnWidths?
    @State private var resizingColumn: FileSortColumn?
    @State private var resizeDragDelta: CGFloat = 0
    @State private var pathDraft = "."
    @FocusState private var pathFieldFocused: Bool

    private static let maxEditBytes: Int64 = 512 * 1024

    private var files: RemoteFiles? {
        model.service(server.id).map { RemoteFiles(service: $0) }
    }

    private var sortedEntries: [RemoteFile] {
        sorted(listing?.entries ?? [])
    }

    private var activeTableColumnWidths: FileTableColumnWidths {
        guard let resizeDragStart, let resizingColumn else { return tableColumnWidths }
        return resizeDragStart.resized(resizingColumn, by: resizeDragDelta)
    }

    private var pathCompletions: [String] {
        let query = pathDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return ["/", "~", "."] }
        var candidates = Set(["/", "~", "."])
        let current = listing?.path ?? path
        for entry in listing?.entries ?? [] where entry.isDirectory {
            candidates.insert(files?.join(current, entry.name) ?? entry.path)
        }
        for (parent, children) in treeChildren {
            candidates.insert(parent)
            for child in children {
                candidates.insert(child.path)
            }
        }
        let matches = Array(candidates)
            .filter { candidate in candidate != query && candidate.localizedCaseInsensitiveContains(query) }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        return Array(matches.prefix(8))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if horizontalSizeClass == .regular {
                adaptiveRegularBrowser
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
                Button { newFolderParent = nil; showNewFolder = true } label: { Image(systemName: "folder.badge.plus") }
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

    private var adaptiveRegularBrowser: some View {
        GeometryReader { proxy in
            if proxy.size.width >= 820 {
                regularBrowser
            } else {
                compactBrowser
            }
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
                ForEach(sortedEntries) { entry in
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
                            file: nil,
                            depth: 0,
                            currentPath: listing?.path ?? path,
                            treeChildren: treeChildren,
                            expandedPaths: $expandedPaths,
                            onSelect: { target in Task { await load(target) } },
                            onToggle: toggleTree,
                            onRename: beginRename,
                            onDelete: removeNode,
                            onNewFolder: beginNewFolder
                        )
                    }
                    .padding(.vertical, 6)
                }
                .frame(width: 260)
                .background(Palette.surface.opacity(0.35))

                Divider()

                GeometryReader { tableProxy in
                    let layout = FileTableLayout(width: tableProxy.size.width, columnWidths: activeTableColumnWidths)
                    ScrollView(.horizontal) {
                        VStack(spacing: 0) {
                            fileTableHeader(layout)
                            Divider()
                            ZStack(alignment: .top) {
                                ScrollView {
                                    LazyVStack(spacing: 0) {
                                        if loading && listing == nil {
                                            ForEach(0..<12, id: \.self) { _ in
                                                skeletonTableRow(layout)
                                            }
                                        } else if (listing?.entries.isEmpty ?? false) {
                                            Text("Empty directory.")
                                                .foregroundStyle(.secondary)
                                                .frame(maxWidth: .infinity)
                                                .padding(.vertical, 36)
                                        } else {
                                            ForEach(sortedEntries) { entry in
                                                tableRow(entry, layout: layout)
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
                        .frame(width: layout.totalWidth)
                    }
                    .scrollDisabled(resizeDragStart != nil)
                    .transaction { transaction in
                        transaction.animation = nil
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

    private func fileTableHeader(_ layout: FileTableLayout) -> some View {
        HStack(spacing: layout.spacing) {
            headerCell("Name", column: .name, width: layout.nameWidth, alignment: .leading)
                .overlay(resizeHandle(for: .name), alignment: .trailing)
            headerCell("Size", column: .size, width: layout.sizeWidth, alignment: .leading)
                .overlay(resizeHandle(for: .size), alignment: .trailing)
            headerCell("Type", column: .type, width: layout.typeWidth, alignment: .leading)
                .overlay(resizeHandle(for: .type), alignment: .trailing)
            headerCell("Last modified", column: .modified, width: layout.modifiedWidth, alignment: .leading)
                .overlay(resizeHandle(for: .modified), alignment: .trailing)
            headerCell("Permissions", column: .permissions, width: layout.permissionsWidth, alignment: .leading)
                .overlay(resizeHandle(for: .permissions), alignment: .trailing)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, layout.horizontalPadding)
        .padding(.vertical, 8)
    }

    private func headerCell(_ title: String, column: FileSortColumn, width: CGFloat, alignment: Alignment) -> some View {
        Button {
            updateSort(column)
        } label: {
            HStack(spacing: 4) {
                Text(title).lineLimit(1)
                if sort.column == column {
                    Image(systemName: sort.ascending ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.semibold))
                }
            }
            .padding(.trailing, FileTableLayout.resizeHandleWidth)
            .frame(width: width, alignment: alignment)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func resizeHandle(for column: FileSortColumn) -> some View {
        ZStack {
            Rectangle()
                .fill(.secondary.opacity(resizingColumn == column ? 0.28 : 0.12))
                .frame(width: 2)
                .frame(maxHeight: .infinity)
        }
        .frame(width: FileTableLayout.resizeHandleWidth, height: 28)
        .contentShape(Rectangle())
        .highPriorityGesture(
            DragGesture(minimumDistance: 1)
                .onChanged { value in
                    if resizeDragStart == nil {
                        resizeDragStart = tableColumnWidths
                        resizingColumn = column
                    }
                    resizeDragDelta = value.translation.width
                }
                .onEnded { value in
                    if let resizeDragStart, let resizingColumn {
                        tableColumnWidths = resizeDragStart.resized(resizingColumn, by: value.translation.width)
                    }
                    resizeDragStart = nil
                    resizingColumn = nil
                    resizeDragDelta = 0
                }
        )
    }

    private func skeletonTableRow(_ layout: FileTableLayout) -> some View {
        HStack(spacing: layout.spacing) {
            Image(systemName: "doc.text")
                .foregroundStyle(.secondary)
                .frame(width: 18)
            RoundedRectangle(cornerRadius: 4)
                .fill(.secondary.opacity(0.18))
                .frame(width: max(40, layout.nameWidth - 26), height: 12)
            RoundedRectangle(cornerRadius: 4)
                .fill(.secondary.opacity(0.18))
                .frame(width: 70, height: 12)
        }
        .padding(.horizontal, layout.horizontalPadding)
        .padding(.vertical, 8)
        .redacted(reason: .placeholder)
    }

    private func tableRow(_ entry: RemoteFile, layout: FileTableLayout) -> some View {
        Button {
            selectedPath = entry.path
            open(entry)
        } label: {
            HStack(spacing: layout.spacing) {
                HStack(spacing: 8) {
                    Image(systemName: icon(entry))
                        .foregroundStyle(entry.isDirectory ? Palette.warn : .secondary)
                        .frame(width: 18)
                    Text(entry.name)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .frame(width: layout.nameWidth, alignment: .leading)

                Text(entry.isDirectory ? "" : Format.bytes(Double(entry.sizeBytes)))
                    .frame(width: layout.sizeWidth, alignment: .leading)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Text(typeLabel(entry))
                    .lineLimit(1)
                    .frame(width: layout.typeWidth, alignment: .leading)
                    .foregroundStyle(.secondary)
                Text(entry.modifiedAt.formatted(date: .numeric, time: .shortened))
                    .lineLimit(1)
                    .frame(width: layout.modifiedWidth, alignment: .leading)
                    .foregroundStyle(.secondary)
                Text(entry.mode)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .frame(width: layout.permissionsWidth, alignment: .leading)
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, layout.horizontalPadding)
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
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                Button { Task { await goUp() } } label: { Image(systemName: "arrow.up") }
                TextField("Remote path", text: $pathDraft)
                    .font(.system(.footnote, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($pathFieldFocused)
                    .onSubmit { submitPathDraft() }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(Palette.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                Button { submitPathDraft() } label: { Image(systemName: "arrow.right.circle") }
                    .disabled(pathDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if pathFieldFocused && !pathCompletions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(pathCompletions, id: \.self) { suggestion in
                            Button {
                                applyPathCompletion(suggestion)
                            } label: {
                                Text(suggestion)
                                    .font(.system(.caption, design: .monospaced))
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                    .padding(.horizontal, 9)
                                    .padding(.vertical, 5)
                                    .background(Palette.surface.opacity(0.8))
                                    .clipShape(RoundedRectangle(cornerRadius: 7))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 1)
                }
            }
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

    private func submitPathDraft() {
        let target = pathDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return }
        pathFieldFocused = false
        Task { await load(target) }
    }

    private func applyPathCompletion(_ suggestion: String) {
        pathDraft = suggestion
        pathFieldFocused = false
        Task { await load(suggestion) }
    }

    private func load(_ target: String) async {
        guard let files else { return }
        loading = true
        defer { loading = false }
        do {
            let result = try await files.list(target)
            listing = result
            path = result.path
            pathDraft = result.path
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

    /// Opens the rename alert for any entry (table row or directory-tree node).
    private func beginRename(_ entry: RemoteFile) {
        renaming = entry
        renameText = entry.name
    }

    private func confirmRename() {
        guard let entry = renaming, let files else { return }
        let name = renameText.trimmingCharacters(in: .whitespaces)
        renaming = nil
        guard !name.isEmpty, name != entry.name else { return }
        Task {
            do {
                let parent = parentDirectory(entry.path)
                let dest = files.join(parent, name)
                try await files.rename(entry.path, to: dest)
                appendLog("Renamed \(entry.name) → \(name)")
                await cacheTreeChildren(parent)
                await reloadCurrentOrNavigate(old: entry.path, newPath: dest)
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    /// Tree-aware delete: refreshes the parent's children and navigates out of
    /// the current directory if it lived inside the removed one.
    private func removeNode(_ entry: RemoteFile) {
        Task {
            guard let files else { return }
            do {
                try await files.remove(entry.path, isDirectory: entry.isDirectory)
                appendLog("Deleted \(entry.name)")
                let parent = parentDirectory(entry.path)
                await cacheTreeChildren(parent)
                await reloadCurrentOrNavigate(old: entry.path, newPath: nil)
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    private func beginNewFolder(_ parent: String) {
        newFolderParent = parent
        showNewFolder = true
    }

    private func createFolder() {
        guard let files else { return }
        let name = newFolderName.trimmingCharacters(in: .whitespaces)
        newFolderName = ""
        let parent = newFolderParent ?? path
        newFolderParent = nil
        guard !name.isEmpty else { return }
        Task {
            do {
                try await files.makeDirectory(files.join(parent, name))
                appendLog("Created \(files.join(parent, name))")
                expandedPaths.insert(parent)
                await cacheTreeChildren(parent)
                await load(listing?.path ?? path)
            } catch {
                appendLog(error.localizedDescription, isError: true)
            }
        }
    }

    /// Drops the last component of an absolute path, returning "/" at the root.
    private func parentDirectory(_ p: String) -> String {
        let trimmed = (p.hasSuffix("/") && p != "/") ? String(p.dropLast()) : p
        guard trimmed != "/" else { return "/" }
        let parent = trimmed.split(separator: "/").dropLast().joined(separator: "/")
        return parent.isEmpty ? "/" : "/" + parent
    }

    /// Reloads the current listing, or, when the affected path is the current
    /// directory or one of its ancestors, follows it to `newPath` (rename) or
    /// up to its parent (delete).
    private func reloadCurrentOrNavigate(old: String, newPath: String?) async {
        let current = listing?.path ?? path
        if current == old || current.hasPrefix(old + "/") {
            if let newPath {
                await load(newPath + String(current.dropFirst(old.count)))
            } else {
                await load(parentDirectory(old))
            }
        } else {
            await load(current)
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

    private func updateSort(_ column: FileSortColumn) {
        if sort.column == column {
            sort.ascending.toggle()
        } else {
            sort = FileSort(column: column, ascending: true)
        }
    }

    private func sorted(_ entries: [RemoteFile]) -> [RemoteFile] {
        entries.sorted { lhs, rhs in
            if lhs.isDirectory != rhs.isDirectory {
                return lhs.isDirectory
            }

            let orderedAscending: Bool
            switch sort.column {
            case .name:
                orderedAscending = lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            case .size:
                orderedAscending = lhs.sizeBytes == rhs.sizeBytes
                    ? lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                    : lhs.sizeBytes < rhs.sizeBytes
            case .type:
                let leftType = typeLabel(lhs)
                let rightType = typeLabel(rhs)
                orderedAscending = leftType == rightType
                    ? lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                    : leftType.localizedCaseInsensitiveCompare(rightType) == .orderedAscending
            case .modified:
                orderedAscending = lhs.modifiedAt == rhs.modifiedAt
                    ? lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                    : lhs.modifiedAt < rhs.modifiedAt
            case .permissions:
                orderedAscending = lhs.mode == rhs.mode
                    ? lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                    : lhs.mode < rhs.mode
            }
            return sort.ascending ? orderedAscending : !orderedAscending
        }
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

private enum FileSortColumn: Equatable {
    case name
    case size
    case type
    case modified
    case permissions
}

private struct FileSort: Equatable {
    var column: FileSortColumn
    var ascending: Bool
}

private struct FileTableColumnWidths: Equatable {
    var name: CGFloat = 260
    var size: CGFloat = 104
    var type: CGFloat = 112
    var modified: CGFloat = 152
    var permissions: CGFloat = 96

    func resized(_ column: FileSortColumn, by delta: CGFloat) -> Self {
        var copy = self
        switch column {
        case .name:
            copy.name = clamp(name + delta, min: 140, max: 520)
        case .size:
            copy.size = clamp(size + delta, min: 86, max: 170)
        case .type:
            copy.type = clamp(type + delta, min: 82, max: 220)
        case .modified:
            copy.modified = clamp(modified + delta, min: 118, max: 240)
        case .permissions:
            copy.permissions = clamp(permissions + delta, min: 74, max: 160)
        }
        return copy
    }

    private func clamp(_ value: CGFloat, min: CGFloat, max: CGFloat) -> CGFloat {
        Swift.min(Swift.max(value, min), max)
    }
}

private struct FileTableLayout {
    static let resizeHandleWidth: CGFloat = 24

    let width: CGFloat
    let columnWidths: FileTableColumnWidths

    var spacing: CGFloat { width >= 640 ? 12 : 8 }
    var horizontalPadding: CGFloat { width >= 640 ? 12 : 10 }
    var nameWidth: CGFloat { columnWidths.name }
    var sizeWidth: CGFloat { columnWidths.size }
    var typeWidth: CGFloat { columnWidths.type }
    var modifiedWidth: CGFloat { columnWidths.modified }
    var permissionsWidth: CGFloat { columnWidths.permissions }
    var totalWidth: CGFloat {
        max(
            width,
            nameWidth + sizeWidth + typeWidth + modifiedWidth + permissionsWidth + spacing * 4 + horizontalPadding * 2
        )
    }
}

private struct FileTreeNode: View {
    let nodePath: String
    let name: String
    /// The directory entry this node represents, or nil for the synthetic root.
    let file: RemoteFile?
    let depth: Int
    let currentPath: String
    let treeChildren: [String: [RemoteFile]]
    @Binding var expandedPaths: Set<String>
    let onSelect: (String) -> Void
    let onToggle: (String) -> Void
    let onRename: (RemoteFile) -> Void
    let onDelete: (RemoteFile) -> Void
    let onNewFolder: (String) -> Void

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
            .contextMenu {
                Button { onNewFolder(nodePath) } label: {
                    Label("New Folder", systemImage: "folder.badge.plus")
                }
                if let file {
                    Button { onRename(file) } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                    Button(role: .destructive) { onDelete(file) } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }

            if isExpanded {
                ForEach(treeChildren[nodePath] ?? []) { child in
                    FileTreeNode(
                        nodePath: child.path,
                        name: child.name,
                        file: child,
                        depth: depth + 1,
                        currentPath: currentPath,
                        treeChildren: treeChildren,
                        expandedPaths: $expandedPaths,
                        onSelect: onSelect,
                        onToggle: onToggle,
                        onRename: onRename,
                        onDelete: onDelete,
                        onNewFolder: onNewFolder
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
