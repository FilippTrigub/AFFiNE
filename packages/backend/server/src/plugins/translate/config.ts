import { defineModuleConfig } from '../../base';

export interface TranslateConfig {
  enabled: ConfigItem<boolean>;
  gemini: {
    apiKey: ConfigItem<string>;
    model: ConfigItem<string>;
  };
}

declare global {
  interface AppConfigSchema {
    translate: TranslateConfig;
  }
}

defineModuleConfig('translate', {
  enabled: {
    desc: 'Let members publish machine translations of public docs.',
    default: false,
    env: ['AFFINE_TRANSLATE_ENABLED', 'boolean'],
  },
  'gemini.apiKey': {
    desc: 'Google Gemini API key used to translate published docs.',
    default: '',
    env: 'AFFINE_TRANSLATE_GEMINI_API_KEY',
  },
  'gemini.model': {
    desc: 'Gemini model id used for translation.',
    default: 'gemini-3.5-flash-lite',
    env: 'AFFINE_TRANSLATE_GEMINI_MODEL',
  },
});
