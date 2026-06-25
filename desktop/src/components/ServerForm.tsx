import { useState } from 'react';
import type { AuthType, ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';

interface Props {
  /** When editing, the existing server; otherwise undefined for a new one. */
  existing?: ServerConfig;
  onDone: () => void;
}

export function ServerForm({ existing, onDone }: Props) {
  const addServer = useServers((s) => s.addServer);
  const updateServer = useServers((s) => s.updateServer);

  const [name, setName] = useState(existing?.name ?? '');
  const [host, setHost] = useState(existing?.host ?? '');
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? 'root');
  const [authType, setAuthType] = useState<AuthType>(
    existing?.authType ?? 'password',
  );
  const [password, setPassword] = useState(existing?.password ?? '');
  const [privateKey, setPrivateKey] = useState(existing?.privateKey ?? '');
  const [passphrase, setPassphrase] = useState(existing?.passphrase ?? '');

  const canSave = name.trim() && host.trim() && username.trim();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    const base = {
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      authType,
      password: authType === 'password' ? password : undefined,
      privateKey: authType === 'key' ? privateKey : undefined,
      passphrase: authType === 'key' ? passphrase || undefined : undefined,
    };
    if (existing) updateServer({ ...base, id: existing.id });
    else addServer(base);
    onDone();
  };

  return (
    <div className="modal-backdrop" onClick={onDone}>
      <form
        className="modal card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>{existing ? 'Edit server' : 'Add server'}</h2>

        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>

        <div className="row">
          <label style={{ flex: 3 }}>
            Host
            <input
              value={host}
              placeholder="example.com or 10.0.0.5"
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            Port
            <input
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value)}
            />
          </label>
        </div>

        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>

        <div className="seg">
          <button
            type="button"
            className={authType === 'password' ? 'active' : ''}
            onClick={() => setAuthType('password')}
          >
            Password
          </button>
          <button
            type="button"
            className={authType === 'key' ? 'active' : ''}
            onClick={() => setAuthType('key')}
          >
            Private key
          </button>
        </div>

        {authType === 'password' ? (
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        ) : (
          <>
            <label>
              Private key (PEM)
              <textarea
                rows={5}
                value={privateKey}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                onChange={(e) => setPrivateKey(e.target.value)}
              />
            </label>
            <label>
              Passphrase (optional)
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </>
        )}

        <div className="row end">
          <button type="button" className="ghost" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canSave}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
