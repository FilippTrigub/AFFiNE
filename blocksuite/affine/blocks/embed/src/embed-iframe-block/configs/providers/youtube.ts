import { EmbedIframeConfigExtension } from '@blocksuite/affine-shared/services';

import {
  type EmbedIframeUrlValidationOptions,
  validateEmbedIframeUrl,
} from '../../utils';

const YOUTUBE_DEFAULT_WIDTH_IN_SURFACE = 800;
const YOUTUBE_DEFAULT_HEIGHT_IN_SURFACE = 450;
const YOUTUBE_DEFAULT_HEIGHT_IN_NOTE = 450;
const YOUTUBE_DEFAULT_WIDTH_PERCENT = 100;

const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube.com';

const youtubeValidationOptions: EmbedIframeUrlValidationOptions = {
  protocols: ['https:'],
  hostnames: [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be',
    'www.youtube-nocookie.com',
  ],
};

const youtubeIframeValidationOptions: EmbedIframeUrlValidationOptions = {
  protocols: ['https:'],
  hostnames: ['www.youtube.com', 'www.youtube-nocookie.com'],
};

const VIDEO_ID_REGEX = /^[\w-]{11}$/;
const VIDEO_PATH_REGEX = /^\/(?:embed|shorts|live|v)\/([\w-]{11})(?:[/?#]|$)/;

const extractVideoId = (url: string): string | undefined => {
  if (!validateEmbedIframeUrl(url, youtubeValidationOptions)) {
    return undefined;
  }
  const parsedUrl = new URL(url);

  let id: string | undefined;
  if (parsedUrl.hostname === 'youtu.be') {
    id = parsedUrl.pathname.slice(1).split('/')[0];
  } else if (parsedUrl.pathname === '/watch') {
    id = parsedUrl.searchParams.get('v') ?? undefined;
  } else {
    id = parsedUrl.pathname.match(VIDEO_PATH_REGEX)?.[1];
  }

  return id && VIDEO_ID_REGEX.test(id) ? id : undefined;
};

const extractStartSeconds = (url: string): string | undefined => {
  const t = new URL(url).searchParams.get('t');
  const match = t?.match(/^(\d+)s?$/);
  return match ? match[1] : undefined;
};

const buildYoutubeEmbedUrl = (url: string): string | undefined => {
  const id = extractVideoId(url);
  if (!id) {
    return undefined;
  }
  const embedUrl = new URL(`${YOUTUBE_EMBED_ORIGIN}/embed/${id}`);
  const start = extractStartSeconds(url);
  if (start) {
    embedUrl.searchParams.set('start', start);
  }
  return embedUrl.toString();
};

const isValidYoutubeEmbedUrl = (url: string): boolean => {
  if (!validateEmbedIframeUrl(url, youtubeIframeValidationOptions)) {
    return false;
  }
  return /^\/embed\/[\w-]{11}$/.test(new URL(url).pathname);
};

export const youtubeConfig = {
  name: 'youtube',
  match: (url: string) => !!extractVideoId(url),
  buildOEmbedUrl: buildYoutubeEmbedUrl,
  useOEmbedUrlDirectly: true,
  validateIframeUrl: isValidYoutubeEmbedUrl,
  options: {
    widthInSurface: YOUTUBE_DEFAULT_WIDTH_IN_SURFACE,
    heightInSurface: YOUTUBE_DEFAULT_HEIGHT_IN_SURFACE,
    heightInNote: YOUTUBE_DEFAULT_HEIGHT_IN_NOTE,
    widthPercent: YOUTUBE_DEFAULT_WIDTH_PERCENT,
    allow:
      'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
    sandbox: 'allow-scripts allow-same-origin allow-presentation',
    referrerpolicy: 'strict-origin-when-cross-origin',
    style: 'border: none; border-radius: 8px;',
    allowFullscreen: true,
  },
};

export const YoutubeEmbedConfig = EmbedIframeConfigExtension(youtubeConfig);
