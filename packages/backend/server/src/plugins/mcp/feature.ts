import { CanActivate, Injectable, UseGuards } from '@nestjs/common';

import { ActionForbidden } from '../../base';
import { Config } from '../../base/config';

@Injectable()
export class McpFeatureService {
  constructor(private readonly config: Config) {}

  get enabled() {
    return this.config.mcp.enabled;
  }

  assertEnabled() {
    if (!this.enabled) {
      throw new ActionForbidden('MCP is disabled.');
    }
  }
}

@Injectable()
export class McpFeatureGuard implements CanActivate {
  constructor(private readonly feature: McpFeatureService) {}

  canActivate() {
    this.feature.assertEnabled();
    return true;
  }
}

export const McpEnabled = () => UseGuards(McpFeatureGuard);
