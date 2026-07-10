import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var draft = GlobalSettings()
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NavigationLink {
                        BitwardenSettingsPage(draft: $draft, message: $message)
                    } label: {
                        settingsRow("Keychain", systemImage: "key.fill", detail: keychainDetail)
                    }

                    NavigationLink {
                        GroupsSettingsPage(draft: $draft)
                    } label: {
                        settingsRow("Groups", systemImage: "folder.fill", detail: "\(draft.groups.count)")
                    }

                    NavigationLink {
                        SnippetsSettingsPage(draft: $draft)
                    } label: {
                        settingsRow("Snippets", systemImage: "chevron.left.forwardslash.chevron.right", detail: "\(draft.snippets.count)")
                    }

                    NavigationLink {
                        CloudSettingsPage(draft: $draft, message: $message)
                    } label: {
                        settingsRow("Cloud", systemImage: "icloud", detail: cloudDetail)
                    }

                    NavigationLink {
                        TerminalSettingsPage(draft: $draft)
                    } label: {
                        settingsRow("Terminal", systemImage: "terminal", detail: "\(draft.terminal.fontSize)pt")
                    }
                }

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
        }
    }

    private var keychainDetail: String {
        guard draft.bitwarden.enabled else { return "Off" }
        guard let status = model.bitwardenStatus else { return "Checking" }
        if !status.available { return "Not configured" }
        return status.state.rawValue.capitalized
    }

    private var cloudDetail: String {
        guard draft.cloud.enabled else { return "Off" }
        return model.cloudSignedIn ? "Signed in" : "Signed out"
    }

    private func settingsRow(_ title: String, systemImage: String, detail: String) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer(minLength: 12)
            Text(detail).foregroundStyle(.secondary)
        }
    }
}

private struct BitwardenSettingsPage: View {
    @EnvironmentObject private var model: AppModel
    @Binding var draft: GlobalSettings
    @Binding var message: String?

    @State private var master = ""
    @State private var busy = false
    @State private var folders: [BitwardenFolderOption] = []
    @State private var newFolderName = ""

    var body: some View {
        Form {
            Section {
                Toggle("Store credentials in Bitwarden", isOn: $draft.bitwarden.enabled)
            } footer: {
                Text("When off, secrets stay on-device and are never written to the sync file.")
            }

            if draft.bitwarden.enabled {
                Section("Account") {
                    Picker("Sign in mode", selection: $draft.bitwarden.authMode) {
                        ForEach(BitwardenAuthMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    TextField("Server URL or domain (blank = bitwarden.com)", text: $draft.bitwarden.serverUrl)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Account email", text: $draft.bitwarden.email)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                }

                if draft.bitwarden.authMode == .apiKey {
                    Section {
                        TextField("API key client_id", text: $draft.bitwarden.clientId)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("API key client_secret", text: $draft.bitwarden.clientSecret)
                    } header: {
                        Text("API Key")
                    } footer: {
                        Text("Use a personal API key from the web vault. The master password unlocks locally and is never stored.")
                    }
                }

                Section("Vault") {
                    statusRow
                    vaultActions
                    Button("Refresh status") { Task { await model.refreshBitwardenStatus() } }
                }
            }

            if let message {
                Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Keychain")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            loadStoredMasterPassword()
            await model.unlockVaultWithStoredPasswordIfAvailable()
            if model.bitwardenStatus?.state == .unlocked { await loadFolders() }
        }
        .onChange(of: draft.bitwarden) { _, _ in
            loadStoredMasterPassword()
            Task { await model.refreshBitwardenStatus() }
        }
    }

    private var statusRow: some View {
        HStack {
            Text("Status")
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

    @ViewBuilder private var vaultActions: some View {
        let configured = bitwardenDraftConfigured
        if let status = model.bitwardenStatus, status.state == .unlocked {
            folderControls
            Button("Test vault") { runTest() }.disabled(busy)
            Button("Lock vault") { lock() }
        } else if configured {
            SecureField("Master password", text: $master)
            Button("Unlock") { unlock() }.disabled(busy || master.isEmpty)
        } else {
            Text(draft.bitwarden.authMode == .password
                 ? "Enter your server URL and account email."
                 : "Enter your account email and personal API key.")
            .font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var folderControls: some View {
        Picker("Folder", selection: $draft.bitwarden.itemPrefix) {
            if folders.isEmpty {
                Text(draft.bitwarden.itemPrefix.isEmpty ? "ServerCase" : draft.bitwarden.itemPrefix)
                    .tag(draft.bitwarden.itemPrefix)
            }
            ForEach(folders) { folder in
                Text(folder.name).tag(folder.name)
            }
        }

        HStack {
            TextField("New folder", text: $newFolderName)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Add") { addFolder() }
                .disabled(busy || newFolderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        Button("Delete current folder", role: .destructive) { deleteCurrentFolder() }
            .disabled(busy || currentFolderId == nil)

        Button("Refresh folders") { Task { await loadFolders() } }
            .disabled(busy)
    }

    private var currentFolderId: String? {
        let selected = draft.bitwarden.itemPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
        return folders.first { $0.name == selected }?.id
    }

    private var bitwardenDraftConfigured: Bool {
        switch draft.bitwarden.authMode {
        case .password:
            return !draft.bitwarden.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .apiKey:
            return !draft.bitwarden.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !draft.bitwarden.clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !draft.bitwarden.clientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func loadFolders() async {
        do {
            let loaded = try await model.bitwardenFolders()
            folders = loaded
            if draft.bitwarden.itemPrefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let first = loaded.first {
                draft.bitwarden.itemPrefix = first.name
            }
        } catch {
            message = "Folder refresh failed: \(error.localizedDescription)"
        }
    }

    private func addFolder() {
        let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        busy = true; message = nil
        Task {
            do {
                let folder = try await model.createBitwardenFolder(named: name)
                newFolderName = ""
                draft.bitwarden.itemPrefix = folder.name
                await loadFolders()
                message = "Folder added."
            } catch {
                message = "Folder add failed: \(error.localizedDescription)"
            }
            busy = false
        }
    }

    private func deleteCurrentFolder() {
        guard let id = currentFolderId else { return }
        busy = true; message = nil
        Task {
            do {
                try await model.deleteBitwardenFolder(id: id)
                await loadFolders()
                draft.bitwarden.itemPrefix = folders.first?.name ?? "ServerCase"
                message = "Folder deleted."
            } catch {
                message = "Folder delete failed: \(error.localizedDescription)"
            }
            busy = false
        }
    }

    private func loadStoredMasterPassword() {
        guard draft.bitwarden.authMode == .password,
              master.isEmpty,
              let stored = BitwardenPasswordStore.load(for: draft.bitwarden) else { return }
        master = stored
    }

    private func unlock() {
        model.updateSettings(draft)
        busy = true; message = "Unlocking vault…"
        Task {
            do {
                try await model.unlockVault(master)
                master = ""
                message = "Vault unlocked."
                await loadFolders()
            } catch {
                message = error.localizedDescription
            }
            busy = false
        }
    }

    private func lock() {
        Task { await model.lockVault() }
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
}

private struct GroupsSettingsPage: View {
    @Binding var draft: GlobalSettings

    var body: some View {
        Form {
            Section {
                ForEach($draft.groups) { $group in
                    TextField("Name", text: $group.name)
                        .autocorrectionDisabled()
                }
                .onDelete { draft.groups.remove(atOffsets: $0) }
                Button { draft.groups.append(ServerGroup(name: "New group")) } label: {
                    Label("Add group", systemImage: "plus")
                }
            } footer: {
                Text("Assign servers to a group from the server form. Deleting a group leaves its servers ungrouped.")
            }
        }
        .navigationTitle("Groups")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SnippetsSettingsPage: View {
    @Binding var draft: GlobalSettings

    @State private var editingSnippet: Snippet?
    @State private var addingSnippet = false

    var body: some View {
        Form {
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
            } footer: {
                Text("Reusable commands you can run in any server's terminal.")
            }
        }
        .navigationTitle("Snippets")
        .navigationBarTitleDisplayMode(.inline)
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
    }
}

private struct CloudSettingsPage: View {
    @EnvironmentObject private var model: AppModel
    @Binding var draft: GlobalSettings
    @Binding var message: String?

    @State private var email = ""
    @State private var password = ""
    @State private var busy = false

    var body: some View {
        Form {
            Section {
                Toggle("ServerCase Cloud", isOn: $draft.cloud.enabled)
            } footer: {
                Text("Sync your server list and settings to a ServerCase Worker. Secrets are never uploaded — they sync through Bitwarden — and your session token stays on this device.")
            }

            if draft.cloud.enabled {
                Section("Worker") {
                    TextField("https://worker.example.com", text: $draft.cloud.url)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                if model.cloudSignedIn {
                    Section("Account") {
                        HStack {
                            Text("Signed in")
                            Spacer()
                            Text(model.cloudSession?.user.email ?? "").foregroundStyle(.secondary)
                        }
                        Button("Push to cloud") { push() }.disabled(busy)
                        Button("Pull from cloud") { pull() }.disabled(busy)
                        NavigationLink {
                            ProbeHostsPage(message: $message)
                        } label: {
                            Label("Probe hosts", systemImage: "dot.radiowaves.left.and.right")
                        }
                        Toggle("Auto-push on changes", isOn: $draft.cloud.autoPush)
                        Button("Sign out", role: .destructive) { model.cloudSignOut() }
                        if let session = model.cloudSession, let at = session.syncedAt {
                            Text("Last synced \(at.formatted()) · revision \(session.syncVersion ?? 0)")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Section {
                        TextField("Email", text: $email)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .keyboardType(.emailAddress)
                        SecureField("Password", text: $password)
                        Button("Sign in") { authenticate(register: false) }
                            .disabled(busy || draft.cloud.url.isEmpty || email.isEmpty || password.isEmpty)
                    } header: {
                        Text("Sign in")
                    } footer: {
                        Text("Use an existing ServerCase Cloud account.")
                    }
                }
            }

            if let message {
                Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Cloud")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func authenticate(register: Bool) {
        busy = true; message = nil
        Task {
            do {
                try await model.cloudAuthenticate(
                    register: register,
                    email: email.trimmingCharacters(in: .whitespaces),
                    password: password)
                password = ""
                message = "Signed in."
            } catch {
                message = errorText(error)
            }
            busy = false
        }
    }

    private func push() {
        busy = true; message = nil
        Task {
            do {
                let version = try await model.cloudPushNow()
                message = "Pushed to cloud (revision \(version))."
            } catch {
                message = errorText(error)
            }
            busy = false
        }
    }

    private func pull() {
        busy = true; message = nil
        Task {
            do {
                try await model.cloudPull()
                draft = model.settings
                message = "Pulled from cloud."
            } catch {
                message = errorText(error)
            }
            busy = false
        }
    }

    private func errorText(_ error: Error) -> String {
        if let ce = error as? CloudError, ce.status == 409 {
            return "The cloud copy changed since your last sync. Pull first, then push."
        }
        return error.localizedDescription
    }
}

private struct ProbeHostsPage: View {
    @EnvironmentObject private var model: AppModel
    @Binding var message: String?

    @State private var busy = false
    @State private var selectedServerId: String?
    @State private var installLog = ""

    var body: some View {
        Form {
            Section {
                Picker("Install on", selection: $selectedServerId) {
                    Text("Choose server").tag(Optional<String>.none)
                    ForEach(model.servers) { server in
                        Text(server.name).tag(Optional(server.id))
                    }
                }
                Button("Install probe over SSH") {
                    installSelected()
                }
                .disabled(busy || selectedServerId == nil)
            } header: {
                Text("Add host")
            } footer: {
                Text("Creates a probe for the selected server and installs a user-level service over that server's SSH connection. The probe then posts status to ServerCase Cloud over HTTPS. Every probe is configured automatically over SSH — there is no manual token registration.")
            }

            Section("Hosts") {
                if model.probeHosts.isEmpty {
                    Text("No probe hosts yet.").foregroundStyle(.secondary)
                }
                ForEach(model.probeHosts) { host in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(host.name)
                            Spacer()
                            Circle()
                                .fill(isOnline(host) ? Palette.good : Color.secondary.opacity(0.4))
                                .frame(width: 8, height: 8)
                        }
                        if let snapshot = host.latest {
                            Text("\(snapshot.hostname.isEmpty ? "–" : snapshot.hostname) · \(snapshot.kernel.isEmpty ? "–" : snapshot.kernel)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Text("Waiting for first snapshot…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete(perform: delete)

                Button("Refresh") {
                    Task { await model.refreshProbes() }
                }
            }

            if !installLog.isEmpty {
                Section("Install log") {
                    Text(installLog)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
        }
        .navigationTitle("Probe hosts")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.refreshProbes() }
    }

    private func installSelected() {
        guard let id = selectedServerId,
              let server = model.servers.first(where: { $0.id == id }) else { return }
        busy = true
        message = nil
        installLog = ""
        Task {
            do {
                installLog = try await model.installProbeAuto(on: server)
                message = "Probe installed on \(server.name)."
            } catch {
                message = error.localizedDescription
            }
            busy = false
        }
    }

    private func delete(_ offsets: IndexSet) {
        for index in offsets {
            let host = model.probeHosts[index]
            Task {
                do {
                    try await model.deleteProbe(host)
                } catch {
                    message = error.localizedDescription
                }
            }
        }
    }

    private func isOnline(_ host: ProbeHost) -> Bool {
        guard let lastSeenAt = host.lastSeenAt else { return false }
        return Date().timeIntervalSince(lastSeenAt) < 30
    }
}

private struct TerminalSettingsPage: View {
    @Binding var draft: GlobalSettings

    var body: some View {
        Form {
            Section("Text") {
                Stepper("Font size: \(draft.terminal.fontSize) pt",
                        value: $draft.terminal.fontSize, in: 8...32)
            }

            Section {
                Picker("Color scheme", selection: $draft.terminal.colorScheme) {
                    ForEach(TerminalColorScheme.allCases) { Text($0.label).tag($0) }
                }
            } footer: {
                Text("Applies to the SSH terminal on every server, and syncs across your devices through Cloud.")
            }
        }
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
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
                        onSave(Snippet(id: snippet?.id ?? UUID().uuidString,
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
