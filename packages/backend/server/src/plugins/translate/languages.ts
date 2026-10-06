export const TRANSLATION_LANGUAGES = [
  'en',
  'fr',
  'es',
  'pt',
  'de',
  'pl',
  'nl',
] as const;

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<TranslationLanguage, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  de: 'German',
  pl: 'Polish',
  nl: 'Dutch',
};

export function isTranslationLanguage(
  value: string
): value is TranslationLanguage {
  return (TRANSLATION_LANGUAGES as readonly string[]).includes(value);
}
