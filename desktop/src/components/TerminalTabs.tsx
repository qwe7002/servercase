import { useEffect, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { Button } from '@/components/ui/button';
import { Plus, SquareTerminal, X } from 'lucide-react';

interface Props {
  serverId: string;
}

interface TermTab {
  id: string;
}

/**
 * Hosts multiple terminal sessions as tabs for one server. New tab with ⌘T
 * (Ctrl+Shift+T on Windows/Linux). Every tab stays mounted while hidden, so its
 * shell keeps running and its scrollback is preserved when you switch back.
 */
export function TerminalTabs({ serverId }: Props) {
  const counter = useRef(1);
  const [tabs, setTabs] = useState<TermTab[]>([{ id: 't1' }]);
  const [activeId, setActiveId] = useState('t1');

  const addTab = () => {
    counter.current += 1;
    const id = `t${counter.current}`;
    setTabs((prev) => [...prev, { id }]);
    setActiveId(id);
  };

  const closeTab = (id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
      return next;
    });
  };

  // ⌘T / Ctrl+Shift+T → new tab. Capture phase so it fires before xterm, which
  // would otherwise swallow the keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const newTab =
        (e.metaKey && !e.ctrlKey && key === 't') || (e.ctrlKey && e.shiftKey && key === 't');
      if (newTab) {
        e.preventDefault();
        e.stopPropagation();
        addTab();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {tabs.map((t, i) => (
          <div
            key={t.id}
            className={`group flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
              t.id === activeId
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50'
            }`}
          >
            <button className="flex items-center gap-1.5" onClick={() => setActiveId(t.id)}>
              <SquareTerminal className="size-3.5" /> {i + 1}
            </button>
            {tabs.length > 1 && (
              <button
                className="opacity-0 transition hover:text-destructive group-hover:opacity-100"
                onClick={() => closeTab(t.id)}
                title="Close tab"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        ))}
        <Button
          size="icon"
          variant="ghost"
          className="size-6 text-muted-foreground"
          onClick={addTab}
          title="New tab (⌘T)"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={t.id === activeId ? 'absolute inset-0 flex flex-col' : 'hidden'}
          >
            <Terminal serverId={serverId} />
          </div>
        ))}
      </div>
    </div>
  );
}
