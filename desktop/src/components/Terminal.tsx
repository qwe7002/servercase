import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  serverId: string;
}

/** A live SSH shell rendered with xterm.js, streamed over IPC. */
export function Terminal({ serverId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const api = window.servercase;
    if (!host || !api) return;

    const shellId = `sh-${Math.random().toString(36).slice(2, 8)}`;
    const term = new XTerm({
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0d12', foreground: '#d6dbe5' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let disposed = false;

    const offOutput = api.onShellOutput((sid, shid, data) => {
      if (sid === serverId && shid === shellId) term.write(data);
    });
    const offClosed = api.onShellClosed((sid, shid) => {
      if (sid === serverId && shid === shellId && !disposed) {
        term.writeln('\r\n\x1b[33m[session closed]\x1b[0m');
      }
    });

    term.onData((d) => api.sendShellData(serverId, shellId, d));

    void api.openShell(
      serverId,
      shellId,
      term.cols,
      term.rows,
    );

    const onResize = () => {
      fit.fit();
      api.resizeShell(serverId, shellId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      offOutput();
      offClosed();
      api.closeShell(serverId, shellId);
      term.dispose();
    };
  }, [serverId]);

  return (
    <div
      className="terminal m-3 flex-1 overflow-hidden rounded-lg border bg-[#0b0d12]"
      ref={hostRef}
    />
  );
}
