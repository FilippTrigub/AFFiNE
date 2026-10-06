import { Menu, MenuItem, MenuTrigger } from '@affine/component';
import { translationLanguageName as languageName } from '@affine/core/modules/share-doc';
import { useI18n } from '@affine/i18n';
import { LanguageIcon } from '@blocksuite/icons/rc';
import { useLocation, useNavigate } from 'react-router-dom';

import { getSearchWithLang, type SharedTranslations } from './share-page.utils';

/** Lets a reader of a public doc switch between its published translations. */
export function ShareLanguageSwitch({
  translations,
  activeLang,
}: {
  translations: SharedTranslations;
  activeLang: string | null;
}) {
  const t = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  if (!translations.languages.length) return null;

  const select = (lang: string | null) => {
    navigate({
      pathname: location.pathname,
      search: getSearchWithLang(location.search, lang),
    });
  };
  const { sourceLang } = translations;
  const originalLabel = sourceLang
    ? t['com.affine.share-page.header.language.original']({
        language: languageName(sourceLang),
      })
    : t['com.affine.share-page.header.language.original-unknown']();

  return (
    <Menu
      contentOptions={{ align: 'end' }}
      items={
        <>
          <MenuItem selected={!activeLang} onSelect={() => select(null)}>
            {originalLabel}
          </MenuItem>
          {translations.languages.map(lang => (
            <MenuItem
              key={lang}
              selected={activeLang === lang}
              onSelect={() => select(lang)}
            >
              {languageName(lang)}
            </MenuItem>
          ))}
        </>
      }
    >
      <MenuTrigger
        variant="plain"
        prefix={<LanguageIcon />}
        aria-label={t['com.affine.share-page.header.language']()}
        data-testid="share-page-language-switch"
      >
        {activeLang
          ? languageName(activeLang)
          : sourceLang
            ? languageName(sourceLang)
            : t['com.affine.share-page.header.language.original-unknown']()}
      </MenuTrigger>
    </Menu>
  );
}
