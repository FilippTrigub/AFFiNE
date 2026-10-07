import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const container = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  marginLeft: '4px',
});

export const header = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: cssVar('fontSm'),
});

export const hint = style({
  fontSize: cssVar('fontXs'),
  color: cssVarV2('text/secondary'),
});

export const languages = style({
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  columnGap: '12px',
  rowGap: '2px',
});

export const language = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '4px',
  fontSize: cssVar('fontSm'),
});

export const checkbox = style({
  fontSize: '16px',
  gap: '6px',
});

export const checkboxLabel = style({
  fontSize: cssVar('fontSm'),
  cursor: 'pointer',
});

export const status = style({
  fontSize: cssVar('fontXs'),
  color: cssVarV2('text/secondary'),
  whiteSpace: 'nowrap',
  selectors: {
    '&[data-status="failed"]': { color: cssVarV2('status/error') },
    '&[data-out-of-date="true"]': { color: cssVarV2('status/error') },
  },
});
