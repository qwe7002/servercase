import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type {
  BleSerialDeviceInfo,
  SerialConnectionState,
  WiredSerialPortInfo,
} from '../../electron/shared';
import { TERMINAL_SCHEMES } from '../lib/terminalTheme';
import { useSettings } from '../store/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Bluetooth,
  Cable,
  Loader2,
  PlugZap,
  RefreshCw,
  Trash2,
  Unplug,
} from 'lucide-react';

type Transport = 'wired' | 'ble';

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DEFAULT_BLE_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const DEFAULT_BLE_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const DEFAULT_BLE_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

export function SerialConsole() {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = useMemo(() => `serial-${Math.random().toString(36).slice(2, 9)}`, []);
  const terminal = useSettings((s) => s.settings.terminal);
  const [transport, setTransport] = useState<Transport>('wired');
  const [ports, setPorts] = useState<WiredSerialPortInfo[]>([]);
  const [devices, setDevices] = useState<BleSerialDeviceInfo[]>([]);
  const [path, setPath] = useState('');
  const [baudRate, setBaudRate] = useState(115200);
  const [deviceId, setDeviceId] = useState('');
  const [serviceUuid, setServiceUuid] = useState(DEFAULT_BLE_SERVICE);
  const [writeUuid, setWriteUuid] = useState(DEFAULT_BLE_WRITE);
  const [notifyUuid, setNotifyUuid] = useState(DEFAULT_BLE_NOTIFY);
  const [state, setState] = useState<SerialConnectionState>('closed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshPorts();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const api = window.servercase;
    if (!host || !api) return;

    const t = useSettings.getState().settings.terminal;
    const scheme = TERMINAL_SCHEMES[t.colorScheme];
    const term = new XTerm({
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: t.fontSize,
      cursorBlink: t.cursorBlink,
      cursorStyle: t.cursorStyle,
      scrollback: t.scrollback,
      theme: { background: scheme.background, foreground: scheme.foreground },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const offData = api.serial.onData((id, data) => {
      if (id === sessionId) term.write(data);
    });
    const offEvent = api.serial.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      setState(event.state);
      if (event.error) {
        setError(event.error);
        term.writeln(`\r\n\x1b[31m[${event.error}]\x1b[0m`);
      } else if (event.state === 'open') {
        term.writeln('\x1b[32m[serial connected]\x1b[0m');
      } else if (event.state === 'closed') {
        term.writeln('\r\n\x1b[33m[serial closed]\x1b[0m');
      }
    });
    term.onData((data) => {
      if (stateRef.current !== 'open') return;
      void api.serial.write(sessionId, data).catch((e) => {
        setError((e as Error).message);
      });
    });

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(host);

    return () => {
      ro.disconnect();
      offData();
      offEvent();
      void api.serial.close(sessionId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const scheme = TERMINAL_SCHEMES[terminal.colorScheme];
    term.options.fontSize = terminal.fontSize;
    term.options.cursorBlink = terminal.cursorBlink;
    term.options.cursorStyle = terminal.cursorStyle;
    term.options.scrollback = terminal.scrollback;
    term.options.theme = { background: scheme.background, foreground: scheme.foreground };
    fitRef.current?.fit();
  }, [
    terminal.fontSize,
    terminal.cursorBlink,
    terminal.cursorStyle,
    terminal.scrollback,
    terminal.colorScheme,
  ]);

  const refreshPorts = async () => {
    const api = window.servercase;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.serial.listPorts();
      setPorts(next);
      setPath((current) => current || next[0]?.path || '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scanBle = async () => {
    const api = window.servercase;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.serial.scanBle(6500);
      setDevices(next);
      setDeviceId((current) => current || next[0]?.id || '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const api = window.servercase;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      if (transport === 'wired') {
        await api.serial.open(sessionId, {
          transport,
          path,
          baudRate,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
        });
      } else {
        await api.serial.open(sessionId, {
          transport,
          peripheralId: deviceId,
          serviceUuid,
          writeCharacteristicUuid: writeUuid,
          notifyCharacteristicUuid: notifyUuid,
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const api = window.servercase;
    if (!api) return;
    setBusy(true);
    try {
      await api.serial.close(sessionId);
    } finally {
      setBusy(false);
    }
  };

  const connected = state === 'open';
  const canConnect =
    !busy &&
    !connected &&
    ((transport === 'wired' && path.trim()) || (transport === 'ble' && deviceId.trim()));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid gap-3 border-b p-3 xl:grid-cols-[auto_1fr_auto]">
        <div className="flex items-center gap-1">
          <Button
            variant={transport === 'wired' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTransport('wired')}
            disabled={connected}
            title="USB / wired serial"
          >
            <Cable className="size-4" /> USB
          </Button>
          <Button
            variant={transport === 'ble' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTransport('ble')}
            disabled={connected}
            title="BLE GATT UART"
          >
            <Bluetooth className="size-4" /> BLE
          </Button>
        </div>

        {transport === 'wired' ? (
          <div className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_120px_auto]">
            <Field label="Port">
              <select
                value={path}
                onChange={(e) => setPath(e.target.value)}
                disabled={connected}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {ports.length === 0 && <option value="">No serial ports</option>}
                {ports.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.path}
                    {p.manufacturer ? ` · ${p.manufacturer}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Baud">
              <select
                value={baudRate}
                onChange={(e) => setBaudRate(Number(e.target.value))}
                disabled={connected}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}
                  </option>
                ))}
              </select>
            </Field>
            <Button variant="outline" onClick={() => void refreshPorts()} disabled={busy || connected}>
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh
            </Button>
          </div>
        ) : (
          <div className="grid gap-2 xl:grid-cols-[minmax(220px,1fr)_repeat(3,minmax(180px,1fr))_auto]">
            <Field label="Device">
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                disabled={connected}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {devices.length === 0 && <option value="">Scan for devices</option>}
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.rssi} dBm
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Service UUID">
              <Input value={serviceUuid} onChange={(e) => setServiceUuid(e.target.value)} disabled={connected} />
            </Field>
            <Field label="Write UUID">
              <Input value={writeUuid} onChange={(e) => setWriteUuid(e.target.value)} disabled={connected} />
            </Field>
            <Field label="Notify UUID">
              <Input value={notifyUuid} onChange={(e) => setNotifyUuid(e.target.value)} disabled={connected} />
            </Field>
            <Button variant="outline" onClick={() => void scanBle()} disabled={busy || connected}>
              {busy ? <Loader2 className="animate-spin" /> : <Bluetooth />}
              Scan
            </Button>
          </div>
        )}

        <div className="flex items-end gap-2">
          {connected ? (
            <Button variant="outline" onClick={() => void disconnect()} disabled={busy}>
              <Unplug /> Disconnect
            </Button>
          ) : (
            <Button onClick={() => void connect()} disabled={!canConnect}>
              {busy ? <Loader2 className="animate-spin" /> : <PlugZap />}
              Connect
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => termRef.current?.clear()}
            title="Clear terminal"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div
        className="terminal m-3 min-h-0 flex-1 overflow-hidden rounded-lg border p-1"
        style={{ background: TERMINAL_SCHEMES[terminal.colorScheme].background }}
        ref={hostRef}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
