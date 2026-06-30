import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import type { SftpEntry, SftpList } from '../../electron/shared';
import { formatBytes } from '../format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  ArrowUp,
  ArrowRightCircle,
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

type SortColumn = 'name' | 'size' | 'type' | 'modified' | 'permissions';

interface FileSort {
  column: SortColumn;
  ascending: boolean;
}

type ColumnWidths = Record<SortColumn, number>;

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  name: 320,
  size: 110,
  type: 150,
  modified: 190,
  permissions: 120,
};

const MIN_COLUMN_WIDTHS: ColumnWidths = {
  name: 180,
  size: 90,
  type: 110,
  modified: 150,
  permissions: 100,
};

/**
 * A FileZilla-style remote file manager: a directory tree on the left, a
 * detailed file listing on the right, and a transfer/message log along the
 * bottom. Uploads and downloads go through the OS file dialogs.
 */
export function Sftp({ serverId }: Props) {
  const [cwd, setCwd] = useState('/');
  const [pathDraft, setPathDraft] = useState('/');
  const [pathFocused, setPathFocused] = useState(false);
  const [list, setList] = useState<SftpList | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SftpEntry | null>(null);
  const [renameText, setRenameText] = useState('');
  const [sort, setSort] = useState<FileSort>({ column: 'name', ascending: true });
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(DEFAULT_COLUMN_WIDTHS);
  const [resizeDrag, setResizeDrag] = useState<{
    column: SortColumn;
    startX: number;
    startWidth: number;
  } | null>(null);

  // Tree state: cached directory children + the set of expanded paths.
  const [treeChildren, setTreeChildren] = useState<Record<string, SftpEntry[]>>(
    {},
  );
  const treeChildrenRef = useRef(treeChildren);
  treeChildrenRef.current = treeChildren;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [log, setLog] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const api = window.servercase;

  const pathCompletions = useMemo(() => {
    const query = pathDraft.trim();
    if (!query) return ['/', '~', '.'];

    const candidates = new Set<string>(['/', '~', '.']);
    for (const entry of list?.entries ?? []) {
      if (entry.type === 'directory') candidates.add(joinPath(cwd, entry.name));
    }
    for (const [parent, children] of Object.entries(treeChildren)) {
      candidates.add(parent);
      for (const child of children) candidates.add(child.path);
    }

    return [...candidates]
      .filter((candidate) => candidate !== query && candidate.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, 8);
  }, [cwd, list?.entries, pathDraft, treeChildren]);

  const sortedEntries = useMemo(() => {
    const entries = [...(list?.entries ?? [])];
    entries.sort((a, b) => compareEntries(a, b, sort));
    return entries;
  }, [list?.entries, sort]);

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
      setPathDraft(result.path);
      setSelected(null);
      addLog('info', `Listing ${result.path} — ${result.entries.length} items`);

      // Reveal this path in the tree: cache each ancestor's subdirectories and
      // expand the whole chain from "/" down to the current directory, so the
      // tree always mirrors where you are.
      const chain = ancestorPaths(result.path);
      const updates: Record<string, SftpEntry[]> = {
        [result.path]: result.entries.filter((e) => e.type === 'directory'),
      };
      await Promise.all(
        chain.map(async (p) => {
          if (p === result.path || treeChildrenRef.current[p]) return;
          const r = await fetchDir(p);
          if (r) updates[p] = r.entries.filter((e) => e.type === 'directory');
        }),
      );
      setTreeChildren((prev) => ({ ...prev, ...updates }));
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const p of chain) next.add(p);
        return next;
      });
    },
    [fetchDir, addLog],
  );

  useEffect(() => {
    void navigate('.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const refresh = () => void navigate(cwd);

  const submitPathDraft = () => {
    const target = pathDraft.trim();
    if (!target) return;
    setPathFocused(false);
    void navigate(target);
  };

  const applyPathCompletion = (suggestion: string) => {
    setPathDraft(suggestion);
    setPathFocused(false);
    void navigate(suggestion);
  };

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

  const cacheTreeChildren = useCallback(
    async (dir: string) => {
      const result = await fetchDir(dir);
      if (!result) return;
      setTreeChildren((prev) => ({
        ...prev,
        [result.path]: result.entries.filter((e) => e.type === 'directory'),
      }));
    },
    [fetchDir],
  );

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

  const beginNewFolder = (parent = cwd) => {
    setNewFolderParent(parent);
    setNewFolderName('');
    setNewFolderOpen(true);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    const parent = newFolderParent ?? cwd;
    setNewFolderOpen(false);
    setNewFolderName('');
    setNewFolderParent(null);
    if (!name || !api) return;
    setBusy(true);
    try {
      const path = joinPath(parent, name);
      await api.sftp.mkdir(serverId, path);
      addLog('info', `Created ${path}`);
      await cacheTreeChildren(parent);
      await navigate(cwd);
    } catch (e) {
      addLog('error', `mkdir: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const beginRename = (entry: SftpEntry) => {
    setRenaming(entry);
    setRenameText(entry.name);
  };

  const confirmRename = async () => {
    const entry = renaming;
    const next = renameText.trim();
    setRenaming(null);
    setRenameText('');
    if (!entry || !next || next === entry.name || !api) return;
    setBusy(true);
    try {
      const parent = parentDirectory(entry.path);
      const dest = joinPath(parent, next);
      await api.sftp.rename(serverId, entry.path, dest);
      addLog('info', `Renamed ${entry.name} → ${next}`);
      await cacheTreeChildren(parent);
      await reloadCurrentOrNavigate(entry.path, dest);
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
      await cacheTreeChildren(parentDirectory(entry.path));
      await reloadCurrentOrNavigate(entry.path, null);
    } catch (e) {
      addLog('error', `delete: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const reloadCurrentOrNavigate = async (oldPath: string, newPath: string | null) => {
    if (cwd === oldPath || cwd.startsWith(oldPath + '/')) {
      if (newPath) {
        await navigate(newPath + cwd.slice(oldPath.length));
      } else {
        await navigate(parentDirectory(oldPath));
      }
    } else {
      await navigate(cwd);
    }
  };

  const updateSort = (column: SortColumn) => {
    setSort((current) =>
      current.column === column
        ? { column, ascending: !current.ascending }
        : { column, ascending: true },
    );
  };

  const beginColumnResize = (
    column: SortColumn,
    event: PointerEvent<HTMLSpanElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizeDrag({
      column,
      startX: event.clientX,
      startWidth: columnWidths[column],
    });
  };

  const resizeColumn = (event: PointerEvent<HTMLSpanElement>) => {
    if (!resizeDrag) return;
    event.preventDefault();
    const nextWidth = Math.max(
      MIN_COLUMN_WIDTHS[resizeDrag.column],
      resizeDrag.startWidth + event.clientX - resizeDrag.startX,
    );
    setColumnWidths((current) => ({
      ...current,
      [resizeDrag.column]: nextWidth,
    }));
  };

  const endColumnResize = (event: PointerEvent<HTMLSpanElement>) => {
    if (!resizeDrag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setResizeDrag(null);
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
        <div className="relative min-w-0 flex-1">
          <Input
            value={pathDraft}
            placeholder="Remote path"
            className="h-8 font-mono text-xs"
            onChange={(e) => setPathDraft(e.target.value)}
            onFocus={() => setPathFocused(true)}
            onBlur={() => setTimeout(() => setPathFocused(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPathDraft();
            }}
            autoCapitalize="none"
            autoCorrect="off"
          />
          {pathFocused && pathCompletions.length > 0 && (
            <div className="absolute left-0 right-0 top-10 z-30 flex gap-1 overflow-x-auto rounded-md border bg-popover p-1 shadow-md">
              {pathCompletions.map((suggestion) => (
                <button
                  key={suggestion}
                  className="max-w-52 shrink-0 truncate rounded px-2 py-1 font-mono text-xs text-popover-foreground hover:bg-accent"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyPathCompletion(suggestion);
                  }}
                  title={suggestion}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          title="Go"
          onClick={submitPathDraft}
          disabled={!pathDraft.trim()}
        >
          <ArrowRightCircle />
        </Button>
        <Button size="sm" variant="outline" onClick={upload} disabled={busy}>
          <Upload /> Upload
        </Button>
        <Button size="sm" variant="outline" onClick={() => beginNewFolder()} disabled={busy}>
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
            entry={null}
            depth={0}
            cwd={cwd}
            expanded={expanded}
            treeChildren={treeChildren}
            onToggle={toggleExpand}
            onSelect={(p) => void navigate(p)}
            onNewFolder={beginNewFolder}
            onRename={beginRename}
            onDelete={remove}
          />
        </div>

        <div className="relative min-w-0 flex-1 overflow-auto">
          {loading && list && (
            <div className="sticky inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-primary/70" />
          )}
          {loading && !list ? (
            <FileListSkeleton />
          ) : (
            <table
              className="text-sm"
              style={{ width: totalColumnWidth(columnWidths) }}
            >
              <colgroup>
                <col style={{ width: columnWidths.name }} />
                <col style={{ width: columnWidths.size }} />
                <col style={{ width: columnWidths.type }} />
                <col style={{ width: columnWidths.modified }} />
                <col style={{ width: columnWidths.permissions }} />
              </colgroup>
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr className="border-b">
                  <SortableHeader
                    column="name"
                    sort={sort}
                    onSort={updateSort}
                    onResizeStart={beginColumnResize}
                    onResizeMove={resizeColumn}
                    onResizeEnd={endColumnResize}
                    resizing={resizeDrag?.column === 'name'}
                    className="text-left"
                  >
                    Name
                  </SortableHeader>
                  <SortableHeader
                    column="size"
                    sort={sort}
                    onSort={updateSort}
                    onResizeStart={beginColumnResize}
                    onResizeMove={resizeColumn}
                    onResizeEnd={endColumnResize}
                    resizing={resizeDrag?.column === 'size'}
                    className="text-right"
                  >
                    Size
                  </SortableHeader>
                  <SortableHeader
                    column="type"
                    sort={sort}
                    onSort={updateSort}
                    onResizeStart={beginColumnResize}
                    onResizeMove={resizeColumn}
                    onResizeEnd={endColumnResize}
                    resizing={resizeDrag?.column === 'type'}
                    className="text-left"
                  >
                    Type
                  </SortableHeader>
                  <SortableHeader
                    column="modified"
                    sort={sort}
                    onSort={updateSort}
                    onResizeStart={beginColumnResize}
                    onResizeMove={resizeColumn}
                    onResizeEnd={endColumnResize}
                    resizing={resizeDrag?.column === 'modified'}
                    className="text-left"
                  >
                    Last modified
                  </SortableHeader>
                  <SortableHeader
                    column="permissions"
                    sort={sort}
                    onSort={updateSort}
                    onResizeStart={beginColumnResize}
                    onResizeMove={resizeColumn}
                    onResizeEnd={endColumnResize}
                    resizing={resizeDrag?.column === 'permissions'}
                    className="text-left"
                  >
                    Permissions
                  </SortableHeader>
                </tr>
              </thead>
              <tbody>
                {list?.entries.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      Empty directory.
                    </td>
                  </tr>
                )}
                {sortedEntries.map((entry) => (
                  <ContextMenu key={entry.path}>
                    <ContextMenuTrigger asChild>
                      <tr
                        className={`cursor-default border-b border-border/40 ${
                          selected === entry.path
                            ? 'bg-accent'
                            : 'hover:bg-accent/50'
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
                          {entry.type === 'file'
                            ? formatBytes(entry.sizeBytes)
                            : ''}
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
                      </tr>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => open(entry)}>
                        {entry.type === 'directory' ? <FolderOpen /> : <FileText />}{' '}
                        Open
                      </ContextMenuItem>
                      {entry.type === 'file' && (
                        <ContextMenuItem onSelect={() => download(entry)}>
                          <Download /> Download
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onSelect={() => beginRename(entry)}>
                        <Pencil /> Rename
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => remove(entry)}
                      >
                        <Trash2 /> Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
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

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder in {newFolderParent ?? cwd}.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void createFolder();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="new-folder-name">Name</Label>
              <Input
                id="new-folder-name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setNewFolderOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newFolderName.trim() || busy}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>
              Rename {renaming?.name ?? 'this item'}.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmRename();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="rename-name">Name</Label>
              <Input
                id="rename-name"
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!renameText.trim() || renameText.trim() === renaming?.name || busy}
              >
                Rename
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TreeNode({
  path,
  name,
  entry,
  depth,
  cwd,
  expanded,
  treeChildren,
  onToggle,
  onSelect,
  onNewFolder,
  onRename,
  onDelete,
}: {
  path: string;
  name: string;
  entry: SftpEntry | null;
  depth: number;
  cwd: string;
  expanded: Set<string>;
  treeChildren: Record<string, SftpEntry[]>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onNewFolder: (path: string) => void;
  onRename: (entry: SftpEntry) => void;
  onDelete: (entry: SftpEntry) => void;
}) {
  const isOpen = expanded.has(path);
  const children = treeChildren[path];
  const isCurrent = cwd === path;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={`flex cursor-pointer items-center gap-1 rounded-sm py-0.5 pr-2 hover:bg-accent/60 ${
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onNewFolder(path)}>
            <FolderPlus /> New Folder
          </ContextMenuItem>
          {entry && (
            <>
              <ContextMenuItem onSelect={() => onRename(entry)}>
                <Pencil /> Rename
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onDelete(entry)}
              >
                <Trash2 /> Delete
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {isOpen &&
        children?.map((child) => (
          <TreeNode
            key={child.path}
            path={child.path}
            name={child.name}
            entry={child}
            depth={depth + 1}
            cwd={cwd}
            expanded={expanded}
            treeChildren={treeChildren}
            onToggle={onToggle}
            onSelect={onSelect}
            onNewFolder={onNewFolder}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}

function FileListSkeleton() {
  return (
    <div className="space-y-1 p-3" aria-busy="true" aria-label="Loading files">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-1 py-1.5">
          <Skeleton className="size-4 shrink-0 rounded" />
          <Skeleton
            className="h-3.5"
            style={{ width: `${38 + ((i * 13) % 46)}%` }}
          />
          <Skeleton className="ml-auto h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function SortableHeader({
  column,
  sort,
  onSort,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  resizing,
  className,
  children,
}: {
  column: SortColumn;
  sort: FileSort;
  onSort: (column: SortColumn) => void;
  onResizeStart: (column: SortColumn, event: PointerEvent<HTMLSpanElement>) => void;
  onResizeMove: (event: PointerEvent<HTMLSpanElement>) => void;
  onResizeEnd: (event: PointerEvent<HTMLSpanElement>) => void;
  resizing: boolean;
  className?: string;
  children: ReactNode;
}) {
  const active = sort.column === column;
  return (
    <th className={`relative px-3 py-2 font-medium ${className ?? ''}`}>
      <button
        type="button"
        className={`inline-flex items-center gap-1 ${className?.includes('right') ? 'justify-end' : 'justify-start'} w-full`}
        onClick={() => onSort(column)}
      >
        <span>{children}</span>
        {active && (
          sort.ascending ? (
            <ChevronDown className="size-3 rotate-180" />
          ) : (
            <ChevronDown className="size-3" />
          )
        )}
      </button>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${String(children)} column`}
        className={`absolute right-0 top-1/2 h-7 w-3 -translate-y-1/2 cursor-col-resize touch-none before:absolute before:left-1/2 before:top-0 before:h-full before:w-px before:-translate-x-1/2 before:bg-border hover:before:bg-primary ${
          resizing ? 'before:bg-primary' : ''
        }`}
        onPointerDown={(event) => onResizeStart(column, event)}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
    </th>
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

function compareEntries(a: SftpEntry, b: SftpEntry, sort: FileSort): number {
  let result = 0;
  switch (sort.column) {
    case 'name':
      result = a.name.localeCompare(b.name, undefined, { numeric: true });
      break;
    case 'size':
      result = a.sizeBytes - b.sizeBytes;
      break;
    case 'type':
      result = typeLabel(a).localeCompare(typeLabel(b), undefined, { numeric: true });
      break;
    case 'modified':
      result = a.modifiedAt - b.modifiedAt;
      break;
    case 'permissions':
      result = a.mode.localeCompare(b.mode, undefined, { numeric: true });
      break;
  }
  return sort.ascending ? result : -result;
}

function totalColumnWidth(widths: ColumnWidths): number {
  return Object.values(widths).reduce((sum, width) => sum + width, 0);
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

function parentDirectory(path: string): string {
  const trimmed = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
  if (trimmed === '/') return '/';
  const parent = trimmed.split('/').slice(0, -1).join('/');
  return parent || '/';
}

/** ['/', '/a', '/a/b'] for '/a/b' — the chain from root to `abs` inclusive. */
function ancestorPaths(abs: string): string[] {
  const parts = abs.split('/').filter(Boolean);
  const out = ['/'];
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    out.push(cur);
  }
  return out;
}
