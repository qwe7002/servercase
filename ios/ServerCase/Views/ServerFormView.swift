import SwiftUI

struct ServerFormView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let existing: ServerConfig?

    @State private var name = ""
    @State private var groupId = ""
    @State private var host = ""
    @State private var port = "22"
    @State private var username = "root"
    @State private var bitwardenItemName = ""
    @State private var probeHostId = ""
    @State private var authType: AuthType = .password
    @State private var password = ""
    @State private var privateKey = ""
    @State private var passphrase = ""
    @State private var sshKeyItemName = ""

    private var canSave: Bool {
        let hasServerBasics = !name.trimmingCharacters(in: .whitespaces).isEmpty &&
            !host.trimmingCharacters(in: .whitespaces).isEmpty
        if model.settings.bitwarden.enabled {
            return hasServerBasics && !bitwardenItemName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return hasServerBasics && !username.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Name", text: $name)
                    Picker("Group", selection: $groupId) {
                        Text("No group").tag("")
                        ForEach(model.settings.groups) { group in
                            Text(group.name).tag(group.id)
                        }
                    }
                    TextField("Host", text: $host)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Port", text: $port).keyboardType(.numberPad)
                    if !model.settings.bitwarden.enabled {
                        TextField("Username", text: $username)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }

                Section("Probe data") {
                    Picker("Overview source", selection: $probeHostId) {
                        Text("Use SSH polling").tag("")
                        ForEach(model.probeHosts) { host in
                            Text(host.name).tag(host.id)
                        }
                    }
                }

                if model.settings.bitwarden.enabled {
                    Section {
                        NavigationLink {
                            BitwardenItemPickerPage(
                                itemName: $bitwardenItemName,
                                username: $username,
                                authType: $authType,
                                password: $password,
                                privateKey: $privateKey,
                                passphrase: $passphrase
                            )
                        } label: {
                            HStack {
                                Text("Vault item")
                                Spacer()
                                Text(bitwardenItemName.isEmpty ? "Choose" : bitwardenItemName)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } header: {
                        Text("Bitwarden")
                    } footer: {
                        Text("Choose an item from the configured ServerCase folder, or enter a new item name on the next page.")
                    }
                }

                if !model.settings.bitwarden.enabled {
                    Section("Authentication") {
                        Picker("Method", selection: $authType) {
                            ForEach(AuthType.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.segmented)

                        if authType == .password {
                            SecureField("Password", text: $password)
                        } else {
                            TextField("Private key (PEM)", text: $privateKey, axis: .vertical)
                                .lineLimit(4...8)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                            SecureField("Passphrase (optional)", text: $passphrase)
                        }
                    }
                }
            }
            .navigationTitle(existing == nil ? "Add server" : "Edit server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(!canSave)
                }
            }
            .onAppear(perform: populate)
            .task { await model.refreshProbes() }
        }
    }

    private func populate() {
        guard let e = existing else { return }
        name = e.name; host = e.host; port = String(e.port); username = e.username
        bitwardenItemName = e.bitwardenItemName ?? e.name
        groupId = e.groupId ?? ""
        probeHostId = e.probeHostId ?? ""
        authType = e.authType
        password = e.password ?? ""
        privateKey = e.privateKey ?? ""
        passphrase = e.passphrase ?? ""
    }

    private func save() {
        var server = existing ?? ServerConfig(name: name, host: host)
        server.name = name.trimmingCharacters(in: .whitespaces)
        server.groupId = groupId.isEmpty ? nil : groupId
        server.probeHostId = probeHostId.isEmpty ? nil : probeHostId
        server.host = host.trimmingCharacters(in: .whitespaces)
        server.port = Int(port) ?? 22
        server.username = username.trimmingCharacters(in: .whitespaces)
        let vaultName = bitwardenItemName.trimmingCharacters(in: .whitespacesAndNewlines)
        server.bitwardenItemName = vaultName.isEmpty ? nil : vaultName
        server.authType = authType
        server.password = authType == .password ? password : nil
        server.privateKey = authType == .key ? privateKey : nil
        server.passphrase = authType == .key ? (passphrase.isEmpty ? nil : passphrase) : nil
        model.upsert(server)
        dismiss()
    }
}

private struct BitwardenItemPickerPage: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @Binding var itemName: String
    @Binding var username: String
    @Binding var authType: AuthType
    @Binding var password: String
    @Binding var privateKey: String
    @Binding var passphrase: String

    @State private var items: [BitwardenSelectableItem] = []
    @State private var loading = false
    @State private var error: String?
    @State private var showingAddItem = false

    var body: some View {
        Form {
            Section {
                TextField("Vault item name", text: $itemName)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            } footer: {
                Text("This is the login item name inside the configured ServerCase folder.")
            }

            Section {
                if loading {
                    ProgressView("Loading items...")
                } else if let error {
                    Text(error).foregroundStyle(.secondary)
                } else if items.isEmpty {
                    Text("No selectable items found.").foregroundStyle(.secondary)
                } else {
                    ForEach(items) { item in
                        BitwardenItemChoiceRow(item: item) { mode in
                            apply(item, mode: mode)
                        }
                    }
                }
            } header: {
                Text("Stored items")
            }
        }
        .navigationTitle("Bitwarden Item")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh") { Task { await loadItems() } }
                    .disabled(loading)
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Add item") { showingAddItem = true }
            }
        }
        .navigationDestination(isPresented: $showingAddItem) {
            AddBitwardenItemPage { item, mode in
                apply(item, mode: mode)
            }
        }
        .task { await loadItems() }
    }

    private func loadItems() async {
        loading = true
        error = nil
        do {
            items = try await model.bitwardenSelectableItems()
        } catch {
            items = []
            self.error = "Unlock Bitwarden first, then refresh."
        }
        loading = false
    }

    private func apply(_ item: BitwardenSelectableItem, mode: AuthType) {
        itemName = item.name
        if let itemUsername = item.secrets.username, !itemUsername.isEmpty {
            username = itemUsername
        }
        authType = mode
        switch mode {
        case .password:
            password = item.secrets.password ?? ""
            privateKey = ""
            passphrase = ""
        case .key:
            privateKey = item.secrets.privateKey ?? ""
            passphrase = item.secrets.passphrase ?? ""
            password = ""
        }
        dismiss()
    }
}

private struct AddBitwardenItemPage: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let onSave: (BitwardenSelectableItem, AuthType) -> Void

    @State private var itemName = ""
    @State private var username = "root"
    @State private var authType: AuthType = .password
    @State private var password = ""
    @State private var privateKey = ""
    @State private var passphrase = ""
    @State private var sshKeyItemName = ""
    @State private var saving = false
    @State private var error: String?

    private var canSave: Bool {
        !itemName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        (authType == .password
         ? !password.isEmpty
         : !privateKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        Form {
            Section("Item") {
                TextField("Username", text: $username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Vault item name", text: $itemName)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }

            Section("Credential") {
                Picker("Method", selection: $authType) {
                    ForEach(AuthType.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)

                if authType == .password {
                    SecureField("Password", text: $password)
                } else {
                    TextField("SSH key item name", text: $sshKeyItemName)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Private key (PEM)", text: $privateKey, axis: .vertical)
                        .lineLimit(5...10)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Passphrase (optional)", text: $passphrase)
                }
            }

            if let error {
                Section { Text(error).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Add Bitwarden Item")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }
                    .disabled(!canSave || saving)
            }
        }
    }

    private func save() {
        saving = true
        error = nil
        let cleanName = itemName.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanKeyItemName = sshKeyItemName.trimmingCharacters(in: .whitespacesAndNewlines)
        let secrets = ServerSecrets(
            username: cleanUsername,
            password: authType == .password ? password : nil,
            privateKey: authType == .key ? privateKey : nil,
            passphrase: authType == .key && !passphrase.isEmpty ? passphrase : nil,
            sshKeyItemName: authType == .key && !cleanKeyItemName.isEmpty ? cleanKeyItemName : nil
        )
        Task {
            do {
                try await model.saveBitwardenItem(name: cleanName, secrets: secrets)
                onSave(BitwardenSelectableItem(name: cleanName, secrets: secrets), authType)
            } catch {
                self.error = "Save failed: \(error.localizedDescription)"
            }
            saving = false
        }
    }
}

private struct BitwardenItemChoiceRow: View {
    let item: BitwardenSelectableItem
    let select: (AuthType) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.name)
                    if !item.username.isEmpty {
                        Text(item.username).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                credentialBadges
            }

            HStack {
                if item.hasPassword {
                    Button("Use password") { select(.password) }
                }
                if item.hasPrivateKey {
                    Button("Use SSH key") { select(.key) }
                }
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var credentialBadges: some View {
        HStack(spacing: 6) {
            if item.hasPassword {
                Label("Password", systemImage: "key.fill")
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
            }
            if item.hasPrivateKey {
                Label("SSH key", systemImage: "terminal.fill")
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
