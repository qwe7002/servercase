import SwiftUI

/// A lightweight command console: each submitted line runs as its own command
/// over the existing SSH connection and its output is appended below. (A full
/// interactive PTY shell is a planned follow-up.)
struct TerminalView: View {
    @EnvironmentObject private var model: AppModel
    let server: ServerConfig

    @State private var lines: [TerminalLine] = []
    @State private var command = ""
    @State private var running = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(lines) { line in
                            Text(line.text)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(line.isCommand ? Palette.accent : Color(white: 0.85))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                    }
                    .padding(8)
                }
                .onChange(of: lines.count) { _, _ in
                    if let last = lines.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            .background(Color.black)

            Divider()

            HStack(spacing: 8) {
                TextField("command", text: $command)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
                    .onSubmit(submit)
                Button(action: submit) {
                    Image(systemName: "arrow.up.circle.fill")
                }
                .disabled(running || command.isEmpty)
            }
            .padding(8)
        }
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !model.settings.snippets.isEmpty {
                    Menu {
                        ForEach(model.settings.snippets) { snippet in
                            Button(snippet.name) { run(snippet.command) }
                        }
                    } label: {
                        Image(systemName: "chevron.left.forwardslash.chevron.right")
                    }
                }
            }
        }
    }

    private func submit() { run(command) }

    private func run(_ raw: String) {
        let cmd = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cmd.isEmpty, let service = model.service(server.id) else { return }
        command = ""
        running = true
        lines.append(TerminalLine(text: "$ \(cmd)", isCommand: true))
        Task {
            do {
                let out = try await service.run(cmd)
                if !out.isEmpty {
                    lines.append(TerminalLine(text: out.trimmingCharacters(in: .newlines), isCommand: false))
                }
            } catch {
                lines.append(TerminalLine(text: error.localizedDescription, isCommand: false))
            }
            running = false
        }
    }
}

private struct TerminalLine: Identifiable {
    let id = UUID()
    let text: String
    let isCommand: Bool
}
