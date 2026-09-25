// What the machine running this portal is doing.
//
// Super Admin only, and not because the numbers are dangerous — because they
// are infrastructure. The hostname, the processor model, the disk layout and
// the network interfaces together describe the server this runs on, and that
// is not a customer's business any more than the provider's name is.

import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/errors.js';
import { readSystemStats } from '../lib/systemStats.js';
import { getAppSettings } from '../services/notifier.js';
import { portalVersion } from '../lib/version.js';

export const systemRouter = Router();

systemRouter.use(requireAuth, requireAdmin);

systemRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    // Where to look for temperatures when this machine has no sensors of its
    // own, which under WSL and in a container is always.
    const { sensorUrl } = await getAppSettings();
    res.json({ stats: await readSystemStats({ sensorUrl }), portal: portalVersion() });
  }),
);
