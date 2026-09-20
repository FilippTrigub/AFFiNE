import { Badge } from '@affine/admin/components/ui/badge';
import { Button } from '@affine/admin/components/ui/button';
import { Checkbox } from '@affine/admin/components/ui/checkbox';
import { Input } from '@affine/admin/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@affine/admin/components/ui/popover';
import { ScrollArea } from '@affine/admin/components/ui/scroll-area';
import { useQuery } from '@affine/admin/use-query';
import { adminWorkspacesQuery } from '@affine/graphql';
import { X } from 'lucide-react';
import { Suspense, useMemo, useState } from 'react';

/** One page is enough: a self-hosted instance has tens of workspaces, not thousands. */
const WORKSPACE_PAGE_SIZE = 200;

type Workspace = { id: string; name?: string | null };

export type WorkspacePickerProps = {
  selected: string[];
  onChange: (workspaces: string[]) => void;
};

const workspaceLabel = (workspace: Workspace) =>
  workspace.name?.trim() || 'Untitled workspace';

const WorkspaceOptions = ({ selected, onChange }: WorkspacePickerProps) => {
  const { data } = useQuery({
    query: adminWorkspacesQuery,
    variables: { filter: { first: WORKSPACE_PAGE_SIZE, skip: 0 } },
  });
  const [keyword, setKeyword] = useState('');

  const workspaces = useMemo(() => {
    const term = keyword.trim().toLowerCase();
    const all: Workspace[] = data.adminWorkspaces ?? [];
    if (!term) {
      return all;
    }
    return all.filter(
      workspace =>
        workspaceLabel(workspace).toLowerCase().includes(term) ||
        workspace.id.toLowerCase().includes(term)
    );
  }, [data.adminWorkspaces, keyword]);

  const toggle = (id: string) => {
    onChange(
      selected.includes(id)
        ? selected.filter(current => current !== id)
        : [...selected, id]
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <Input
        type="text"
        placeholder="Search workspaces"
        value={keyword}
        onChange={event => setKeyword(event.target.value)}
      />
      <ScrollArea className="h-56">
        <div className="flex flex-col gap-1 pr-2">
          {workspaces.length === 0 ? (
            <div className="px-1 py-2 text-sm text-muted-foreground">
              No workspaces found.
            </div>
          ) : (
            workspaces.map(workspace => (
              <label
                key={workspace.id}
                className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1.5 hover:bg-accent"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={selected.includes(workspace.id)}
                  onCheckedChange={() => toggle(workspace.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {workspaceLabel(workspace)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {workspace.id}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

/**
 * Multi-select over the instance's workspaces. Ids that no longer resolve to a
 * workspace stay selected and visible, so editing a rule never silently drops a
 * grant that only looks stale.
 */
export const WorkspacePicker = ({
  selected,
  onChange,
}: WorkspacePickerProps) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="h-9 justify-start">
            {selected.length
              ? `${selected.length} workspace${selected.length > 1 ? 's' : ''} selected`
              : 'Select workspaces'}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-3">
          <Suspense
            fallback={
              <div className="py-2 text-sm text-muted-foreground">
                Loading workspaces...
              </div>
            }
          >
            <WorkspaceOptions selected={selected} onChange={onChange} />
          </Suspense>
        </PopoverContent>
      </Popover>

      {selected.length ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(id => (
            <Badge key={id} variant="secondary" className="gap-1 font-normal">
              <span className="max-w-[16rem] truncate">{id}</span>
              <button
                type="button"
                aria-label={`Remove workspace ${id}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onChange(selected.filter(current => current !== id))
                }
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
};
