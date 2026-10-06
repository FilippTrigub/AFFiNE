import { CanActivate, Injectable, UseGuards } from '@nestjs/common';

import { ActionForbidden } from '../../base';
import { Config } from '../../base/config';

@Injectable()
export class TranslateFeatureService {
  constructor(private readonly config: Config) {}

  get enabled() {
    return this.config.translate.enabled;
  }

  assertEnabled() {
    if (!this.enabled) {
      throw new ActionForbidden('Doc translation is disabled.');
    }
  }
}

@Injectable()
export class TranslateFeatureGuard implements CanActivate {
  constructor(private readonly feature: TranslateFeatureService) {}

  canActivate() {
    this.feature.assertEnabled();
    return true;
  }
}

export const TranslateEnabled = () => UseGuards(TranslateFeatureGuard);
