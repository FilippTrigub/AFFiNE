import { Button } from '@affine/admin/components/ui/button';
import { Input } from '@affine/admin/components/ui/input';
import { Label } from '@affine/admin/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@affine/admin/components/ui/select';
import { Switch } from '@affine/admin/components/ui/switch';
import { cn } from '@affine/admin/utils';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type AllowlistRule,
  createRule,
  describePattern,
  parseAllowlist,
  serializeAllowlist,
  validateRules,
} from './model';
import { WorkspacePicker } from './workspace-picker';

export type EmailAllowlistInputProps = {
  defaultValue: unknown;
  onChange: (value?: any) => void;
  onValidationChange?: (error?: string) => void;
};

const RuleCard = ({
  rule,
  onChange,
  onRemove,
}: {
  rule: AllowlistRule;
  onChange: (rule: AllowlistRule) => void;
  onRemove: () => void;
}) => {
  const description = describePattern(rule.pattern);
  // Kept locally: a rule that grants nothing is indistinguishable from one whose
  // workspace list the admin has opened but not filled in yet.
  const [grants, setGrants] = useState(rule.workspaces.length > 0);

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border/60 p-4">
      <div className="flex items-start gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`${rule.id}-pattern`}>Domain or address</Label>
          <Input
            id={`${rule.id}-pattern`}
            type="text"
            placeholder="example.com, *.example.com or someone@example.com"
            value={rule.pattern}
            onChange={event =>
              onChange({ ...rule, pattern: event.target.value })
            }
          />
          <p
            className={cn(
              'text-xs',
              description?.invalid
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {description?.text ??
              'A bare domain, a "*." wildcard covering its subdomains, or one full address.'}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove rule"
          className="mt-6 shrink-0"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-md bg-muted/40 p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor={`${rule.id}-grant`}>
              Add matching new accounts to workspaces
            </Label>
            <p className="text-xs text-muted-foreground">
              Applied the moment the account is created, with no invite and no
              review. It never touches accounts that already exist.
            </p>
          </div>
          <Switch
            id={`${rule.id}-grant`}
            checked={grants}
            onCheckedChange={checked => {
              setGrants(checked);
              if (!checked && rule.workspaces.length) {
                onChange({ ...rule, workspaces: [] });
              }
            }}
          />
        </div>

        {grants ? (
          <div className="flex flex-col gap-3">
            <WorkspacePicker
              selected={rule.workspaces}
              onChange={workspaces => onChange({ ...rule, workspaces })}
            />
            <div className="flex items-center gap-3">
              <Label htmlFor={`${rule.id}-role`} className="shrink-0">
                Joins as
              </Label>
              <Select
                value={rule.role}
                onValueChange={role =>
                  onChange({ ...rule, role: role as AllowlistRule['role'] })
                }
              >
                <SelectTrigger id={`${rule.id}-role`} className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Collaborator">Collaborator</SelectItem>
                  <SelectItem value="Admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * Form editor for `auth.allowedEmailDomains`, in place of hand-written JSON.
 * Emits the same value the JSON textarea did, so the server side is untouched.
 */
export const EmailAllowlistInput = ({
  defaultValue,
  onChange,
  onValidationChange,
}: EmailAllowlistInputProps) => {
  const [rules, setRules] = useState<AllowlistRule[]>(() =>
    parseAllowlist(defaultValue)
  );
  // The parent owns "dirty"; report only what the admin actually edited, or
  // every group would open dirty just from rendering the form.
  const edited = useRef(false);

  const apply = useCallback(
    (next: AllowlistRule[]) => {
      edited.current = true;
      setRules(next);
      onChange(serializeAllowlist(next));
    },
    [onChange]
  );

  const error = validateRules(rules);
  useEffect(() => {
    onValidationChange?.(edited.current ? error : undefined);
  }, [error, onValidationChange]);

  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
          No rules. Anyone who can reach this server may create an account. Add
          a rule to restrict sign-up.
        </div>
      ) : (
        rules.map((rule, index) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            onChange={next =>
              apply(rules.map((current, i) => (i === index ? next : current)))
            }
            onRemove={() => apply(rules.filter((_, i) => i !== index))}
          />
        ))
      )}

      <Button
        type="button"
        variant="outline"
        className="h-9 self-start"
        onClick={() => apply([...rules, createRule()])}
      >
        <Plus className="mr-1 h-4 w-4" />
        Add rule
      </Button>
    </div>
  );
};
