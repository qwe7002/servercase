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
    @State private var probeHostId = ""
    @State private var authType: AuthType = .password
    @State private var password = ""
    @State private var privateKey = ""
    @State private var passphrase = ""

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty &&
        !host.trimmingCharacters(in: .whitespaces).isEmpty &&
        !username.trimmingCharacters(in: .whitespaces).isEmpty
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
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }

                Section("Probe data") {
                    Picker("Overview source", selection: $probeHostId) {
                        Text("Use SSH polling").tag("")
                        ForEach(model.probeHosts) { host in
                            Text(host.name).tag(host.id)
                        }
                    }
                }

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
        server.authType = authType
        server.password = authType == .password ? password : nil
        server.privateKey = authType == .key ? privateKey : nil
        server.passphrase = authType == .key ? (passphrase.isEmpty ? nil : passphrase) : nil
        model.upsert(server)
        dismiss()
    }
}
