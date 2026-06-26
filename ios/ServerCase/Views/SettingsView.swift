import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var draft = GlobalSettings()
    @State private var master = ""
    @State private var busy = false
    @State private var message: String?

    @State private var editingSnippet: Snippet?
    @State private var addingSnippet = false

    @State private var showExporter = false
    @State private var showImporter = false
    @State private var exportDoc: SyncDocument?

    var body: some View {
        NavigationStack {
            Form {
                bitwardenSection
                groupsSection
                snippetsSection
                autoSyncSection
                if let message {
                    Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear { draft = model.settings }
            .onChange(of: draft) { _, new in model.updateSettings(new) }
            .task { await model.refreshBitwardenStatus() }
            .sheet(isPresented: $addingSnippet) {
                SnippetEditorView(snippet: nil) { draft.snippets.append($0) }
            }
            .sheet(item: $editingSnippet) { snippet in
                SnippetEditorView(snippet: snippet) { updated in
                    if let i = draft.snippets.firstIndex(where: { $0.id == updated.id }) {
                        draft.snippets[i] = updated
                    }
                }
            }
            .fileExporter(isPresented: $showExporter, document: exportDoc,
                          contentType: .json, defaultFilename: "servercase-sync") { _ in }
            .fileImporter(isPresented: $showImporter, allowedContentTypes: [.json]) { result in
                importConfig(result)
            }
        }
    }

    // MARK: Keychain (Bitwarden)

    @ViewBuilder private var bitwardenSection: some View {
        Section {
            Toggle("Store credentials in Bitwarden", isOn: $draft.bitwarden.enabled)
            if draft.bitwarden.enabled {
                TextField("Server URL (blank = bitwarden.com)", text: $draft.bitwarden.serverUrl)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.URL)
                TextField("Account email", text: $draft.bitwarden.email)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                TextField("API key client_id", text: $draft.bitwarden.clientId)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("API key client_secret", text: $draft.bitwarden.clientSecret)
                TextField("Item name prefix", text: $draft.bitwarden.itemPrefix)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                statusRow
                if let status = model.bitwardenStatus, status.available {
                    switch status.state {
                    case .unauthenticated:
                        Text("Enter your account email and a personal API key (web vault → Security → Keys → API Key).")
                            .font(.footnote).foregroundStyle(.secondary)
                    case .locked:
                        SecureField("Master password", text: $master)
                        Button("Unlock") { unlock() }.disabled(busy || master.isEmpty)
                    case .unlocked:
                        Button("Test vault") { runTest() }.disabled(busy)
                        Button("Push all secrets to vault") { pushAll() }.disabled(busy)
                        Button("Lock vault") { lock() }
                    }
                }
                Button("Refresh status") { Task { await model.refreshBitwardenStatus() } }
            }
        } header: {
            Text("Keychain")
        } footer: {
            Text("Usernames, passwords and SSH keys are kept in your Bitwarden vault, reached directly over the Bitwarden API (no `bw` CLI). The master password unlocks the vault locally and is never stored. When off, secrets stay on-device and are never written to the sync file.")
        }
    }

    private var statusRow: some View {
        HStack {
            Text("Vault")
            Spacer()
            if let status = model.bitwardenStatus {
                if !status.available {
                    Text("not configured").foregroundStyle(.secondary)
                } else {
                    Text(status.userEmail.map { "\(status.state.rawValue) · \($0)" } ?? status.state.rawValue)
                        .foregroundStyle(status.state == .unlocked ? Palette.good : .secondary)
                }
            } else {
                Text("checking…").foregroundStyle(.secondary)
            }
        }
        .font(.footnote)
    }

    // MARK: Groups

    @ViewBuilder private var groupsSection: some View {
        Section {
            ForEach($draft.groups) { $group in
                TextField("Name", text: $group.name)
                    .autocorrectionDisabled()
            }
            .onDelete { draft.groups.remove(atOffsets: $0) }
            Button { draft.groups.append(ServerGroup(name: "New group")) } label: {
                Label("Add group", systemImage: "plus")
            }
        } header: {
            Text("Groups")
        } footer: {
            Text("Assign servers to a group from the server form. Deleting a group leaves its servers ungrouped.")
        }
    }

    // MARK: Snippets

    @ViewBuilder private var snippetsSection: some View {
        Section {
            ForEach(draft.snippets) { snippet in
                Button { editingSnippet = snippet } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(snippet.name).foregroundStyle(.primary)
                        Text(snippet.command).font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            .onDelete { draft.snippets.remove(atOffsets: $0) }
            Button { addingSnippet = true } label: { Label("Add snippet", systemImage: "plus") }
        } header: {
            Text("Snippets")
        } footer: {
            Text("Reusable commands you can run in any server's terminal.")
        }
    }

    // MARK: Auto-sync

    @ViewBuilder private var autoSyncSection: some View {
        Section {
            Toggle("Automatic config sync", isOn: $draft.autoSync.enabled)
            Stepper("Every \(draft.autoSync.intervalMinutes) min",
                    value: $draft.autoSync.intervalMinutes, in: 1...720)
            Button("Sync now") {
                message = model.syncToAutoFile() ? "Synced to app storage." : "Sync failed."
            }
            Button("Export…") {
                exportDoc = (try? model.exportData()).map { SyncDocument(data: $0) }
                if exportDoc != nil { showExporter = true }
            }
            Button("Import…") { showImporter = true }
            if let date = draft.autoSync.lastSyncedAt {
                Text("Last synced \(date.formatted())").font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text("Auto-sync")
        } footer: {
            Text("Writes the server list and settings to a JSON file. Secrets are excluded — they sync through Bitwarden.")
        }
    }

    // MARK: Actions

    private func unlock() {
        busy = true; message = nil
        Task {
            do {
                try await model.unlockVault(master)
                master = ""
                message = "Vault unlocked."
            } catch {
                message = error.localizedDescription
            }
            busy = false
        }
    }

    private func lock() {
        Task { await model.lockVault() }
    }

    private func pushAll() {
        busy = true; message = nil
        Task {
            do {
                try await model.pushAllSecretsToVault()
                message = "All secrets pushed to the vault."
            } catch {
                message = error.localizedDescription
            }
            busy = false
        }
    }

    private func runTest() {
        busy = true; message = "Testing vault…"
        Task {
            do {
                message = try await model.testVault()
            } catch {
                message = "Vault test failed: \(error.localizedDescription)"
            }
            busy = false
        }
    }

    private func importConfig(_ result: Result<URL, Error>) {
        switch result {
        case .success(let url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                try model.importData(data)
                draft = model.settings
                message = "Configuration imported."
            } catch {
                message = error.localizedDescription
            }
        case .failure(let error):
            message = error.localizedDescription
        }
    }
}

/// Add/edit sheet for a single snippet.
struct SnippetEditorView: View {
    @Environment(\.dismiss) private var dismiss
    let snippet: Snippet?
    let onSave: (Snippet) -> Void

    @State private var name = ""
    @State private var command = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                TextField("Command", text: $command, axis: .vertical)
                    .lineLimit(2...6)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            .navigationTitle(snippet == nil ? "Add snippet" : "Edit snippet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(Snippet(id: snippet?.id ?? UUID(),
                                       name: name.trimmingCharacters(in: .whitespaces),
                                       command: command.trimmingCharacters(in: .whitespaces)))
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty ||
                              command.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                name = snippet?.name ?? ""
                command = snippet?.command ?? ""
            }
        }
    }
}

/// Wraps the secret-free config JSON for `.fileExporter`.
struct SyncDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data

    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
