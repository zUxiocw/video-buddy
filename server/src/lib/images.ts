import { ApiError } from './errors.js';
import type { ImagePayload } from '../types.js';

export const MAX_IMAGE_BYTES = 400 * 1024;
export const MAX_IMAGES = 2;

export interface ValidatedImage extends ImagePayload {
  bytes: number;
}

/**
 * Validate declared MIME, strict base64, decoded size and magic bytes.
 * Images are kept in memory only and never written to disk.
 */
export function validateImages(images: readonly ImagePayload[]): ValidatedImage[] {
  if (images.length > MAX_IMAGES) {
    throw new ApiError(422, 'TOO_MANY_IMAGES', `最多上传 ${MAX_IMAGES} 张图片`);
  }
  return images.map((image, index) => {
    const data = image.data?.trim() ?? '';
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new ApiError(422, 'INVALID_IMAGE', `第 ${index + 1} 张图片不是合法 base64`);
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) {
      throw new ApiError(422, 'INVALID_IMAGE', `第 ${index + 1} 张图片为空`);
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new ApiError(413, 'IMAGE_TOO_LARGE', `第 ${index + 1} 张图片超过 400KiB`);
    }
    const detected = detectMime(buffer);
    if (!detected || detected !== image.mime) {
      throw new ApiError(422, 'IMAGE_MIME_MISMATCH', `第 ${index + 1} 张图片格式与 Content-Type 不一致`);
    }
    return { mime: detected, data, bytes: buffer.length };
  });
}

function detectMime(buffer: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}
