// Background image upload, download and removal.
import express from 'express';
import { requireAuth } from '../auth.js';
import fs from 'node:fs';
import { saveWallpaper, wallpaperFile, deleteWallpaper, wallpaperInfo, MAX_BYTES } from '../wallpaper.js';

export const appearanceRouter = express.Router();
appearanceRouter.use(requireAuth);

appearanceRouter.get('/wallpaper', (req, res) => {
  const info = wallpaperInfo(req.user.id);
  if (!info) return res.status(404).json({ error: 'No wallpaper set.' });
  res.setHeader('Content-Type', info.mime);
  res.setHeader('Content-Length', String(info.bytes));
  // The client asks with ?v=<updatedAt>, so the answer can be cached hard.
  res.setHeader('Cache-Control', 'private, max-age=604800');
  // Streamed rather than buffered: the image is never held in memory whole.
  fs.createReadStream(wallpaperFile(req.user.id)).on('error', () => res.status(500).end()).pipe(res);
});

appearanceRouter.get('/wallpaper/info', (req, res) => {
  res.json({ ok: true, wallpaper: wallpaperInfo(req.user.id) });
});

appearanceRouter.put(
  '/wallpaper',
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_BYTES }),
  (req, res) => {
    try {
      const saved = saveWallpaper(req.user.id, req.body);
      res.json({ ok: true, ...saved, updatedAt: wallpaperInfo(req.user.id).updatedAt });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

appearanceRouter.delete('/wallpaper', (req, res) => {
  deleteWallpaper(req.user.id);
  res.json({ ok: true });
});
