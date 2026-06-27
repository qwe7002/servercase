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

    var body: some View {
        Form {
            Section {
                Toggle("Store credentials in Bitwarden", isOn: $draft.bitwarden.enabled)
            } footer: {
                Text("When off, secrets stay on-device and are never written to the sync file.")
            }

            if draft.bitwarden.enabled {
                Section("Account") {
                    TextField("Server URL (blank = bitwarden.com)", text: $draft.bitwarden.serverUrl)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Account email", text: $draft.bitwarden.email)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                    TextField("Item name prefix", text: $draft.bitwarden.itemPrefix)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }

                Section {
                    TextField("API key client_id", text: $draft.bitwarden.clientId)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("API key client_secret", text: $draft.bitwarden.clientSecret)
                } header: {
                    Text("API Key")
                } footer: {
                    Text("Use a personal API key from the web vault. The master password unlocks locally and is never stored.")
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
        .task { await model.refreshBitwardenStatus() }
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
        if let status = model.bitwardenStatus, status.available {
            switch status.state {
            case .unauthenticated:
                Text("Enter your account email and personal API key.")
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
    }

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
                        Toggle("Auto-push on changes", isOn: $draft.cloud.autoPush)
                        Button("Sign out", role: .destructive) { model.cloudSignOut() }
                        if let session = model.cloudSession, let at = session.syncedAt {
                            Text("Last synced \(at.formatted()) · revision \(session.syncVersion ?? 0)")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Section("Sign in") {
                        TextField("Email", text: $email)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .keyboardType(.emailAddress)
                        SecureField("Password", text: $password)
                        Button("Sign in") { authenticate(register: false) }
                            .disabled(busy || draft.cloud.url.isEmpty || email.isEmpty || password.isEmpty)
                        Button("Create account") { authenticate(register: true) }
                            .disabled(busy || draft.cloud.url.isEmpty || email.isEmpty || password.count < 8)
                    } footer: {
                        Text("New accounts need a password of at least 8 characters.")
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
                message = register ? "Account created." : "Signed in."
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

