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
import { isAdmin } from '../middleware/auth.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { decryptMaybe } from '../lib/crypto.js';
import { record } from '../services/notifier.js';
import { readZip, LIMITS as UNZIP_LIMITS } from '../lib/archive.js';
import { buildZip, ZIP_LIMITS, ZipLimitError } from '../lib/zipWriter.js';
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

/// A single file or folder name from the browser: one segment, never a path.
/// Everything built from one still goes through `resolvePath`; this is so a
/// name that is really a path is refused rather than quietly shortened.
function singleName(raw, what = 'name') {
  const name = String(raw ?? '').trim();
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw badRequest(`That ${what} is not usable: "${String(raw ?? '')}".`);
  }
  return name;
}

/// Joins a display path and a name, for `resolvePath`.
const join = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;

/// The entries of a folder by name, or null when the folder is not there.
async function listingOf(storage, absolute) {
  try {
    return new Map((await storage.list(absolute)).map((e) => [e.name, e]));
  } catch {
    return null;
  }
}

/// Attachment headers for a name that came off a remote server or out of
/// a selection: an ASCII fallback, and the real name for browsers that read
/// RFC 5987, so "नमस्ते.zip" downloads as itself.
function attachment(res, name, type) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  res.setHeader('Content-Type', type);
}

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

    // The filename comes from a remote server, so it is quoted and anything
    // that could break out of the header is replaced.
    attachment(res, name, 'application/octet-stream');
    res.send(buffer);
  }),
);

/// Largest file the editor will save. Larger than it will open, so a file
/// that was just under the limit can still grow a little while being edited.
const MAX_SAVE_BYTES = 1024 * 1024;

/// Reads a small text file for the built-in editor.
///
/// Two things are worked out here so that saving puts back what was there:
///
///   The encoding. Most files are UTF-8, but an old site can have Latin-1
///   files, and decoding one of those as UTF-8 turns every "é" into "�" — and
///   saving writes the "�" back. So UTF-8 is tried strictly, and a file that
///   is not valid UTF-8 is read as Latin-1 and saved as Latin-1.
///
///   Line endings. A textarea turns every CRLF into LF, so a Windows file
///   would be quietly converted on its first save — every line of it changed
///   as far as git or a diff is concerned. The file's own ending is reported
///   and put back on save.
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

      let content;
      let encoding = 'utf8';
      try {
        // ignoreBOM keeps a byte-order mark in the text, so it is written
        // back rather than silently dropped.
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
      } catch {
        content = buffer.toString('latin1');
        encoding = 'latin1';
      }

      const crlf = (content.match(/\r\n/g) || []).length;
      const lf = (content.match(/\n/g) || []).length - crlf;

      return {
        path: toDisplayPath(credentials.root, absolute),
        content,
        size: buffer.length,
        encoding,
        eol: crlf > lf ? 'crlf' : 'lf',
      };
    });

    res.json(result);
  }),
);

const saveSchema = z.object({
  path: z.string().min(1, 'A file path is required.').max(4096),
  content: z.string().max(MAX_SAVE_BYTES, 'That file is too large to save from here.'),
  encoding: z.enum(['utf8', 'latin1']).default('utf8'),
  eol: z.enum(['lf', 'crlf']).default('lf'),
});

filesRouter.put(
  '/content',
  validate(saveSchema),
  asyncHandler(async (req, res) => {
    const { encoding, eol } = req.body;
    let content = req.body.content;
    if (eol === 'crlf') content = content.replace(/\r?\n/g, '\r\n');

    // Latin-1 holds 256 characters. Anything past that would be written as
    // a different character without a word, so it is refused by name.
    if (encoding === 'latin1') {
      const outside = content.match(/[^\u0000-ÿ]/);
      if (outside) {
        throw badRequest(
          `This file is saved in an older encoding (Latin-1) that has no "${outside[0]}". ` +
            'Remove that character, or download the file and convert it to UTF-8.',
        );
      }
    }

    const buffer = Buffer.from(content, encoding);
    if (buffer.length > MAX_SAVE_BYTES) {
      throw badRequest(`That file is too large to save from here (${Math.round(buffer.length / 1024)} KB).`);
    }

    const saved = await run(req.domain.id, async (storage, credentials) => {
      const absolute = resolvePath(credentials.root, req.body.path);
      await storage.write(absolute, buffer);

      // Checked rather than assumed. A server that accepts the upload and
      // then keeps an old copy, or a truncated one, would otherwise look
      // exactly like a successful save — and an edit that "does nothing" is
      // far harder to track down than one that says it failed.
      const parent = absolute.split('/').slice(0, -1).join('/') || '/';
      const entry = (await listingOf(storage, parent))?.get(absolute.split('/').pop());
      if (!entry) {
        throw new StorageError('The server accepted the save, but the file is not there afterwards.', 502);
      }
      if (typeof entry.size === 'number' && entry.size !== buffer.length) {
        throw new StorageError(
          `The server accepted the save, but the file there is ${entry.size} bytes rather than ${buffer.length}. ` +
            'It may not have been written completely — check the file before relying on it.',
          502,
        );
      }
      return toDisplayPath(credentials.root, absolute);
    });

    res.json({ ok: true, path: saved, size: buffer.length, message: 'File saved.' });
  }),
);

const newFileSchema = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().trim().min(1, 'A file name is required.').max(255),
});

/// Creates an empty file, refusing to replace one that is already there.
filesRouter.post(
  '/file',
  validate(newFileSchema),
  asyncHandler(async (req, res) => {
    const name = singleName(req.body.name, 'file name');

    const created = await run(req.domain.id, async (storage, credentials) => {
      const folder = resolvePath(credentials.root, req.body.path);
      const listing = await listingOf(storage, folder);
      if (!listing) throw new StorageError('That folder is not there any more. Refresh and try again.', 404);
      if (listing.has(name)) throw new StorageError(`"${name}" already exists in this folder.`, 409);

      const absolute = resolvePath(credentials.root, join(req.body.path, name));
      await storage.write(absolute, Buffer.alloc(0));
      return toDisplayPath(credentials.root, absolute);
    });

    res.status(201).json({ ok: true, path: created, message: `Created ${name}.` });
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

    await record({
      event: 'files.deleted',
      actor: req.user,
      domain: req.domain,
      summary: `Deleted ${req.body.type === 'directory' ? 'the folder' : 'the file'} ${req.body.path}`,
      detail:
        req.body.type === 'directory'
          ? 'A folder was removed from the site, with everything inside it.'
          : null,
    });

    res.json({ ok: true, message: 'Deleted.' });
  }),
);

// ---------------------------------------------------------------------------
// Selections: several items from one folder at once
// ---------------------------------------------------------------------------

/// How many items one request may name. The browser sends a whole folder's
/// worth at most; this is a ceiling on one request, not on a folder.
const MAX_SELECTION = 1000;

const selectionSchema = z.object({
  path: z.string().min(1).max(4096),
  names: z.array(z.string().min(1).max(255)).min(1, 'Select at least one item.').max(MAX_SELECTION),
});

const deleteManySchema = z.object({
  path: z.string().min(1).max(4096),
  items: z
    .array(z.object({ name: z.string().min(1).max(255), type: z.enum(['file', 'directory']) }))
    .min(1, 'Select at least one item.')
    .max(MAX_SELECTION),
});

/// Deletes several items from one folder.
///
/// Each one is tried on its own, so one that the server refuses does not
/// leave the rest undone — and the answer says exactly which failed and why,
/// rather than a single error that hides how much was actually removed.
filesRouter.post(
  '/delete-many',
  validate(deleteManySchema),
  asyncHandler(async (req, res) => {
    const items = req.body.items.map((i) => ({ name: singleName(i.name), type: i.type }));

    const outcome = await run(req.domain.id, async (storage, credentials) => {
      const root = resolvePath(credentials.root, '/');
      const deleted = [];
      const failed = [];
      for (const item of items) {
        const absolute = resolvePath(credentials.root, join(req.body.path, item.name));
        if (absolute === root) {
          failed.push({ name: item.name, error: 'The top-level folder cannot be deleted.' });
          continue;
        }
        try {
          if (item.type === 'directory') await storage.removeDir(absolute);
          else await storage.removeFile(absolute);
          deleted.push(item);
        } catch (err) {
          failed.push({ name: item.name, error: err?.message || 'The server refused.' });
        }
      }
      return { deleted, failed };
    });

    const { deleted, failed } = outcome;
    if (deleted.length) {
      const shown = deleted.slice(0, 25).map((i) => `${join(req.body.path, i.name)}${i.type === 'directory' ? '/' : ''}`);
      await record({
        event: 'files.deleted',
        actor: req.user,
        domain: req.domain,
        summary: `Deleted ${deleted.length} item${deleted.length === 1 ? '' : 's'} from ${req.body.path}`,
        detail:
          shown.join('\n') + (deleted.length > shown.length ? `\n…and ${deleted.length - shown.length} more.` : ''),
      });
    }

    const message = failed.length
      ? `Deleted ${deleted.length} of ${items.length}. Could not delete ${failed.map((f) => f.name).join(', ')}.`
      : `Deleted ${deleted.length} item${deleted.length === 1 ? '' : 's'}.`;
    // Answered 200 either way with the detail inside, since the request did
    // what it could and the browser needs the list to show what is left.
    res.json({ ok: failed.length === 0, deleted: deleted.length, failed, message, error: failed.length ? message : null });
  }),
);

/// Deepest a folder is followed when zipping. Deeper than any real site, and
/// a stop on a server that reports a folder inside itself.
const MAX_ZIP_DEPTH = 32;

/// Reads the selected items, folders recursively, into zip entries.
///
/// Sizes from the listing are added up before anything is downloaded, so a
/// selection that is too large is refused up front rather than after pulling
/// most of it across. The zip writer checks the real total again.
async function collectForZip(storage, credentials, folder, names) {
  const listing = await listingOf(storage, resolvePath(credentials.root, folder));
  if (!listing) throw new StorageError('That folder is not there any more. Refresh and try again.', 404);

  const entries = [];
  let bytes = 0;

  const add = (entry) => {
    if (entries.length >= ZIP_LIMITS.entries) {
      throw new ZipLimitError(`That is more than ${ZIP_LIMITS.entries} files to put in one zip. Select less at a time.`);
    }
    entries.push(entry);
  };

  async function walk(display, relative, entry, depth) {
    const absolute = resolvePath(credentials.root, display);
    const modifiedAt = entry.modifiedAt ? new Date(entry.modifiedAt) : undefined;

    if (entry.type === 'directory') {
      if (depth > MAX_ZIP_DEPTH) throw new ZipLimitError(`${display} nests too deeply to zip.`);
      add({ path: relative, directory: true, modifiedAt });
      for (const child of await storage.list(absolute)) {
        if (child.name === '.' || child.name === '..' || /[\\/]/.test(child.name)) continue;
        await walk(join(display, child.name), `${relative}/${child.name}`, child, depth + 1);
      }
      return;
    }

    if (typeof entry.size === 'number') {
      bytes += entry.size;
      if (bytes > ZIP_LIMITS.totalBytes) {
        throw new ZipLimitError(
          `That is more than ${ZIP_LIMITS.totalBytes / 1024 / 1024} MB to put in one zip. Select less at a time.`,
        );
      }
    }
    let contents;
    try {
      contents = await storage.read(absolute);
    } catch (err) {
      throw new StorageError(`Could not read ${display}: ${err?.message || 'the server refused.'}`, 502);
    }
    add({ path: relative, contents, modifiedAt });
  }

  for (const raw of names) {
    const name = singleName(raw);
    const entry = listing.get(name);
    if (!entry) throw new StorageError(`"${name}" is not in this folder any more. Refresh and try again.`, 404);
    await walk(join(folder, name), name, entry, 0);
  }
  return entries;
}

/// What a zip of these names is called by default: the item itself when
/// there is one, the folder they came from when there are several — and the
/// site's own name at the top, where the folder has no name of its own.
function zipNameFor(folder, names, siteName) {
  if (names.length === 1) return `${names[0]}.zip`;
  const base = folder.split('/').filter(Boolean).pop();
  return `${base || siteName || 'files'}.zip`;
}

/// Downloads the selected items as one zip, built on the fly.
filesRouter.post(
  '/zip-download',
  validate(selectionSchema),
  asyncHandler(async (req, res) => {
    const zip = await run(req.domain.id, async (storage, credentials) =>
      buildZip(await collectForZip(storage, credentials, req.body.path, req.body.names)),
    );
    attachment(res, zipNameFor(req.body.path, req.body.names, req.domain.name), 'application/zip');
    res.send(zip);
  }),
);

const compressSchema = selectionSchema.extend({
  name: z.string().trim().max(255).optional(),
});

/// Zips the selected items into a new .zip in the same folder.
///
/// A name that is taken gets a number rather than replacing what is there —
/// overwriting a file somebody has not chosen to overwrite is the one outcome
/// here that cannot be undone.
filesRouter.post(
  '/compress',
  validate(compressSchema),
  asyncHandler(async (req, res) => {
    let name = req.body.name ? singleName(req.body.name, 'zip name') : zipNameFor(req.body.path, req.body.names, req.domain.name);
    if (!/\.zip$/i.test(name)) name += '.zip';

    const created = await run(req.domain.id, async (storage, credentials) => {
      const zip = await buildZip(await collectForZip(storage, credentials, req.body.path, req.body.names));

      const listing = (await listingOf(storage, resolvePath(credentials.root, req.body.path))) || new Map();
      const stem = name.replace(/\.zip$/i, '');
      for (let n = 2; listing.has(name); n += 1) {
        if (n > 999) throw new StorageError('Choose a different name for the zip.', 409);
        name = `${stem}-${n}.zip`;
      }

      const absolute = resolvePath(credentials.root, join(req.body.path, name));
      await storage.write(absolute, zip);
      return { path: toDisplayPath(credentials.root, absolute), size: zip.length };
    });

    res.status(201).json({
      ok: true,
      name,
      path: created.path,
      size: created.size,
      message: `Created ${name} (${Math.max(1, Math.round(created.size / 1024))} KB).`,
    });
  }),
);

const extractSchema = z.object({
  path: z.string().min(1).max(4096),
  // "folder" unpacks into a new folder named after the zip, which cannot
  // collide with anything; "here" unpacks beside it, the way a desktop does.
  into: z.enum(['folder', 'here']).default('folder'),
  overwrite: z.boolean().default(false),
});

/// Unpacks a .zip that is already on the server.
///
/// The archive goes through the same reader as a deploy, so a zip that tries
/// to write outside its folder, holds a symlink, or unpacks to far more than
/// it weighs is refused before a single file is written. The deploy's list
/// of names to leave out is not applied: this is the owner unpacking their
/// own files, and a .htaccess or a .git that silently went missing would be
/// its own kind of wrong.
///
/// Existing files are left alone unless `overwrite` is set, and the answer
/// names what was skipped.
filesRouter.post(
  '/extract',
  validate(extractSchema),
  asyncHandler(async (req, res) => {
    const { into, overwrite } = req.body;

    const outcome = await run(req.domain.id, async (storage, credentials) => {
      const zipPath = resolvePath(credentials.root, req.body.path);
      const zipName = zipPath.split('/').pop();
      if (!/\.zip$/i.test(zipName)) throw badRequest('Only .zip files can be extracted here.');

      const parentAbs = zipPath.split('/').slice(0, -1).join('/') || '/';
      const parent = toDisplayPath(credentials.root, parentAbs);
      const siblings = await listingOf(storage, parentAbs);
      const zipEntry = siblings?.get(zipName);
      if (!zipEntry) throw new StorageError(`${zipName} is not there any more. Refresh and try again.`, 404);
      if (typeof zipEntry.size === 'number' && zipEntry.size > UNZIP_LIMITS.totalBytes) {
        throw new StorageError(`${zipName} is too large to extract here. Extract it on your computer and upload the files.`, 413);
      }

      const archive = await readZip(await storage.read(zipPath), { defaultExclusions: false });

      const target = into === 'folder' ? join(parent, zipName.replace(/\.zip$/i, '') || 'extracted') : parent;
      const targetAbs = resolvePath(credentials.root, target);

      // Folder listings, fetched once each and only when needed. A folder
      // made during this extraction is known to be empty.
      const known = new Map([[parentAbs, siblings]]);
      const listing = async (abs) => {
        if (!known.has(abs)) known.set(abs, await listingOf(storage, abs));
        return known.get(abs);
      };
      const ensureDir = async (abs) => {
        if (abs === targetAbs && into === 'here') return;
        const existing = await listing(abs);
        if (existing) return;
        await storage.mkdir(abs);
        known.set(abs, new Map());
      };

      await ensureDir(targetAbs);

      // Every folder the archive names or implies, shallowest first, so each
      // one's parent is there before it is.
      const folders = new Set(archive.directories);
      for (const file of archive.files) {
        const parts = file.path.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i += 1) folders.add(parts.slice(0, i).join('/'));
      }
      const failed = [];
      for (const folder of [...folders].sort((a, b) => a.split('/').length - b.split('/').length)) {
        const abs = resolvePath(credentials.root, join(target, folder));
        try {
          await ensureDir(abs);
        } catch (err) {
          failed.push({ name: `${folder}/`, error: err?.message || 'Could not create the folder.' });
        }
      }

      let written = 0;
      const skipped = [];
      for (const file of archive.files) {
        const abs = resolvePath(credentials.root, join(target, file.path));
        const dirAbs = abs.split('/').slice(0, -1).join('/') || '/';
        const name = abs.split('/').pop();
        const here = await listing(dirAbs);
        if (here?.get(name)?.type === 'directory') {
          failed.push({ name: file.path, error: 'A folder with that name is already there.' });
          continue;
        }
        if (here?.has(name) && !overwrite) {
          skipped.push(file.path);
          continue;
        }
        try {
          await storage.write(abs, file.contents);
          written += 1;
        } catch (err) {
          failed.push({ name: file.path, error: err?.message || 'The server refused.' });
        }
      }

      return { zipName, target, written, skipped, failed, total: archive.files.length };
    });

    const { zipName, target, written, skipped, failed, total } = outcome;
    await record({
      event: 'files.extracted',
      actor: req.user,
      domain: req.domain,
      summary: `Extracted ${zipName} into ${target}`,
      detail:
        `${written} of ${total} file${total === 1 ? '' : 's'} written.` +
        (skipped.length ? ` ${skipped.length} left as they were because they already existed.` : '') +
        (failed.length ? ` ${failed.length} failed.` : ''),
    });

    const parts = [`Extracted ${written} file${written === 1 ? '' : 's'} into ${target}.`];
    if (skipped.length) parts.push(`${skipped.length} already existed and were left as they were.`);
    if (failed.length) parts.push(`${failed.length} could not be written.`);
    const message = parts.join(' ');

    res.json({
      ok: failed.length === 0,
      target,
      written,
      total,
      skipped: skipped.slice(0, 50),
      skippedCount: skipped.length,
      failed: failed.slice(0, 50),
      message,
      error: failed.length ? message : null,
    });
  }),
);

/// Folders a hosting account keeps the website in. Seeing one of these at the
/// top level means the root folder is set to the account rather than the site.
const WEB_ROOTS = ['public_html', 'htdocs', 'www', 'httpdocs'];

/// Checks the stored credentials actually work, and says what happened.
///
/// Two things are checked, because they fail for different reasons and need
/// different fixes: whether the credentials open a connection at all, and
/// whether the folder the file manager is confined to can be read. A correct
/// password pointed at a folder that does not exist fails later and reads
/// exactly like a login problem.
///
/// Answers 200 whichever way it goes. The request was well formed and the
/// server did what was asked — it tried the credentials and is reporting what
/// happened. This used to answer 400 or 502 with `ok` and `message` and no
/// `error`, which is the one shape the browser's API helper cannot render:
/// it falls back to "Request failed (400)" and throws the real reason away.
///
/// `password` tries one that has not been saved yet. Super Admin only, that
/// part: it turns this into an oracle for whether a given password opens
/// somebody's file server, which is not something to leave open.
filesRouter.post(
  '/test',
  validate(z.object({ password: z.string().max(255).optional() })),
  asyncHandler(async (req, res) => {
    const typed = String(req.body.password || '');
    if (typed && !isAdmin(req.user)) {
      throw badRequest('Only a Super Admin can try a password that has not been saved.');
    }

    const settings = await prisma.domainSettings.findUnique({ where: { domainId: req.domain.id } });

    // Said plainly rather than as a connection failure: there is a difference
    // between details that do not work and details that were never entered.
    const missing = [];
    if (!settings?.ftpHost) missing.push('host');
    if (!settings?.ftpUsername) missing.push('username');
    const password = typed || decryptMaybe(settings?.ftpPassword);
    if (!password) missing.push('password');

    if (missing.length) {
      const message = `Nothing to test yet — no ${missing.join(', no ')} is saved for this domain.`;
      return res.json({ ok: false, message, error: message, checks: { connect: null, list: null } });
    }

    const protocol = (settings.ftpProtocol || 'FTP').toUpperCase();
    const root = settings.ftpRootPath || '/';
    const checks = { connect: null, list: null };

    try {
      const entries = await withStorage(
        {
          host: settings.ftpHost,
          port: settings.ftpPort,
          username: settings.ftpUsername,
          password,
          protocol,
          root,
        },
        (storage) => storage.list(resolvePath(root, '/')),
      );

      checks.connect = { ok: true, message: `Signed in over ${protocol}.` };
      checks.list = {
        ok: true,
        message: `Read ${root} — ${entries.length} item${entries.length === 1 ? '' : 's'}.`,
      };

      // Pointed at the account rather than the site, the file manager works
      // perfectly and shows the wrong folder — which is worth catching here
      // rather than leaving somebody to wonder why their edits do nothing.
      const names = entries.map((e) => e.name);
      const webRoot = names.find((n) => WEB_ROOTS.includes(n));
      if (webRoot && !names.some((n) => n === 'index.php' || n === 'index.html')) {
        checks.list.message +=
          ` This looks like the account root rather than the site itself — the website is probably under ` +
          `${root.replace(/\/+$/, '')}/${webRoot}.`;
      }
    } catch (err) {
      const message = err?.message || 'The connection failed.';
      // Signed in but could not read the folder is a different fix from
      // could not sign in, and the second is easy to mistake for the first.
      const folderProblem = /no such file|not found|550|ENOENT/i.test(message) && !/could not be found/i.test(message);

      checks.connect = folderProblem
        ? { ok: true, message: `Signed in over ${protocol}.` }
        : { ok: false, message };
      // A full server path is what hosting panels show next to an FTP
      // account, and it is the wrong thing to put here: an account made for
      // one site is already locked inside that folder, so from its point of
      // view the path does not exist.
      const fullPathHint = /^\/home\//.test(root)
        ? ' That looks like the full path on the server. An FTP account made for one site already starts ' +
          'inside its folder, so try leaving Root folder blank.'
        : '';
      checks.list = folderProblem
        ? { ok: false, message: `Signed in, but could not read ${root}. ${message}${fullPathHint}` }
        : { ok: false, message: 'Not tried — the connection did not open.' };
    }

    const ok = Boolean(checks.connect?.ok && checks.list?.ok);
    const message = ok ? `Connected, and ${root} can be read.` : (checks.connect.ok ? checks.list.message : checks.connect.message);

    await record({
      event: 'settings.domain.ftp-tested',
      actor: req.user,
      domain: req.domain,
      summary: `Tested the file server for ${req.domain.name}`,
      // Where it went and how it went. Never the password.
      detail:
        `Tried ${settings.ftpHost}:${settings.ftpPort || (protocol === 'SFTP' ? 22 : 21)} as ` +
        `${settings.ftpUsername} over ${protocol}, reading ${root}.\n\n` +
        `Connect: ${checks.connect.message}\nFolder:  ${checks.list.message}`,
    });

    // `error` as well, so a caller that only looks there still gets something
    // true rather than a status code.
    res.json({ ok, protocol, root, checks, message, error: ok ? null : message });
  }),
);
