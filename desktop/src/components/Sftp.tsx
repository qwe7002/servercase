import { useCallback, useEffect, useRef, useState } from 'react';
import type { SftpEntry, SftpList } from '../../electron/shared';
import { formatBytes } from '../format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Link2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

interface Props {
  serverId: string;
}

/** Largest file we will open in the inline text editor. */
const MAX_EDIT_BYTES = 512 * 1024;

interface Editing {
  entry: SftpEntry;
  content: string;
  dirty: boolean;
}

interface LogLine {
  at: number;
  kind: 'info' | 'error';
  text: string;
}

/**
 * A FileZilla-style remote file manager: a directory tree on the left, a
 * detailed file listing on the right, and a transfer/message log along the
 * bottom. Uploads and downloads go through the OS file dialogs.
 */
export function Sftp({ serverId }: Props) {
  const [cwd, setCwd] = useState('/');
  const [list, setList] = useState<SftpList | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Tree state: cached directory children + the set of expanded paths.
  const [treeChildren, setTreeChildren] = useState<Record<string, SftpEntry[]>>(
    {},
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']));

  const [log, setLog] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const api = window.servercase;

  const addLog = useCallback((kind: LogLine['kind'], text: string) => {
    setLog((prev) => [...prev.slice(-200), { at: Date.now(), kind, text }]);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const fetchDir = useCallback(
    async (dir: string): Promise<SftpList | null> => {
      if (!api) return null;
      try {
        return await api.sftp.list(serverId, dir);
      } catch (e) {
        addLog('error', `${dir}: ${(e as Error).message}`);
        return null;
      }
    },
    [api, serverId, addLog],
  );

  const navigate = useCallback(
    async (dir: string) => {
      setLoading(true);
      const result = await fetchDir(dir);
      setLoading(false);
      if (!result) return;
      setList(result);
      setCwd(result.path);
      setSelected(null);
      setTreeChildren((prev) => ({
        ...prev,
        [result.path]: result.entries.filter((e) => e.type === 'directory'),
      }));
      setExpanded((prev) => new Set(prev).add(result.path));
      addLog('info', `Listing ${result.path} — ${result.entries.length} items`);
    },
    [fetchDir, addLog],
  );

  useEffect(() => {
    // Resolve the home directory, then anchor the tree at root.
    void (async () => {
      const home = await fetchDir('.');
      if (home) {
        setTreeChildren((prev) => ({
          ...prev,
          [home.path]: home.entries.filter((e) => e.type === 'directory'),
        }));
        await navigate(home.path);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const refresh = () => void navigate(cwd);

  const goUp = () => {
    const parent = cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    void navigate(parent || '/');
  };

  const toggleExpand = async (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) {
      next.delete(dir);
      setExpanded(next);
      return;
    }
    if (!treeChildren[dir]) {
      const result = await fetchDir(dir);
      if (result) {
        setTreeChildren((prev) => ({
          ...prev,
          [dir]: result.entries.filter((e) => e.type === 'directory'),
        }));
      }
    }
    next.add(dir);
    setExpanded(next);
  };

  const open = (entry: SftpEntry) => {
    if (entry.type === 'directory') {
      void navigate(entry.path);
      return;
    }
    if (entry.type === 'file') void openEditor(entry);
  };

  const openEditor = async (entry: SftpEntry) => {
    if (!api) return;
    if (entry.sizeBytes > MAX_EDIT_BYTES) {
      addLog('error', `${entry.name} is too large to edit — download instead`);
      return;
    }
    setBusy(true);
    try {
      const content = await api.sftp.readText(serverId, entry.path);
      setEditing({ entry, content, dirty: false });
    } catch (e) {
      addLog('error', `Open ${entry.name}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = async () => {
    if (!api || !editing) return;
    setBusy(true);
    try {
      await api.sftp.writeText(serverId, editing.entry.path, editing.content);
      setEditing({ ...editing, dirty: false });
      addLog('info', `Saved ${editing.entry.path}`);
    } catch (e) {
      addLog('error', `Save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const download = async (entry: SftpEntry) => {
    const ok = await api?.sftp.download(serverId, entry.path, entry.name);
    if (ok) addLog('info', `Downloaded ${entry.path}`);
  };

  const upload = async () => {
    setBusy(true);
    try {
      const ok = await api?.sftp.upload(serverId, cwd);
      if (ok) {
        addLog('info', `Uploaded file(s) to ${cwd}`);
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const mkdir = async () => {
    const name = prompt('New folder name');
    if (!name?.trim() || !api) return;
    setBusy(true);
    try {
      await api.sftp.mkdir(serverId, joinPath(cwd, name.trim()));
      addLog('info', `Created ${joinPath(cwd, name.trim())}`);
      refresh();
    } catch (e) {
      addLog('error', `mkdir: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (entry: SftpEntry) => {
    const next = prompt('Rename to', entry.name);
    if (!next?.trim() || next === entry.name || !api) return;
    setBusy(true);
    try {
      await api.sftp.rename(serverId, entry.path, joinPath(cwd, next.trim()));
      addLog('info', `Renamed ${entry.name} → ${next.trim()}`);
      refresh();
    } catch (e) {
      addLog('error', `rename: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: SftpEntry) => {
    if (!api || !confirm(`Delete "${entry.name}"?`)) return;
    setBusy(true);
    try {
      await api.sftp.remove(serverId, entry.path, entry.type === 'directory');
      addLog('info', `Deleted ${entry.path}`);
      refresh();
    } catch (e) {
      addLog('error', `delete: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm">{editing.entry.path}</div>
            <div className="text-xs text-muted-foreground">
              {editing.dirty ? 'Unsaved changes' : 'Saved'}
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={saveEditor} disabled={busy || !editing.dirty}>
              <Save /> Save
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)}>
              <X /> Close
            </Button>
          </div>
        </div>
        <Textarea
          className="min-h-0 flex-1 resize-none font-mono text-xs"
          value={editing.content}
          onChange={(e) =>
            setEditing({ ...editing, content: e.target.value, dirty: true })
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button size="icon" variant="ghost" title="Up" onClick={goUp}>
          <ArrowUp />
        </Button>
        <span className="shrink-0 text-xs text-muted-foreground">
          Remote site:
        </span>
        <Input readOnly value={cwd} className="h-8 flex-1 font-mono text-xs" />
        <Button size="sm" variant="outline" onClick={upload} disabled={busy}>
          <Upload /> Upload
        </Button>
        <Button size="sm" variant="outline" onClick={mkdir} disabled={busy}>
          <FolderPlus /> New folder
        </Button>
        <Button size="icon" variant="ghost" title="Refresh" onClick={refresh}>
          <RefreshCw />
        </Button>
      </div>

      {/* Two-pane: directory tree | file listing */}
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-auto border-r bg-card/40 py-1 text-sm">
          <TreeNode
            path="/"
            name="/"
            depth={0}
            cwd={cwd}
            expanded={expanded}
            treeChildren={treeChildren}
            onToggle={toggleExpand}
            onSelect={(p) => void navigate(p)}
          />
        </div>

        <div className="min-w-0 flex-1 overflow-auto">
          {loading && !list ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-right font-medium">Size</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Last modified
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Permissions</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {list?.entries.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      Empty directory.
                    </td>
                  </tr>
                )}
                {list?.entries.map((entry) => (
                  <tr
                    key={entry.path}
                    className={`group cursor-default border-b border-border/40 ${
                      selected === entry.path ? 'bg-accent' : 'hover:bg-accent/50'
                    }`}
                    onClick={() => setSelected(entry.path)}
                    onDoubleClick={() => open(entry)}
                  >
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <EntryIcon type={entry.type} />
                        <span className="truncate">{entry.name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {entry.type === 'file' ? formatBytes(entry.sizeBytes) : ''}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {typeLabel(entry)}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {entry.modifiedAt
                        ? new Date(entry.modifiedAt).toLocaleString()
                        : ''}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                      {entry.mode}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
                        {entry.type === 'file' && (
                          <IconBtn
                            title="Download"
                            onClick={() => download(entry)}
                          >
                            <Download className="size-3.5" />
                          </IconBtn>
                        )}
                        <IconBtn title="Rename" onClick={() => rename(entry)}>
                          <Pencil className="size-3.5" />
                        </IconBtn>
                        <IconBtn title="Delete" danger onClick={() => remove(entry)}>
                          <Trash2 className="size-3.5" />
                        </IconBtn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Message / transfer log */}
      <div
        ref={logRef}
        className="h-28 shrink-0 overflow-auto border-t bg-[#0b0d12] px-3 py-2 font-mono text-xs"
      >
        {log.length === 0 ? (
          <span className="text-muted-foreground">Status messages appear here.</span>
        ) : (
          log.map((l, i) => (
            <div
              key={i}
              className={l.kind === 'error' ? 'text-destructive' : 'text-emerald-400/90'}
            >
              <span className="text-muted-foreground">
                {new Date(l.at).toLocaleTimeString()}{' '}
              </span>
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TreeNode({
  path,
  name,
  depth,
  cwd,
  expanded,
  treeChildren,
  onToggle,
  onSelect,
}: {
  path: string;
  name: string;
  depth: number;
  cwd: string;
  expanded: Set<string>;
  treeChildren: Record<string, SftpEntry[]>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isOpen = expanded.has(path);
  const children = treeChildren[path];
  const isCurrent = cwd === path;

  return (
    <div>
      <div
        className={`flex cursor-pointer items-center gap-1 py-0.5 pr-2 hover:bg-accent/60 ${
          isCurrent ? 'bg-accent' : ''
        }`}
        style={{ paddingLeft: depth * 14 + 4 }}
        onClick={() => onSelect(path)}
      >
        <button
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(path);
          }}
        >
          {isOpen ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
        {depth === 0 ? (
          <HardDrive className="size-4 shrink-0 text-muted-foreground" />
        ) : isOpen ? (
          <FolderOpen className="size-4 shrink-0 text-amber-500" />
        ) : (
          <Folder className="size-4 shrink-0 text-amber-500" />
        )}
        <span className="truncate">{name}</span>
      </div>
      {isOpen &&
        children?.map((child) => (
          <TreeNode
            key={child.path}
            path={child.path}
            name={child.name}
            depth={depth + 1}
            cwd={cwd}
            expanded={expanded}
            treeChildren={treeChildren}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

function EntryIcon({ type }: { type: SftpEntry['type'] }) {
  if (type === 'directory')
    return <Folder className="size-4 shrink-0 text-amber-500" />;
  if (type === 'symlink')
    return <Link2 className="size-4 shrink-0 text-sky-500" />;
  if (type === 'file')
    return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function IconBtn({
  children,
  title,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        danger ? 'size-7 text-muted-foreground hover:text-destructive' : 'size-7'
      }
    >
      {children}
    </Button>
  );
}

function typeLabel(entry: SftpEntry): string {
  if (entry.type === 'directory') return 'Directory';
  if (entry.type === 'symlink') return 'Symbolic link';
  const dot = entry.name.lastIndexOf('.');
  if (entry.type === 'file' && dot > 0) {
    return `${entry.name.slice(dot + 1).toLowerCase()} file`;
  }
  return 'File';
}

function joinPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, '');
  return base === '' ? `/${name}` : `${base}/${name}`;
}
