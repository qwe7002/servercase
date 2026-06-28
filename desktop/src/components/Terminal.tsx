import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSettings } from '../store/settings';
import { TERMINAL_SCHEMES } from '../lib/terminalTheme';
import { Button } from '@/components/ui/button';
import { ChevronDown, Code2 } from 'lucide-react';

interface Props {
  serverId: string;
}

/** A live SSH shell rendered with xterm.js, streamed over IPC. */
export function Terminal({ serverId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shellIdRef = useRef<string | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const snippets = useSettings((s) => s.settings.snippets);
  const terminal = useSettings((s) => s.settings.terminal);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    const api = window.servercase;
    if (!host || !api) return;

    const shellId = `sh-${Math.random().toString(36).slice(2, 8)}`;
    shellIdRef.current = shellId;
    // Read current settings at creation; later changes apply via the effect below.
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

    void api.openShell(serverId, shellId, term.cols, term.rows);

    const onResize = () => {
      fit.fit();
      api.resizeShell(serverId, shellId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      disposed = true;
      shellIdRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      ro.disconnect();
      offOutput();
      offClosed();
      api.closeShell(serverId, shellId);
      term.dispose();
    };
  }, [serverId]);

  // Apply terminal-setting changes to the live session without recreating it.
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

  const runSnippet = (command: string) => {
    const api = window.servercase;
    const shellId = shellIdRef.current;
    if (!api || !shellId) return;
    api.sendShellData(serverId, shellId, command + '\n');
    setMenuOpen(false);
  };

  return (
    <div
      className="m-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border"
      style={{ background: TERMINAL_SCHEMES[terminal.colorScheme].background }}
    >
      <div className="relative flex items-center justify-end border-b border-white/5 px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-muted-foreground"
          onClick={() => setMenuOpen((o) => !o)}
          disabled={snippets.length === 0}
          title={snippets.length === 0 ? 'No snippets configured' : 'Snippets'}
        >
          <Code2 className="size-3.5" /> Snippets <ChevronDown className="size-3" />
        </Button>
        {menuOpen && (
          <div className="absolute right-2 top-full z-10 mt-1 w-72 overflow-hidden rounded-md border bg-popover shadow-md">
            {snippets.map((s) => (
              <button
                key={s.id}
                className="block w-full px-3 py-2 text-left hover:bg-accent"
                onClick={() => runSnippet(s.command)}
              >
                <div className="truncate text-sm">{s.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {s.command}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="terminal min-h-0 flex-1 overflow-hidden p-1" ref={hostRef} />
    </div>
  );
}
