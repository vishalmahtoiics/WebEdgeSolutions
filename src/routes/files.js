// File manager, backed by the FTP/FTPS/SFTP credentials stored for a domain.
//
// Mounted under /api/domains/:id/files, so the domain authorization that guards
// everything else guards these too: a user only ever reaches a domain assigned
// to them, and the credentials never leave this process.

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { decryptMaybe } from '../lib/crypto.js';
import {
  withStorage,
  resolvePath,
  toDisplayPath,
  StorageError,
  MAX_EDITABLE_BYTES,
} from '../lib/storage.js';

export const filesRouter = Router({ mergeParams: true });

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/// Loads the domain's stored credentials. The password is decrypted here and
/// nowhere else; it is never put on a response.
async function credentialsFor(domainId) {
  const settings = await prisma.domainSettings.findUnique({ where: { domainId } });
  if (!settings?.ftpHost || !settings?.ftpUsername) {
    throw badRequest('FTP is not set up for this domain yet. Add the details under FTP & Server.');
  }
  return {
    host: settings.ftpHost,
    port: settings.ftpPort,
    username: settings.ftpUsername,
    password: decryptMaybe(settings.ftpPassword),
    protocol: settings.ftpProtocol,
    // Everything is confined beneath this, so a path from the browser cannot
    // reach the rest of the server.
    root: settings.ftpRootPath || '/',
  };
}

/// Runs an operation against the domain's server, turning storage failures
/// into ordinary HTTP errors.
async function run(domainId, fn) {
  const credentials = await credentialsFor(domainId);
  try {
    return await withStorage(credentials, (storage) => fn(storage, credentials));
  } catch (err) {
    if (err instanceof StorageError) throw err;
    if (err?.status) throw err;
    throw new StorageError(err?.message || 'The file operation failed.', 502);
  }
}

const pathQuery = z.object({ path: z.string().max(4096).optional() });

/// Lists a directory. Directories first, then files, both alphabetical — the
/// order people expect from a file manager.
filesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = pathQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest('Invalid path.');

    const result = await run(req.domain.id, async (storage, credentials) => {
      const absolute = resolvePath(credentials.root, parsed.data.path || '/');
      const entries = await storage.list(absolute);
      return {
        path: toDisplayPath(credentials.root, absolute),
        entries: entries.sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
        ),
      };
    });

    res.json(result);
  }),
);

/// Downloads a file.
filesRouter.get(
  '/download',
  asyncHandler(async (req, res) => {
    const filePath = String(req.query.path || '');
    if (!filePath) throw badRequest('No file was given.');

    const { buffer, name } = await run(req.domain.id, async (storage, credentials) => {
      const absolute = resolvePath(credentials.root, filePath);
      return { buffer: await storage.read(absolute), name: absolute.split('/').pop() || 'download' };
    });

    // The filename comes from a remote server, so quote it and strip anything
    // that could break out of the header.
    const safeName = name.replace(/["\\\r\n]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);
  }),
);

/// Reads a small text file for the built-in editor.
filesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    const filePath = String(req.query.path || '');
    if (!filePath) throw badRequest('No file was given.');

    const result = await run(req.domain.id, async (storage, credentials) => {
      const absolute = resolvePath(credentials.root, filePath);
      const buffer = await storage.read(absolute);

      if (buffer.length > MAX_EDITABLE_BYTES) {
        throw new StorageError(
          `This file is too large to edit here (${Math.round(buffer.length / 1024)} KB). Download it instead.`,
          413,
        );
      }
      // A NUL byte in the first chunk is the usual sign of a binary file;
      // opening one in a textarea would corrupt it on save.
      if (buffer.subarray(0, 8000).includes(0)) {
        throw new StorageError('This looks like a binary file, so it cannot be edited as text.', 415);
      }

      return { path: toDisplayPath(credentials.root, absolute), content: buffer.toString('utf8') };
    });

    res.json(result);
  }),
);

const saveSchema = z.object({
  path: z.string().min(1, 'A file path is required.').max(4096),
  content: z.string().max(MAX_EDITABLE_BYTES, 'That file is too large to save from here.'),
});

filesRouter.put(
  '/content',
  validate(saveSchema),
  asyncHandler(async (req, res) => {
    await run(req.domain.id, async (storage, credentials) => {
      const absolute = resolvePath(credentials.root, req.body.path);
      await storage.write(absolute, Buffer.from(req.body.content, 'utf8'));
    });
    res.json({ ok: true, message: 'File saved.' });
  }),
);

filesRouter.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file was uploaded.');

    const directory = String(req.body.path || '/');
    const name = String(req.file.originalname || 'upload')
      // Only the final segment is kept, so an uploaded name cannot carry a path.
      .split(/[\\/]/)
      .pop();
    if (!name) throw badRequest('That file name is not usable.');

    const saved = await run(req.domain.id, async (storage, credentials) => {
      const absolute = resolvePath(credentials.root, `${directory}/${name}`);
      await storage.write(absolute, req.file.buffer);
      return toDisplayPath(credentials.root, absolute);
    });

    res.status(201).json({ ok: true, path: saved, message: `${name} uploaded.` });
  }),
);

const folderSchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().trim().min(1, 'A folder name is required.').max(255),
});

filesRouter.post(
  '/folder',
  validate(folderSchema),
  asyncHandler(async (req, res) => {
    const name = req.body.name.split(/[\\/]/).pop();
    if (!name || name === '.' || name === '..') throw badRequest('That folder name is not usable.');

    await run(req.domain.id, async (storage, credentials) => {
      const absolute = resolvePath(credentials.root, `${req.body.path}/${name}`);
      await storage.mkdir(absolute);
    });
    res.status(201).json({ ok: true, message: `Folder "${name}" created.` });
  }),
);

const renameSchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().trim().min(1, 'A new name is required.').max(255),
});

filesRouter.post(
  '/rename',
  validate(renameSchema),
  asyncHandler(async (req, res) => {
    const name = req.body.name.split(/[\\/]/).pop();
    if (!name || name === '.' || name === '..') throw badRequest('That name is not usable.');

    await run(req.domain.id, async (storage, credentials) => {
      const from = resolvePath(credentials.root, req.body.path);
      const parent = from.split('/').slice(0, -1).join('/') || '/';
      const to = resolvePath(credentials.root, `${toDisplayPath(credentials.root, parent)}/${name}`);
      await storage.rename(from, to);
    });
    res.json({ ok: true, message: `Renamed to "${name}".` });
  }),
);

const deleteSchema = z.object({
  path: z.string().min(1).max(4096),
  type: z.enum(['file', 'directory']),
});

filesRouter.post(
  '/delete',
  validate(deleteSchema),
  asyncHandler(async (req, res) => {
    await run(req.domain.id, async (storage, credentials) => {
      const absolute = resolvePath(credentials.root, req.body.path);

      // Deleting the root would wipe the whole site in one click.
      if (absolute === resolvePath(credentials.root, '/')) {
        throw new StorageError('The top-level folder cannot be deleted.', 400);
      }
      if (req.body.type === 'directory') await storage.removeDir(absolute);
      else await storage.removeFile(absolute);
    });
    res.json({ ok: true, message: 'Deleted.' });
  }),
);

/// Checks the stored credentials actually work, the same way the provider page
/// tests an API token.
filesRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    try {
      const count = await run(req.domain.id, async (storage, credentials) => {
        const entries = await storage.list(resolvePath(credentials.root, '/'));
        return entries.length;
      });
      res.json({ ok: true, message: `Connected. The top-level folder has ${count} item${count === 1 ? '' : 's'}.` });
    } catch (err) {
      res.status(err.status && err.status < 500 ? 400 : 502).json({ ok: false, message: err.message });
    }
  }),
);
