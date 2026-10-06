import { Injectable } from '@nestjs/common';

import { Config } from '../../base/config';
import { createGeminiClient, type GenerateText } from './gemini';

/** Builds the model client from live config; null while no key is set. */
@Injectable()
export class TranslationProvider {
  constructor(private readonly config: Config) {}

  generator(): GenerateText | null {
    const { apiKey, model } = this.config.translate.gemini;
    return apiKey ? createGeminiClient({ apiKey, model }) : null;
  }
}
