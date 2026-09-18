// Background image upload, download and removal.
import express from 'express';
import { requireAuth } from '../auth.js';
import { saveWallpaper, readWallpaper, deleteWallpaper, wallpaperInfo, MAX_BYTES } from '../wallpaper.js';

export const appearanceRouter = express.Router();
appearanceRouter.use(requireAuth);

appearanceRouter.get('/wallpaper', (_req, res) => {
  const info = wallpaperInfo();
  const image = readWallpaper();
  if (!info || !image) return res.status(404).json({ error: 'No wallpaper set.' });
  res.setHeader('Content-Type', info.mime);
  // The client asks with ?v=<updatedAt>, so the answer can be cached hard.
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.send(image);
});

appearanceRouter.get('/wallpaper/info', (_req, res) => {
  res.json({ ok: true, wallpaper: wallpaperInfo() });
});

appearanceRouter.put(
  '/wallpaper',
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_BYTES }),
  (req, res) => {
    try {
      const saved = saveWallpaper(req.body);
      res.json({ ok: true, ...saved, updatedAt: wallpaperInfo().updatedAt });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

appearanceRouter.delete('/wallpaper', (_req, res) => {
  deleteWallpaper();
  res.json({ ok: true });
});
