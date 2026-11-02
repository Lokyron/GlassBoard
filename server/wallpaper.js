// Custom background image. Stored as a plain file in the data directory, with
// its type in the metadata table — it is user data, never part of the source.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './env.js';
import { getMeta, setMeta } from './db.js';

/* One image per account, named after it, with its type in the metadata table
   under the same key. An account that has never uploaded one simply has no
   file, which is what hasWallpaper reports. */
const fileFor = (userId) => path.join(DATA_DIR, `wallpaper-${Number(userId)}.bin`);
const metaKey = (userId, field) => `wallpaper.${Number(userId)}.${field}`;
export const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Identify an image from its magic bytes rather than trusting the declared
 * content type, so a renamed file cannot be served back as something else.
 */
export function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  const gif = buffer.subarray(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  return null;
}

export function hasWallpaper(userId) {
  return fs.existsSync(fileFor(userId)) && Boolean(getMeta(metaKey(userId, 'mime')));
}

export function wallpaperInfo(userId) {
  if (!hasWallpaper(userId)) return null;
  return {
    mime: getMeta(metaKey(userId, 'mime')),
    updatedAt: getMeta(metaKey(userId, 'updated_at')),
    bytes: fs.statSync(fileFor(userId)).size,
  };
}

export const wallpaperFile = (userId) => fileFor(userId);

export function readWallpaper(userId) {
  return hasWallpaper(userId) ? fs.readFileSync(fileFor(userId)) : null;
}

/** @returns {{mime: string, bytes: number}} @throws when the payload is not a supported image */
export function saveWallpaper(userId, buffer) {
  if (!buffer?.length) throw new Error('The uploaded file is empty.');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`The image is too large (${Math.round(buffer.length / 1024)} KB, maximum ${MAX_BYTES / 1024 / 1024} MB).`);
  }
  const mime = sniffImageType(buffer);
  if (!mime) throw new Error('Unsupported image. Use a PNG, JPEG, WebP or GIF file.');

  fs.writeFileSync(fileFor(userId), buffer, { mode: 0o600 });
  setMeta(metaKey(userId, 'mime'), mime);
  setMeta(metaKey(userId, 'updated_at'), new Date().toISOString());
  return { mime, bytes: buffer.length };
}

export function deleteWallpaper(userId) {
  const file = fileFor(userId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  setMeta(metaKey(userId, 'mime'), '');
  setMeta(metaKey(userId, 'updated_at'), '');
}
