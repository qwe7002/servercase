/**
 * Thin HTTP client for the ServerCase control bridge. The MCP server holds only
 * a URL and a token — never credentials or the Bitwarden vault. ServerCase owns
 * login and the live SSH connections; this just forwards operations to it.
 */
export class BridgeClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(
        `Cannot reach ServerCase bridge at ${this.url} — is the app running with the AI bridge enabled? (${(e as Error).message})`,
      );
    }
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new Error(json.error || `bridge ${path} failed: ${res.status}`);
    }
    return json;
  }

  listServers() {
    return this.req('GET', '/servers');
  }
  connect(server: string) {
    return this.req('POST', '/connect', { server });
  }
  exec(server: string, command: string) {
    return this.req('POST', '/exec', { server, command });
  }
  status(server: string) {
    return this.req('POST', '/status', { server });
  }
  sftpList(server: string, path: string) {
    return this.req('POST', '/sftp/list', { server, path });
  }
  sftpRead(server: string, path: string) {
    return this.req('POST', '/sftp/read', { server, path });
  }
  sftpWrite(server: string, path: string, content: string) {
    return this.req('POST', '/sftp/write', { server, path, content });
  }
  sftpMkdir(server: string, path: string) {
    return this.req('POST', '/sftp/mkdir', { server, path });
  }
  sftpRemove(server: string, path: string, directory: boolean) {
    return this.req('POST', '/sftp/remove', { server, path, directory });
  }
}
