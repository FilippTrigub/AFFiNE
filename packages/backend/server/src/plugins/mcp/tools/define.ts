import z from 'zod/v3';

type McpTextContent = {
  type: 'text';
  text: string;
};

export type WorkspaceMcpToolResult = {
  content: McpTextContent[];
  isError?: boolean;
};

export type WorkspaceMcpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

/**
 * `read` tools are listed for every credential; `write` tools only for
 * READ_WRITE credentials. `human` tools are never listed for a workspace agent:
 * they act on the whole workspace (sidebar, tags, collections) or need more than
 * the Editor ceiling an agent is held to (trash, publish).
 */
export type McpToolAccess = 'read' | 'write';
export type McpToolAudience = 'all' | 'human';

export type McpTool = {
  definition: WorkspaceMcpToolDefinition;
  access: McpToolAccess;
  audience: McpToolAudience;
};

type ToolExecutorInput<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  parser: T;
  inputSchema: Record<string, unknown>;
  execute: (
    args: z.infer<T>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

export function toolText(text: string): WorkspaceMcpToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

export function toolJson(value: unknown): WorkspaceMcpToolResult {
  return toolText(JSON.stringify(value));
}

export function toolError(message: string): WorkspaceMcpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

export function docNotFound(docId: string) {
  return toolError(`Doc with id ${docId} not found.`);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

function toInputError(error: z.ZodError) {
  const details = error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return toolError(`Invalid arguments: ${details || 'Invalid input'}`);
}

export function abortIfNeeded(
  signal: AbortSignal
): WorkspaceMcpToolResult | undefined {
  if (signal.aborted) return toolError('Request aborted.');
  return;
}

export function defineTool<T extends z.ZodTypeAny>(
  config: ToolExecutorInput<T>
): WorkspaceMcpToolDefinition {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: async (args, options) => {
      const aborted = abortIfNeeded(options.signal);
      if (aborted) return aborted;

      const parsed = config.parser.safeParse(args ?? {});
      if (!parsed.success) return toInputError(parsed.error);
      return await config.execute(parsed.data, options);
    },
  };
}

export function mcpTool<T extends z.ZodTypeAny>(
  access: McpToolAccess,
  audience: McpToolAudience,
  config: ToolExecutorInput<T>
): McpTool {
  return { definition: defineTool(config), access, audience };
}

/** Strip line breaks from a single-line name (titles, folder and tag names). */
export function sanitizeName(value: string, what: string) {
  const sanitized = value.replace(/[\r\n]+/g, ' ').trim();
  if (!sanitized) throw new Error(`${what} cannot be empty`);
  return sanitized;
}
