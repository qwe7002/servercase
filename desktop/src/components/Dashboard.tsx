import { useState } from 'react';
import type { ServerConfig } from '../../electron/shared';
import { useServers } from '../store/servers';
import {
  formatKb,
  formatRate,
  formatUptime,
  percent,
} from '../format';
import { Gauge, UsageBar } from './StatusCard';
import { Terminal } from './Terminal';

interface Props {
  server: ServerConfig;
}

type Tab = 'overview' | 'terminal';

export function Dashboard({ server }: Props) {
  const connState = useServers((s) => s.connState[server.id]) ?? 'disconnected';
  const status = useServers((s) => s.status[server.id]);
  const lastError = useServers((s) => s.lastError[server.id]);
  const setConnState = useServers((s) => s.setConnState);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    setConnState(server.id, 'connecting');
    try {
      await window.servercase.connect(server);
    } catch (e) {
      setConnState(server.id, 'error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await window.servercase.disconnect(server.id);
    setConnState(server.id, 'disconnected');
  };

  const connected = connState === 'connected';

  return (
    <main className="dashboard">
      <header className="dash-head">
        <div>
          <h1>{server.name}</h1>
          <span className="muted">
            {server.username}@{server.host}:{server.port}
            {status?.kernel ? ` · ${status.kernel}` : ''}
          </span>
        </div>
        <div className="row">
          <div className="tabs">
            <button
              className={tab === 'overview' ? 'active' : ''}
              onClick={() => setTab('overview')}
            >
              Overview
            </button>
            <button
              className={tab === 'terminal' ? 'active' : ''}
              onClick={() => setTab('terminal')}
            >
              Terminal
            </button>
          </div>
          {connected ? (
            <button className="ghost" onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            <button className="primary" onClick={connect} disabled={busy}>
              {connState === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </header>

      {connState === 'error' && lastError && (
        <div className="banner error">Connection failed: {lastError}</div>
      )}

      {tab === 'terminal' ? (
        connected ? (
          <Terminal serverId={server.id} />
        ) : (
          <div className="placeholder">Connect to open a terminal.</div>
        )
      ) : !connected ? (
        <div className="placeholder">
          {connState === 'connecting'
            ? 'Establishing SSH connection…'
            : 'Not connected. Press Connect to view live status.'}
        </div>
      ) : !status ? (
        <div className="placeholder">Collecting status…</div>
      ) : (
        <div className="overview">
          <section className="gauges">
            <Gauge
              label="CPU"
              value={status.cpuUsage}
              caption={`load ${status.loadAvg.map((n) => n.toFixed(2)).join(' ')}`}
            />
            <Gauge
              label="Memory"
              value={percent(status.memUsedKb, status.memTotalKb)}
              caption={`${formatKb(status.memUsedKb)} / ${formatKb(status.memTotalKb)}`}
            />
            <div className="card kv">
              <div>
                <span className="muted">Uptime</span>
                <strong>{formatUptime(status.uptimeSec)}</strong>
              </div>
              <div>
                <span className="muted">Net ↓</span>
                <strong>{formatRate(status.netRxBytesPerSec)}</strong>
              </div>
              <div>
                <span className="muted">Net ↑</span>
                <strong>{formatRate(status.netTxBytesPerSec)}</strong>
              </div>
              <div>
                <span className="muted">Host</span>
                <strong>{status.hostname || '–'}</strong>
              </div>
            </div>
          </section>

          <section className="card bars">
            <h3>Memory</h3>
            <UsageBar
              label="RAM"
              used={status.memUsedKb}
              total={status.memTotalKb}
              format={formatKb}
              pct={percent(status.memUsedKb, status.memTotalKb)}
            />
            {status.swapTotalKb > 0 && (
              <UsageBar
                label="Swap"
                used={status.swapUsedKb}
                total={status.swapTotalKb}
                format={formatKb}
                pct={percent(status.swapUsedKb, status.swapTotalKb)}
              />
            )}
          </section>

          <section className="card bars">
            <h3>Disks</h3>
            {status.disks.length === 0 && (
              <span className="muted">No mounts reported.</span>
            )}
            {status.disks.map((d) => (
              <UsageBar
                key={d.mount}
                label={`${d.mount} (${d.fs})`}
                used={d.usedKb}
                total={d.totalKb}
                format={formatKb}
                pct={percent(d.usedKb, d.totalKb)}
              />
            ))}
          </section>
        </div>
      )}
    </main>
  );
}
