// Putting a website onto a hosting account.
//
// What this does, precisely: it takes a set of files — out of a zip somebody
// uploaded, or out of a public git repository — and writes them into the
// domain's web root over FTP, FTPS or SFTP. It does not run anything. Not the
// repository's build script, not its install hooks, not a single line of the
// code it is deploying. The files are read and they are uploaded, and that is
// the whole of it.
//
// That restraint is the security model. Running a customer's build on this
// server would run their code with this process's access to the database and
// to every provider token and FTP password it holds. A build step is a real
// feature and a reasonable thing to want; it needs a sandbox, and until there
// is one, this refuses to pretend.
//
// Three things make a deploy safe to press:
//
//   The plan is worked out and shown before anything is written, so "this
//   will delete 412 files" is a sentence somebody can still stop.
//
//   Whatever is about to be overwritten or deleted is moved aside first, not
//   copied — a rename is one instruction and costs no bandwidth, which is
//   what makes backing up affordable enough to do every single time.
//
//   Rollback is exact rather than approximate: the record says which files
//   were created and which were moved where, so undoing is deleting the
//   first list and moving the second one back.

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { prisma } from '../db.js';
import { withStorage, resolvePath, StorageError } from '../lib/storage.js';
import { readZip, stripCommonRoot, isExcluded, LIMITS, ArchiveError } from '../lib/archive.js';
import { buildPlan, describePlan, digest, assertSensible, DeployRefusal } from '../lib/deployPlan.js';
import { record } from './notifier.js';

/// Where backups live, beneath the domain's own root. A dot-directory because
/// Apache and nginx both refuse to serve those by default, so a backup is not
/// quietly published alongside the site it came from.
export const BACKUP_DIR = '.portal-backups';

/// How many to keep. Enough to undo a bad week, few enough not to fill
/// somebody's hosting quota with copies of their own website.
const KEEP_BACKUPS = 5;

/// A clone is a network operation against a server we do not control.
const GIT_TIMEOUT_MS = 90 * 1000;

/// Above this many files the manifest is not stored. It exists to make the
/// *next* deploy quicker; it is not worth putting two megabytes of JSON in a
/// row to achieve that.
const MANIFEST_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// Files out of an uploaded zip.
export async function filesFromZip(buffer, { exclude = [], stripRoot = true } = {}) {
  const read = await readZip(buffer, { exclude });
  // Folders alone are nothing to deploy.
  if (!read.files.length) throw new ArchiveError('That archive has no files in it.');
  const { files, stripped } = stripRoot ? stripCommonRoot(read.files) : { files: read.files, stripped: null };
  return { files, skipped: read.skipped, stripped, bytes: read.totalBytes };
}

/// Only https, and only without credentials in the URL.
///
/// A token in the URL would be written into the deployment record and into
/// the log line of every clone — which is how tokens leak. Private
/// repositories need a stored credential, which is a later feature with its
/// own encryption, not something to smuggle in through a text field.
export function assertSafeGitUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new DeployRefusal('That is not a valid URL. It should look like https://github.com/you/your-site.');
  }

  if (url.protocol !== 'https:') {
    throw new DeployRefusal('Only https:// repository URLs are accepted.');
  }
  if (url.username || url.password) {
    throw new DeployRefusal(
      'Take the username or token out of the URL. Only public repositories are supported for now, and a ' +
        'token in a URL ends up written into logs.',
    );
  }
  return url.toString();
}

/// Clones a public repository and reads the files out of the checkout.
///
/// `--depth 1` because history is not being deployed, and no submodules,
/// because a submodule URL is another server this would then be asked to
/// contact on somebody else's say-so.
export async function filesFromGit(rawUrl, { ref, exclude = [] } = {}) {
  const url = assertSafeGitUrl(rawUrl);
  const branch = String(ref || '').trim();

  if (branch && !/^[\w.\-\/]{1,120}$/.test(branch)) {
    throw new DeployRefusal('That branch or tag name has characters in it that are not allowed.');
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-deploy-'));
  try {
    const args = [
      'clone',
      '--depth', '1',
      '--single-branch',
      '--no-tags',
      // A repository must not be able to pull in other repositories.
      '--recurse-submodules=no',
      ...(branch ? ['--branch', branch] : []),
      url,
      dir,
    ];

    await runGit(args, {
      // Without this, a private repository makes git sit waiting for a
      // password that will never come, and the request hangs until it times
      // out somewhere less helpful.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/true',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    });

    const commit = (await runGit(['-C', dir, 'rev-parse', 'HEAD'])).trim().slice(0, 12);
    const files = await readTree(dir, exclude);

    return { files, commit, url, ref: branch || null, bytes: files.reduce((s, f) => s + f.contents.length, 0) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runGit(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c.toString().slice(0, 4000); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new DeployRefusal(`The repository did not finish cloning within ${GIT_TIMEOUT_MS / 1000} seconds.`));
    }, GIT_TIMEOUT_MS);

    child.on('error', () => {
      clearTimeout(timer);
      reject(new DeployRefusal('git is not available on this server, so deploying from a repository is not possible here.'));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new DeployRefusal(friendlyGitError(err)));
    });
  });
}

const friendlyGitError = (stderr) => {
  const text = String(stderr || '');
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(text)) {
    return 'That repository is private, or it does not exist. Only public repositories work for now.';
  }
  if (/Remote branch .* not found|couldn.t find remote ref/i.test(text)) {
    return 'That branch or tag does not exist in the repository.';
  }
  if (/Could not resolve host|unable to access/i.test(text)) {
    return 'Could not reach that repository. Check the URL, and that this server is allowed to reach it.';
  }
  return `The clone failed: ${text.split('\n').filter(Boolean).slice(-1)[0] || 'unknown error'}`;
};

/// Reads a checkout into the same shape a zip produces, applying the same
/// caps. A repository is no more trustworthy than an upload.
async function readTree(root, exclude) {
  const files = [];
  let total = 0;

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');

      if (isExcluded(relative, exclude)) continue;

      // A symlink in a repository can point anywhere on this machine. It is
      // never followed and never copied.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (relative.split('/').length >= LIMITS.depth) {
          throw new ArchiveError(`The repository nests deeper than ${LIMITS.depth} folders.`);
        }
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = await fs.stat(full);
      if (stat.size > LIMITS.fileBytes) {
        throw new ArchiveError(`${relative} is larger than ${LIMITS.fileBytes / 1024 / 1024} MB.`);
      }
      total += stat.size;
      if (total > LIMITS.totalBytes) {
        throw new ArchiveError(`That repository is larger than ${LIMITS.totalBytes / 1024 / 1024} MB of files.`);
      }
      if (files.length >= LIMITS.entries) {
        throw new ArchiveError(`That repository holds more than ${LIMITS.entries} files.`);
      }

      files.push({ path: relative, contents: await fs.readFile(full) });
    }
  }

  await walk(root);
  return files;
}

// ---------------------------------------------------------------------------
// Looking at what is there now
// ---------------------------------------------------------------------------

/// Every file beneath a directory, as relative paths.
///
/// The backup directory is skipped: a deploy must never treat its own old
/// copies as part of the site, or the second deploy would back up the first
/// backup and the third would back up both.
export async function listTree(storage, base, { skip = [BACKUP_DIR] } = {}) {
  const files = [];

  async function walk(absolute, relative, depth) {
    if (depth > LIMITS.depth) return;

    let entries;
    try {
      entries = await storage.list(absolute);
    } catch (err) {
      // A directory that cannot be listed is reported rather than silently
      // treated as empty — an empty reading is exactly what would make a
      // replace-deploy delete nothing and then claim success.
      if (depth === 0) throw err;
      return;
    }

    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (skip.includes(childRelative)) continue;

      if (entry.type === 'directory') {
        await walk(`${absolute}/${entry.name}`, childRelative, depth + 1);
      } else {
        files.push({ path: childRelative, size: entry.size ?? 0 });
      }
    }
  }

  await walk(base, '', 0);
  return files;
}

/// What is on the server at the deploy target, creating the folder if it is
/// not there yet.
///
/// Deploying into a folder that does not exist — /blog, say — is an ordinary
/// thing to want, so the folder is made rather than the deploy refused. It
/// also settles what an unlistable directory means: if it cannot be made
/// either, the error says so instead of the listing quietly coming back empty
/// and a replace-deploy believing the site was already bare.
export async function readTarget(credentials, base) {
  return withStorage(credentials, async (storage) => {
    try {
      return await listTree(storage, base);
    } catch (err) {
      await ensureDir(storage, base).catch(() => {
        throw new StorageError(
          `Could not open or create ${base} on the server. Check the FTP root and that the account can write there.`,
          502,
        );
      });
      // Freshly made, so there is nothing in it.
      return [];
    }
  });
}

/// The plan, with the previous deploy's fingerprints folded in.
///
/// Those fingerprints are how a second deploy of a large site finishes in
/// seconds: a file whose content has not changed since last time is not sent
/// again. The manifest describes what *this portal* last wrote, so a file
/// edited directly on the server afterwards will look unchanged here — which
/// is what "Upload everything again" is for.
export function planFor({ source, target, manifest, deleteMissing, keep, force }) {
  const withHashes = target.map((entry) => ({
    ...entry,
    hash: manifest?.[entry.path] ?? null,
  }));

  const plan = force
    ? buildPlan(source, withHashes.map((e) => ({ ...e, hash: null })), { deleteMissing, keep })
    : buildPlan(source, withHashes, { deleteMissing, keep });

  assertSensible(plan, target, { deleteMissing, force });
  return plan;
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

/// Runs a deploy and records it.
///
/// The record is written before the first byte is uploaded and finished
/// afterwards, so a deploy that dies halfway leaves a row saying so rather
/// than nothing at all — and the backup it already took is named in that row.
export async function deploy({ domain, credentials, source, plan, options, actor, meta }) {
  const base = resolvePath(credentials.root, options.targetPath || '/');
  const number = await nextNumber(domain.id);
  const backupName = `deploy-${String(number).padStart(4, '0')}`;
  const backupBase = `${resolvePath(credentials.root, '/')}/${BACKUP_DIR}/${backupName}`;

  const row = await prisma.deployment.create({
    data: {
      domainId: domain.id,
      number,
      source: meta.source,
      status: 'RUNNING',
      gitUrl: meta.gitUrl ?? null,
      gitRef: meta.gitRef ?? null,
      gitCommit: meta.gitCommit ?? null,
      archiveName: meta.archiveName ?? null,
      targetPath: options.targetPath || '/',
      deleteMissing: Boolean(options.deleteMissing),
      keepPaths: (options.keep || []).join(',') || null,
      backupPath: `${BACKUP_DIR}/${backupName}`,
      actorId: actor?.id ?? null,
      actorLabel: actor ? `${actor.name} <${actor.email}>` : null,
    },
  });

  const startedAt = Date.now();
  const movedAside = [];
  const created = [];
  let uploaded = 0;

  try {
    await withStorage(credentials, async (storage) => {
      // 1. Move aside everything this deploy is about to overwrite or delete.
      //    Renames, not copies: one instruction each, no bandwidth, and the
      //    old file is still there to move back.
      const endangered = [...plan.update, ...plan.remove].map((f) => f.path);
      if (endangered.length) {
        await ensureDir(storage, backupBase);
        for (const relative of endangered) {
          const from = `${base}/${relative}`;
          const to = `${backupBase}/${relative}`;
          await ensureDir(storage, path.posix.dirname(to));
          try {
            await storage.rename(from, to);
            movedAside.push(relative);
          } catch (err) {
            throw new StorageError(
              `Could not set ${relative} aside before replacing it, so nothing was changed. (${err?.message || 'rename failed'})`,
              502,
            );
          }
        }
      }

      // 2. Make the folders the new files need.
      for (const dir of plan.directories) {
        await ensureDir(storage, `${base}/${dir}`);
      }

      // 3. Write the files.
      const byPath = new Map(source.map((f) => [f.path, f.contents]));
      for (const file of [...plan.create, ...plan.update]) {
        const contents = byPath.get(file.path);
        if (!contents) continue;
        await storage.write(`${base}/${file.path}`, contents);
        uploaded += contents.length;
        if (plan.create.some((c) => c.path === file.path)) created.push(file.path);
      }
    });

    const manifest = source.length <= MANIFEST_LIMIT
      ? Object.fromEntries(source.map((f) => [f.path, digest(f.contents)]))
      : null;

    const finished = await prisma.deployment.update({
      where: { id: row.id },
      data: {
        status: 'SUCCEEDED',
        filesCreated: plan.create.length,
        filesUpdated: plan.update.length,
        filesDeleted: plan.remove.length,
        filesUnchanged: plan.unchanged.length,
        bytesUploaded: uploaded,
        manifest,
        movedAside: movedAside.length ? movedAside : null,
        createdPaths: created.length ? created : null,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        message: describePlan(plan),
      },
    });

    await record({
      event: 'deploy.completed',
      actor,
      domain,
      summary: `Deployed to ${domain.name}: ${describePlan(plan)}`,
      detail:
        `Source:  ${sourceLabel(meta)}\n` +
        `Into:    ${options.targetPath || '/'}\n` +
        `Backup:  ${BACKUP_DIR}/${backupName}\n` +
        `Uploaded ${(uploaded / 1024).toFixed(0)} KB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
    });

    await pruneBackups(domain.id, credentials).catch((err) =>
      console.error('backup prune failed:', err?.message),
    );

    return finished;
  } catch (err) {
    await prisma.deployment.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        error: String(err?.message || 'The deploy failed.').slice(0, 900),
        movedAside: movedAside.length ? movedAside : null,
        createdPaths: created.length ? created : null,
        bytesUploaded: uploaded,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    }).catch(() => null);

    await record({
      event: 'deploy.failed',
      actor,
      domain,
      summary: `Deploy to ${domain.name} failed`,
      detail:
        `${err?.message || 'unknown error'}\n\n` +
        (movedAside.length
          ? `${movedAside.length} file(s) were already set aside in ${BACKUP_DIR}/${backupName}. ` +
            'Roll this deploy back from the portal to put them back.'
          : 'Nothing on the server was changed.'),
    });

    throw err;
  }
}

const sourceLabel = (meta) =>
  meta.source === 'GIT'
    ? `${meta.gitUrl}${meta.gitRef ? ` (${meta.gitRef})` : ''}${meta.gitCommit ? ` @ ${meta.gitCommit}` : ''}`
    : meta.archiveName || 'uploaded archive';

/// Puts a deploy back the way it was.
///
/// Exact rather than best-effort: the files this deploy created are deleted,
/// and the files it moved aside are moved back. Both lists were written at the
/// time, so nothing has to be guessed at now.
export async function rollback({ domain, credentials, deployment, actor }) {
  if (!deployment.backupPath) {
    throw new DeployRefusal('That deploy has no backup recorded, so it cannot be rolled back.');
  }
  if (deployment.status === 'ROLLED_BACK') {
    throw new DeployRefusal('That deploy has already been rolled back.');
  }

  const base = resolvePath(credentials.root, deployment.targetPath || '/');
  const backupBase = `${resolvePath(credentials.root, '/')}/${deployment.backupPath}`;

  const createdPaths = deployment.createdPaths || [];
  const movedAside = deployment.movedAside || [];
  const problems = [];

  await withStorage(credentials, async (storage) => {
    // Remove what this deploy added. A file that is already gone is not a
    // problem — the end state is what matters.
    for (const relative of createdPaths) {
      try {
        await storage.removeFile(`${base}/${relative}`);
      } catch (err) {
        if (!/no such file|not found|550/i.test(String(err?.message))) {
          problems.push(`could not remove ${relative}`);
        }
      }
    }

    // Put back what it replaced.
    for (const relative of movedAside) {
      const from = `${backupBase}/${relative}`;
      const to = `${base}/${relative}`;
      try {
        await ensureDir(storage, path.posix.dirname(to));
        // The deploy may have written a new file over this path; it has to go
        // before the old one can take its place again.
        await storage.removeFile(to).catch(() => {});
        await storage.rename(from, to);
      } catch (err) {
        problems.push(`could not restore ${relative}`);
      }
    }
  });

  const updated = await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      status: 'ROLLED_BACK',
      message: problems.length
        ? `Rolled back with ${problems.length} problem(s).`
        : `Rolled back: ${createdPaths.length} removed, ${movedAside.length} restored.`,
      error: problems.length ? problems.slice(0, 20).join('; ').slice(0, 900) : null,
    },
  });

  await record({
    event: 'deploy.rolled-back',
    actor,
    domain,
    summary: `Rolled back deploy #${deployment.number} on ${domain.name}`,
    detail:
      `${createdPaths.length} file(s) removed, ${movedAside.length} restored.` +
      (problems.length ? `\n\nProblems:\n${problems.join('\n')}` : ''),
  });

  return { deployment: updated, problems };
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

async function nextNumber(domainId) {
  const last = await prisma.deployment.findFirst({
    where: { domainId },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  return (last?.number ?? 0) + 1;
}

/// Creates a directory and everything above it.
///
/// "Already exists" is success. Both protocols report it differently and
/// neither reports it usefully, so the result is checked by trying rather
/// than by asking first.
async function ensureDir(storage, dir) {
  try {
    await storage.mkdir(dir);
  } catch (err) {
    const message = String(err?.message || '').toLowerCase();
    if (!/exist|file already|550|4[0-9][0-9]/.test(message)) throw err;
  }
}

/// Deletes the oldest backups beyond the limit.
///
/// A backup that is still the newest one is never removed, whatever the
/// count says: the most recent deploy must stay undoable.
async function pruneBackups(domainId, credentials) {
  const all = await prisma.deployment.findMany({
    where: { domainId, backupPath: { not: null }, status: { in: ['SUCCEEDED', 'FAILED'] } },
    orderBy: { number: 'desc' },
    select: { id: true, backupPath: true },
  });

  const stale = all.slice(KEEP_BACKUPS);
  if (!stale.length) return;

  const root = resolvePath(credentials.root, '/');
  await withStorage(credentials, async (storage) => {
    for (const deployment of stale) {
      try {
        await storage.removeDir(`${root}/${deployment.backupPath}`);
      } catch {
        // A backup that is already gone, or a server that will not remove a
        // directory, is not worth failing a deploy over.
      }
      await prisma.deployment
        .update({ where: { id: deployment.id }, data: { backupPath: null, movedAside: null, createdPaths: null } })
        .catch(() => null);
    }
  });
}
