import './config';

import { Module } from '@nestjs/common';

import { DocStorageModule } from '../../core/doc';
import { PermissionModule } from '../../core/permission';
import { TranslateFeatureGuard, TranslateFeatureService } from './feature';
import { DocTranslationJob } from './job';
import { TranslationProvider } from './provider';
import { DocTranslationResolver } from './resolver';
import { DocTranslationWorker } from './worker';

@Module({
  imports: [DocStorageModule, PermissionModule],
  providers: [
    TranslateFeatureService,
    TranslateFeatureGuard,
    TranslationProvider,
    DocTranslationWorker,
    DocTranslationJob,
    DocTranslationResolver,
  ],
})
export class TranslateModule {}

export {
  TranslateEnabled,
  TranslateFeatureGuard,
  TranslateFeatureService,
} from './feature';
