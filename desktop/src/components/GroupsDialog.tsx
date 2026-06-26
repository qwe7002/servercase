import { useState } from 'react';
import { useSettings } from '../store/settings';
import { useServers } from '../store/servers';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Plus, Trash2 } from 'lucide-react';

export function GroupsDialog({ onDone }: { onDone: () => void }) {
  const groups = useSettings((s) => s.settings.groups);
  const addGroup = useSettings((s) => s.addGroup);
  const renameGroup = useSettings((s) => s.renameGroup);
  const removeGroup = useSettings((s) => s.removeGroup);
  const servers = useServers((s) => s.servers);
  const [name, setName] = useState('');

  const add = () => {
    const n = name.trim();
    if (!n) return;
    addGroup(n);
    setName('');
  };

  const count = (id: string) => servers.filter((s) => s.groupId === id).length;

  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage groups</DialogTitle>
          <DialogDescription>
            Create groups, then assign servers to them from the server form.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={name}
            placeholder="New group name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            autoFocus
          />
          <Button onClick={add} disabled={!name.trim()}>
            <Plus /> Add
          </Button>
        </div>

        <div className="grid gap-2">
          {groups.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground">No groups yet.</p>
          )}
          {groups.map((g) => (
            <div key={g.id} className="flex items-center gap-2">
              <Input
                value={g.name}
                onChange={(e) => renameGroup(g.id, e.target.value)}
              />
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {count(g.id)}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                title={`Delete "${g.name}"`}
                onClick={() => removeGroup(g.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          {groups.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Deleting a group leaves its servers ungrouped.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
