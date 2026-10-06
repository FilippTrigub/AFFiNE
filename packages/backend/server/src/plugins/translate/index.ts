import './config';

import { Module } from '@nestjs/common';

import { DocStorageModule } from '../../core/doc';
import { TranslateFeatureGuard, TranslateFeatureService } from './feature';
import { DocTranslationJob } from './job';
import { TranslationProvider } from './provider';
import { DocTranslationWorker } from './worker';

@Module({
  imports: [DocStorageModule],
  providers: [
    TranslateFeatureService,
    TranslateFeatureGuard,
    TranslationProvider,
    DocTranslationWorker,
    DocTranslationJob,
  ],
})
export class TranslateModule {}

export {
  TranslateEnabled,
  TranslateFeatureGuard,
  TranslateFeatureService,
} from './feature';
