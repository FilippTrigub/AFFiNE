import { defineModuleConfig } from '../../base';

declare global {
  interface AppConfigSchema {
    mcp: {
      enabled: boolean;
    };
  }
}

defineModuleConfig('mcp', {
  enabled: {
    desc: 'Enable the workspace MCP endpoint (/api/workspaces/:workspaceId/mcp).',
    default: false,
    env: ['AFFINE_MCP_ENABLED', 'boolean'],
  },
});
