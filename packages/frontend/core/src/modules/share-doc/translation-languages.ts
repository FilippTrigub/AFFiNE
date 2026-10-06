/** Languages a published doc can be translated into; mirrors the server. */
export const TRANSLATION_LANGUAGES = [
  'en',
  'fr',
  'es',
  'pt',
  'de',
  'pl',
  'nl',
] as const;

/** Native names, so every reader can find their own language. */
export const TRANSLATION_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  de: 'Deutsch',
  pl: 'Polski',
  nl: 'Nederlands',
};

export const translationLanguageName = (lang: string) =>
  TRANSLATION_LANGUAGE_NAMES[lang] ?? lang.toUpperCase();
