import {
  Button,
  Checkbox,
  Menu,
  MenuItem,
  MenuTrigger,
  notify,
} from '@affine/component';
import { useAsyncCallback } from '@affine/core/components/hooks/affine-async-hooks';
import {
  type DocTranslation,
  DocTranslationsService,
  TRANSLATION_LANGUAGES,
  translationLanguageName,
} from '@affine/core/modules/share-doc';
import { UserFriendlyError } from '@affine/error';
import { useI18n } from '@affine/i18n';
import { useLiveData, useService } from '@toeverything/infra';
import { useEffect } from 'react';

import * as styles from './published-translations.css';

/** How often the menu re-reads statuses while a translation runs. */
const POLL_MS = 5000;

const DEFAULT_SOURCE_LANG = 'en';

function TranslationStatus({ row }: { row: DocTranslation }) {
  const t = useI18n();
  const label =
    row.status === 'ready' && row.outOfDate
      ? t['com.affine.share-menu.translations.out-of-date']()
      : t[`com.affine.share-menu.translations.status.${row.status}`]();
  return (
    <span
      className={styles.status}
      data-status={row.status}
      data-out-of-date={row.outOfDate}
      title={row.error ?? undefined}
    >
      {label}
    </span>
  );
}

/**
 * Machine translations offered to readers of the public page. Shown under
 * "Share to web" once the doc is public; hidden while the server has the
 * feature off.
 */
export const PublishedTranslations = () => {
  const t = useI18n();
  const service = useService(DocTranslationsService);
  const available = useLiveData(service.available$);
  const rows = useLiveData(service.translations$);
  const inProgress = useLiveData(service.inProgress$);

  useEffect(() => {
    service.revalidate().catch(console.error);
  }, [service]);

  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(() => {
      service.revalidate().catch(console.error);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [inProgress, service]);

  const sourceLang = rows[0]?.sourceLang ?? DEFAULT_SOURCE_LANG;
  const selected = new Set(rows.map(row => row.lang));

  const save = useAsyncCallback(
    async (nextSource: string, languages: string[]) => {
      try {
        await service.setLanguages(
          nextSource,
          languages.filter(lang => lang !== nextSource)
        );
      } catch (error) {
        const err = UserFriendlyError.fromAny(error);
        notify.error({
          title: t['com.affine.share-menu.translations.save-failed'](),
          message: err.message,
        });
      }
    },
    [service, t]
  );

  const refresh = useAsyncCallback(async () => {
    try {
      await service.refresh();
    } catch (error) {
      const err = UserFriendlyError.fromAny(error);
      notify.error({
        title: t['com.affine.share-menu.translations.save-failed'](),
        message: err.message,
      });
    }
  }, [service, t]);

  if (!available) return null;

  const toggle = (lang: string, checked: boolean) => {
    const next = checked
      ? [...selected, lang]
      : [...selected].filter(selectedLang => selectedLang !== lang);
    save(sourceLang, next);
  };

  return (
    <div className={styles.container} data-testid="share-menu-translations">
      <div className={styles.header}>
        <span>{t['com.affine.share-menu.translations.label']()}</span>
        <Button
          variant="plain"
          size="default"
          disabled={!rows.length || inProgress}
          onClick={refresh}
          data-testid="share-menu-translations-update"
        >
          {t['com.affine.share-menu.translations.update']()}
        </Button>
      </div>
      <div className={styles.header}>
        <span>{t['com.affine.share-menu.translations.source']()}</span>
        <Menu
          contentOptions={{ align: 'end' }}
          items={TRANSLATION_LANGUAGES.map(lang => (
            <MenuItem
              key={lang}
              selected={lang === sourceLang}
              onSelect={() => save(lang, [...selected])}
            >
              {translationLanguageName(lang)}
            </MenuItem>
          ))}
        >
          <MenuTrigger variant="plain">
            {translationLanguageName(sourceLang)}
          </MenuTrigger>
        </Menu>
      </div>
      <div className={styles.languages}>
        {TRANSLATION_LANGUAGES.filter(lang => lang !== sourceLang).map(lang => {
          const row = rows.find(candidate => candidate.lang === lang);
          return (
            <div key={lang} className={styles.language}>
              <Checkbox
                checked={selected.has(lang)}
                label={translationLanguageName(lang)}
                onChange={(_event, checked) => toggle(lang, checked)}
                data-testid={`share-menu-translation-${lang}`}
              />
              {row ? <TranslationStatus row={row} /> : null}
            </div>
          );
        })}
      </div>
      <div className={styles.hint}>
        {t['com.affine.share-menu.translations.hint']()}
      </div>
    </div>
  );
};
