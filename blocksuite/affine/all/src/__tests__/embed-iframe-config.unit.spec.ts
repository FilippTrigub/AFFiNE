import { describe, expect, test } from 'vitest';

import { bilibiliConfig } from '../../../blocks/embed/src/embed-iframe-block/configs/providers/bilibili.js';
import { excalidrawConfig } from '../../../blocks/embed/src/embed-iframe-block/configs/providers/excalidraw.js';
import { genericConfig } from '../../../blocks/embed/src/embed-iframe-block/configs/providers/generic.js';
import { googleDocsConfig } from '../../../blocks/embed/src/embed-iframe-block/configs/providers/google-docs.js';
import { googleDriveConfig } from '../../../blocks/embed/src/embed-iframe-block/configs/providers/google-drive.js';
import { miroConfig } from '../../../blocks/embed/src/embed-iframe-block/configs/providers/miro.js';
import { spotifyConfig } from '../../../blocks/embed/src/embed-iframe-block/configs/providers/spotify.js';
import { youtubeConfig } from '../../../blocks/embed/src/embed-iframe-block/configs/providers/youtube.js';

describe('embed iframe provider config', () => {
  test('validates final iframe URLs from oEmbed providers', () => {
    expect(
      spotifyConfig.validateIframeUrl?.(
        'https://open.spotify.com/embed/track/0TK2YIli7K1leLovkQiNik'
      )
    ).toBe(true);
    expect(
      spotifyConfig.validateIframeUrl?.(
        'https://example.com/embed/track/0TK2YIli7K1leLovkQiNik'
      )
    ).toBe(false);
  });

  test('validates provider-specific iframe URL shapes', () => {
    expect(
      googleDriveConfig.validateIframeUrl?.(
        'https://drive.google.com/file/d/file-id/preview?usp=embed_googleplus'
      )
    ).toBe(true);
    expect(
      googleDriveConfig.validateIframeUrl?.(
        'https://drive.google.com/drive/folders/folder-id?usp=sharing'
      )
    ).toBe(false);

    expect(
      bilibiliConfig.validateIframeUrl?.(
        'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0'
      )
    ).toBe(true);
    expect(
      bilibiliConfig.match(
        'https://player.bilibili.com/player.html?aid=123&autoplay=0'
      )
    ).toBe(true);
    expect(
      bilibiliConfig.buildOEmbedUrl(
        'https://player.bilibili.com/video/BV1xx411c7mD'
      )
    ).toBe(
      'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0'
    );
    expect(
      bilibiliConfig.validateIframeUrl?.(
        'https://www.bilibili.com/video/BV1xx411c7mD'
      )
    ).toBe(false);

    expect(
      googleDocsConfig.validateIframeUrl?.(
        'https://docs.google.com/document/d/doc-id/edit?usp=sharing'
      )
    ).toBe(true);
    expect(
      miroConfig.validateIframeUrl?.(
        'https://miro.com/app/live-embed/board-id/'
      )
    ).toBe(true);
    expect(
      excalidrawConfig.validateIframeUrl?.('https://excalidraw.com/#room-id')
    ).toBe(true);
  });

  test('youtube rewrites page URLs to the frameable embed URL', () => {
    const embed = 'https://www.youtube.com/embed/dQw4w9WgXcQ';
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(youtubeConfig.match(url)).toBe(true);
      expect(youtubeConfig.buildOEmbedUrl(url)).toBe(embed);
    }
    expect(
      youtubeConfig.buildOEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=90')
    ).toBe(`${embed}?start=90`);
  });

  test('youtube does not match non-video URLs and validates embed shape', () => {
    for (const url of [
      'https://www.youtube.com/',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/@channel',
      'https://www.youtube.com/watch?v=short',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(youtubeConfig.match(url)).toBe(false);
    }
    expect(
      youtubeConfig.validateIframeUrl?.(
        'https://www.youtube.com/embed/dQw4w9WgXcQ'
      )
    ).toBe(true);
    expect(
      youtubeConfig.validateIframeUrl?.(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      )
    ).toBe(false);
  });

  test('generic iframe validation excludes affine and non-https URLs', () => {
    expect(genericConfig.validateIframeUrl?.('https://example.com/embed')).toBe(
      true
    );
    expect(genericConfig.validateIframeUrl?.('http://example.com/embed')).toBe(
      false
    );
    expect(
      genericConfig.validateIframeUrl?.('https://app.affine.pro/embed')
    ).toBe(false);
    expect(genericConfig.validateIframeUrl?.('https://127.0.0.1/embed')).toBe(
      false
    );
    expect(genericConfig.validateIframeUrl?.('https://localhost/embed')).toBe(
      false
    );
  });
});
