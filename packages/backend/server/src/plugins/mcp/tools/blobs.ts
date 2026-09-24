import { createHash } from 'node:crypto';

import z from 'zod/v3';

import type { McpToolContext } from './context';
import {
  errorMessage,
  type McpTool,
  mcpTool,
  toolError,
  toolJson,
} from './define';

/** Same cap the client applies to a single pasted image. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif)$/;

/**
 * Blob keys as the client computes them
 * (`blocksuite/framework/global/src/utils/crypto.ts`): SHA-256, standard base64
 * with padding kept, `+` -> `-` and `/` -> `_`.
 */
export function blobKeyOf(data: Buffer) {
  return createHash('sha256')
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function buildBlobTools(ctx: McpToolContext): McpTool[] {
  const { userId, workspaceId, deps } = ctx;

  const uploadImage = mcpTool('write', 'human', {
    name: 'upload_image',
    title: 'Upload Image',
    description:
      'Upload an image (base64, max 10 MB) to the workspace. Returns a blob key; embed it in create_document / update_document markdown as `![alt](blob://<key>)`. URLs are not fetched: pass the bytes.',
    parser: z.object({
      data_base64: z.string().min(1),
      mime_type: z.string().regex(IMAGE_MIME, 'Unsupported image type'),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        data_base64: { type: 'string', description: 'Image bytes, base64' },
        mime_type: {
          type: 'string',
          description:
            'image/png, image/jpeg, image/gif, image/webp, image/svg+xml, image/bmp or image/avif',
        },
      },
      required: ['data_base64', 'mime_type'],
      additionalProperties: false,
    },
    execute: async ({ data_base64, mime_type }) => {
      const data = Buffer.from(
        data_base64.replace(/^data:[^,]*,/, ''),
        'base64'
      );
      if (data.byteLength === 0) return toolError('Image data is empty.');
      if (data.byteLength > MAX_IMAGE_BYTES) {
        return toolError('Image is larger than 10 MB.');
      }
      try {
        await ctx.assertWorkspace('Workspace.Blobs.Upload');
        const key = blobKeyOf(data);
        const reservation = await deps.runtime.reserveStorageQuotaV1({
          workspaceId,
          userId,
          key,
          size: data.byteLength,
          mime: mime_type,
          kind: 'blob',
        });
        if (!reservation.allowed) {
          return toolError(
            reservation.reason === 'blob_limit'
              ? 'Image exceeds the workspace blob size limit.'
              : 'Workspace storage quota exceeded.'
          );
        }
        if (!reservation.alreadyUploaded) {
          if (!reservation.reservationId) {
            return toolError('Upload could not be reserved.');
          }
          const reservationId = reservation.reservationId;
          let metadata;
          try {
            metadata = await deps.blobs.putReservation(
              workspaceId,
              key,
              reservationId,
              data,
              { contentType: mime_type, contentLength: data.byteLength }
            );
          } catch (error) {
            await deps.runtime
              .abortStorageReservationV1({
                workspaceId,
                userId,
                key,
                reservationId,
                kind: 'blob',
              })
              .catch(() => undefined);
            throw error;
          }
          const finalized = await deps.runtime.finalizeStorageReservationV1({
            workspaceId,
            userId,
            key,
            reservationId,
            kind: 'blob',
            size: metadata.contentLength,
            mime: metadata.contentType,
          });
          if (!finalized) return toolError('Upload changed while finalizing.');
        }
        return toolJson({
          success: true,
          key,
          markdown: `![](blob://${key})`,
        });
      } catch (error) {
        return toolError(`Failed to upload image: ${errorMessage(error)}`);
      }
    },
  });

  return [uploadImage];
}
