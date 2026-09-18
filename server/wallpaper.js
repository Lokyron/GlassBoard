// Custom background image. Stored as a plain file in the data directory, with
// its type in the metadata table — it is user data, never part of the source.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './env.js';
import { getMeta, setMeta } from './db.js';

const FILE = path.join(DATA_DIR, 'wallpaper.bin');
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

export function hasWallpaper() {
  return fs.existsSync(FILE) && Boolean(getMeta('wallpaper.mime'));
}

export function wallpaperInfo() {
  if (!hasWallpaper()) return null;
  return {
    mime: getMeta('wallpaper.mime'),
    updatedAt: getMeta('wallpaper.updated_at'),
    bytes: fs.statSync(FILE).size,
  };
}

export function readWallpaper() {
  return hasWallpaper() ? fs.readFileSync(FILE) : null;
}

/** @returns {{mime: string, bytes: number}} @throws when the payload is not a supported image */
export function saveWallpaper(buffer) {
  if (!buffer?.length) throw new Error('The uploaded file is empty.');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`The image is too large (${Math.round(buffer.length / 1024)} KB, maximum ${MAX_BYTES / 1024 / 1024} MB).`);
  }
  const mime = sniffImageType(buffer);
  if (!mime) throw new Error('Unsupported image. Use a PNG, JPEG, WebP or GIF file.');

  fs.writeFileSync(FILE, buffer, { mode: 0o600 });
  setMeta('wallpaper.mime', mime);
  setMeta('wallpaper.updated_at', new Date().toISOString());
  return { mime, bytes: buffer.length };
}

export function deleteWallpaper() {
  if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  setMeta('wallpaper.mime', '');
  setMeta('wallpaper.updated_at', '');
}
