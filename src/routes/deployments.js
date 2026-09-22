// Deploying a website, and undoing it.
//
// Mounted under /api/domains/:id/deployments, so the same domain
// authorization that guards the file manager guards this: a user only ever
// reaches a domain assigned to them, and the FTP credentials never leave this
// process.
//
// The shape of the thing is preview-then-apply. `POST /preview` reads the
// source and the server and returns what would happen; `POST /` does it. They
// take the same body and run the same planner, so what was shown is what runs.

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { prisma } from '../db.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { decryptMaybe } from '../lib/crypto.js';
import { resolvePath, StorageError } from '../lib/storage.js';
import { excludedNames, LIMITS } from '../lib/archive.js';
import { describePlan, DeployRefusal } from '../lib/deployPlan.js';
import {
  BACKUP_DIR, deploy, filesFromGit, filesFromZip, planFor, readTarget, rollback,
} from '../services/deployService.js';

export const deploymentsRouter = Router({ mergeParams: true });

/// A zip is held in memory while it is checked, so the cap is real memory.
/// 128 MB compressed is far more than any website this portal will deploy,
/// and the uncompressed cap in the archive reader is the one that matters.
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1 },
});

async function credentialsFor(domainId) {
  const settings = await prisma.domainSettings.findUnique({ where: { domainId } });
  if (!settings?.ftpHost || !settings?.ftpUsername) {
    throw badRequest('FTP is not set up for this domain yet. Add the details under FTP & Server first.');
  }
  return {
    host: settings.ftpHost,
    port: settings.ftpPort,
    username: settings.ftpUsername,
    password: decryptMaybe(settings.ftpPassword),
    protocol: settings.ftpProtocol,
    root: settings.ftpRootPath || '/',
  };
}

/// A checkbox, out of a multipart form.
///
/// `z.coerce.boolean()` is wrong here and dangerously so: every field in a
/// multipart body arrives as a string, and `Boolean('false')` is true. An
/// unticked "Replace the site" would have deleted the site.
const checkbox = () =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      if (value === undefined) return undefined;
      return !['false', '0', '', 'off', 'no'].includes(String(value).trim().toLowerCase());
    });

const optionsSchema = z.object({
  /// Where under the domain's root to deploy. Confined by resolvePath, so
  /// ".." here reaches nothing.
  targetPath: z.string().trim().max(200).optional(),
  gitUrl: z.string().trim().max(400).optional(),
  gitRef: z.string().trim().max(120).optional(),
  deleteMissing: checkbox(),
  /// Never deleted even in a replace. Comma separated: "uploads,wp-content".
  keep: z.string().trim().max(400).optional(),
  /// Extra names to leave out of the source, beyond the built-in list.
  exclude: z.string().trim().max(400).optional(),
  /// Ignore the previous deploy's fingerprints and send every file again.
  force: checkbox(),
  /// Acknowledges the "this looks like the wrong folder" refusal.
  confirmDestructive: checkbox(),
  /// A zip from GitHub wraps everything in one folder; stripping it is what
  /// everybody expects, but it can be switched off.
  stripRoot: checkbox(),
});

const splitList = (value) =>
  String(value || '')
    .split(/[,\n]+/)
    .map((v) => v.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);

/// Reads whichever source the request describes.
///
/// A file field means a zip; a gitUrl means a repository. Asking for both is
/// a mistake worth saying out loud rather than silently preferring one.
async function loadSource(req, options) {
  const exclude = splitList(options.exclude);

  if (req.file && options.gitUrl) {
    throw badRequest('Send either a zip file or a repository URL, not both.');
  }

  if (req.file) {
    const read = await filesFromZip(req.file.buffer, {
      exclude,
      stripRoot: options.stripRoot !== false,
    });
    return {
      files: read.files,
      skipped: read.skipped,
      stripped: read.stripped,
      meta: { source: 'ZIP', archiveName: req.file.originalname?.slice(0, 200) || 'upload.zip' },
    };
  }

  if (options.gitUrl) {
    const read = await filesFromGit(options.gitUrl, { ref: options.gitRef, exclude });
    return {
      files: read.files,
      skipped: [],
      stripped: null,
      meta: { source: 'GIT', gitUrl: read.url, gitRef: read.ref, gitCommit: read.commit },
    };
  }

  throw badRequest('Choose a zip file to upload, or give a repository URL.');
}

/// Turns the library's own refusals into ordinary HTTP errors.
const asHttp = (err) => {
  if (err instanceof DeployRefusal || err instanceof StorageError) return err;
  if (err?.status) return err;
  return Object.assign(new Error(err?.message || 'The deploy failed.'), { status: 502 });
};

// ---------------------------------------------------------------------------
// What is there, and what has happened
// ---------------------------------------------------------------------------

deploymentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const deployments = await prisma.deployment.findMany({
      where: { domainId: req.domain.id },
      orderBy: { number: 'desc' },
      take: 40,
      // The path lists can be thousands of entries; the list does not need
      // them and sending them would make this response enormous.
      select: {
        id: true, number: true, source: true, status: true,
        gitUrl: true, gitRef: true, gitCommit: true, archiveName: true,
        targetPath: true, deleteMissing: true,
        filesCreated: true, filesUpdated: true, filesDeleted: true, filesUnchanged: true,
        bytesUploaded: true, backupPath: true, message: true, error: true,
        actorLabel: true, startedAt: true, finishedAt: true, durationMs: true,
      },
    });

    res.json({
      deployments,
      /// What the page needs in order to explain itself without a round trip.
      limits: {
        maxArchiveMb: MAX_ARCHIVE_BYTES / 1024 / 1024,
        maxUnpackedMb: LIMITS.totalBytes / 1024 / 1024,
        maxFiles: LIMITS.entries,
      },
      excluded: excludedNames(),
      backupDir: BACKUP_DIR,
    });
  }),
);

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/// Works out what a deploy would do, and writes nothing.
///
/// Both the source and the server are read, which is most of the cost of the
/// deploy itself — that is the price of being able to say "this will delete
/// 412 files" before it does.
deploymentsRouter.post(
  '/preview',
  upload.single('archive'),
  asyncHandler(async (req, res) => {
    const parsed = optionsSchema.safeParse(req.body || {});
    if (!parsed.success) throw badRequest('Check the deploy options.', parsed.error.flatten().fieldErrors);
    const options = parsed.data;

    const credentials = await credentialsFor(req.domain.id);
    const base = resolvePath(credentials.root, options.targetPath || '/');

    let source;
    try {
      source = await loadSource(req, options);
    } catch (err) {
      throw asHttp(err);
    }

    const last = await prisma.deployment.findFirst({
      where: { domainId: req.domain.id, status: 'SUCCEEDED', manifest: { not: null } },
      orderBy: { number: 'desc' },
      select: { manifest: true, number: true },
    });

    let target;
    try {
      target = await readTarget(credentials, base);
    } catch (err) {
      throw asHttp(err);
    }

    let plan;
    try {
      plan = planFor({
        source: source.files,
        target,
        manifest: last?.manifest || null,
        deleteMissing: Boolean(options.deleteMissing),
        keep: splitList(options.keep),
        force: Boolean(options.force),
      });
    } catch (err) {
      // A refusal is still a useful answer here: the page should show what it
      // would have done alongside the reason it will not.
      if (err instanceof DeployRefusal) {
        return res.json({
          ok: false,
          refusal: err.message,
          summary: `${target.length} file(s) on the server, ${source.files.length} in the source.`,
        });
      }
      throw asHttp(err);
    }

    res.json({
      ok: true,
      summary: describePlan(plan),
      counts: {
        create: plan.create.length,
        update: plan.update.length,
        remove: plan.remove.length,
        unchanged: plan.unchanged.length,
        onServer: target.length,
        inSource: source.files.length,
      },
      bytes: plan.bytes,
      // Enough to see what is happening without shipping ten thousand paths.
      sample: {
        create: plan.create.slice(0, 40).map((f) => f.path),
        update: plan.update.slice(0, 40).map((f) => f.path),
        remove: plan.remove.slice(0, 40).map((f) => f.path),
      },
      protectedFromDelete: plan.protectedFromDelete.slice(0, 40),
      skipped: source.skipped.slice(0, 40),
      strippedFolder: source.stripped,
      isNoOp: plan.isNoOp,
      usedManifestFrom: last?.number ?? null,
      from:
        source.meta.source === 'GIT'
          ? { kind: 'git', url: source.meta.gitUrl, ref: source.meta.gitRef, commit: source.meta.gitCommit }
          : { kind: 'zip', name: source.meta.archiveName },
    });
  }),
);

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

deploymentsRouter.post(
  '/',
  upload.single('archive'),
  asyncHandler(async (req, res) => {
    const parsed = optionsSchema.safeParse(req.body || {});
    if (!parsed.success) throw badRequest('Check the deploy options.', parsed.error.flatten().fieldErrors);
    const options = parsed.data;

    const credentials = await credentialsFor(req.domain.id);
    const base = resolvePath(credentials.root, options.targetPath || '/');

    // One deploy at a time per domain. Two at once would interleave their
    // uploads and their backups, and the second one's rollback would restore
    // half of the first.
    const running = await prisma.deployment.findFirst({
      where: { domainId: req.domain.id, status: 'RUNNING' },
      select: { number: true, startedAt: true },
    });
    if (running && Date.now() - new Date(running.startedAt).getTime() < 30 * 60 * 1000) {
      throw badRequest(`Deploy #${running.number} is still running on this domain.`);
    }

    let source;
    try {
      source = await loadSource(req, options);
    } catch (err) {
      throw asHttp(err);
    }

    const last = await prisma.deployment.findFirst({
      where: { domainId: req.domain.id, status: 'SUCCEEDED', manifest: { not: null } },
      orderBy: { number: 'desc' },
      select: { manifest: true },
    });

    let target;
    let plan;
    try {
      target = await readTarget(credentials, base);
      plan = planFor({
        source: source.files,
        target,
        manifest: last?.manifest || null,
        deleteMissing: Boolean(options.deleteMissing),
        keep: splitList(options.keep),
        force: Boolean(options.force || options.confirmDestructive),
      });
    } catch (err) {
      throw asHttp(err);
    }

    if (plan.isNoOp) {
      return res.json({
        ok: true,
        noop: true,
        message: 'Everything on the server already matches the source. Nothing was changed.',
      });
    }

    let deployment;
    try {
      deployment = await deploy({
        domain: req.domain,
        credentials,
        source: source.files,
        plan,
        options: {
          targetPath: options.targetPath || '/',
          deleteMissing: Boolean(options.deleteMissing),
          keep: splitList(options.keep),
        },
        actor: req.user,
        meta: source.meta,
      });
    } catch (err) {
      throw asHttp(err);
    }

    res.status(201).json({
      ok: true,
      deployment,
      message: `Deployed to ${req.domain.name}: ${describePlan(plan)}.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

deploymentsRouter.post(
  '/:deploymentId/rollback',
  asyncHandler(async (req, res) => {
    const deployment = await prisma.deployment.findFirst({
      where: { id: req.params.deploymentId, domainId: req.domain.id },
    });
    if (!deployment) throw notFound('That deploy does not exist.');

    const credentials = await credentialsFor(req.domain.id);

    let result;
    try {
      result = await rollback({ domain: req.domain, credentials, deployment, actor: req.user });
    } catch (err) {
      throw asHttp(err);
    }

    res.json({
      ok: true,
      deployment: result.deployment,
      problems: result.problems,
      message: result.problems.length
        ? `Rolled back deploy #${deployment.number}, with ${result.problems.length} problem(s).`
        : `Rolled back deploy #${deployment.number}.`,
    });
  }),
);
