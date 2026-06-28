import { useCallback, useEffect, useState } from 'react';
import type { PortForwardInfo, ServerConfig } from '../../electron/shared';
import {
  closeSshPortForward,
  listSshPortForwards,
  openSshPortForward,
} from '../lib/portForward';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  AlertCircle,
  ArrowRight,
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

interface Props {
  server: ServerConfig;
}

interface FormState {
  label: string;
  localHost: string;
  localPort: string;
  remoteHost: string;
  remotePort: string;
}

const EMPTY_FORM: FormState = {
  label: '',
  localHost: '127.0.0.1',
  localPort: '',
  remoteHost: '127.0.0.1',
  remotePort: '',
};

/**
 * Per-server panel for SSH local port forwarding: lists the live tunnels and
 * opens new ones (a local listener piped to a host:port reachable from the
 * remote server). Tunnels are owned by the SSH connection, so they close with
 * it; this panel just configures and surfaces them.
 */
export function PortForwards({ server }: Props) {
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setForwards(await listSshPortForwards(server.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [server.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const open = async () => {
    const remotePort = Number(form.remotePort);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      setError('Remote port must be between 1 and 65535.');
      return;
    }
    const localPort = form.localPort.trim() === '' ? 0 : Number(form.localPort);
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
      setError('Local port must be between 0 and 65535 (0 picks a free port).');
      return;
    }
    setOpening(true);
    setError(null);
    try {
      await openSshPortForward(server, {
        label: form.label.trim() || undefined,
        localHost: form.localHost.trim() || '127.0.0.1',
        localPort,
        remoteHost: form.remoteHost.trim() || '127.0.0.1',
        remotePort,
      });
      setForm((prev) => ({ ...EMPTY_FORM, localHost: prev.localHost }));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  const close = async (id: string) => {
    setClosing(id);
    setError(null);
    try {
      await closeSshPortForward(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClosing(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Port forwarding error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">New local forward</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Label (optional)">
              <Input
                placeholder="e.g. database"
                value={form.label}
                onChange={(e) => update({ label: e.target.value })}
              />
            </Field>
            <div />
            <Field label="Local host">
              <Input
                value={form.localHost}
                onChange={(e) => update({ localHost: e.target.value })}
              />
            </Field>
            <Field label="Local port (0 = auto)">
              <Input
                inputMode="numeric"
                placeholder="0"
                value={form.localPort}
                onChange={(e) => update({ localPort: e.target.value })}
              />
            </Field>
            <Field label="Remote host">
              <Input
                value={form.remoteHost}
                onChange={(e) => update({ remoteHost: e.target.value })}
              />
            </Field>
            <Field label="Remote port">
              <Input
                inputMode="numeric"
                placeholder="5432"
                value={form.remotePort}
                onChange={(e) => update({ remotePort: e.target.value })}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Connections to{' '}
            <span className="font-mono">
              {form.localHost || '127.0.0.1'}:{form.localPort || 'auto'}
            </span>{' '}
            are tunnelled through this server to{' '}
            <span className="font-mono">
              {form.remoteHost || '127.0.0.1'}:{form.remotePort || '?'}
            </span>
            .
          </p>
          <Button onClick={() => void open()} disabled={opening}>
            {opening ? <Loader2 className="animate-spin" /> : <Plus />}
            {opening ? 'Opening…' : 'Open forward'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle className="text-base">Active forwards</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            <RefreshCw />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {forwards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active forwards. Open one above.
            </p>
          ) : (
            forwards.map((f) => (
              <ForwardRow
                key={f.id}
                forward={f}
                closing={closing === f.id}
                onClose={() => void close(f.id)}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ForwardRow({
  forward,
  closing,
  onClose,
}: {
  forward: PortForwardInfo;
  closing: boolean;
  onClose: () => void;
}) {
  const local = `${forward.localHost}:${forward.localPort}`;
  const remote = `${forward.remoteHost}:${forward.remotePort}`;
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-sm">
        <span className="truncate" title={local}>
          {local}
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-muted-foreground" title={remote}>
          {remote}
        </span>
      </div>
      {forward.label && <Badge variant="secondary">{forward.label}</Badge>}
      <Button
        variant="ghost"
        size="icon"
        title="Copy local address"
        onClick={() => void navigator.clipboard?.writeText(local)}
      >
        <Copy />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="Close forward"
        onClick={onClose}
        disabled={closing}
      >
        {closing ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
