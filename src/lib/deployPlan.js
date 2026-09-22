// Working out what a deploy would actually do, before it does it.
//
// The plan is computed and shown first, and only then applied. That order is
// the whole safety story: "this will delete 412 files" is a sentence somebody
// can stop, and "this deleted 412 files" is not.
//
// Everything here is pure — it takes two file listings and returns a
// description. Nothing in this file touches a network or a disk, which is why
// the interesting cases can be tested without either.

import path from 'node:path';
import crypto from 'node:crypto';

/// The fingerprint a file is compared by.
///
/// Content, not size or timestamp. A timestamp over FTP is unreliable to the
/// minute and sometimes to the year, and two different files of the same
/// length are entirely ordinary.
export const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/// What a deploy would do.
///
/// `source` is what is being deployed: [{ path, contents }].
/// `target` is what is on the server now: [{ path, size, hash? }].
///
/// `deleteMissing` decides between the two honest meanings of "deploy":
/// replace the site, or add to it. Off by default, because deleting somebody's
/// uploads folder because it was not in the zip is the worse mistake.
export function buildPlan(source, target, { deleteMissing = false, keep = [] } = {}) {
  const byPath = new Map(target.map((entry) => [entry.path, entry]));
  const kept = keep.map((k) => k.replace(/^\/+|\/+$/g, '')).filter(Boolean);

  const isKept = (file) =>
    kept.some((k) => file === k || file.startsWith(`${k}/`));

  const create = [];
  const update = [];
  const unchanged = [];

  for (const file of source) {
    const existing = byPath.get(file.path);
    if (!existing) {
      create.push({ path: file.path, bytes: file.contents.length });
      continue;
    }
    // A hash is only available when the caller read the file back. Where it
    // is not, size is the fallback and equal sizes are re-uploaded rather
    // than assumed identical — the cost is bandwidth, the alternative is a
    // stale file nobody can explain.
    const same = existing.hash ? existing.hash === digest(file.contents) : false;
    if (same) unchanged.push({ path: file.path, bytes: file.contents.length });
    else update.push({ path: file.path, bytes: file.contents.length });
  }

  const sourcePaths = new Set(source.map((f) => f.path));
  const remove = deleteMissing
    ? target
        .filter((entry) => !sourcePaths.has(entry.path) && !isKept(entry.path))
        .map((entry) => ({ path: entry.path, bytes: entry.size ?? 0 }))
    : [];

  const protectedFromDelete = deleteMissing
    ? target.filter((entry) => !sourcePaths.has(entry.path) && isKept(entry.path)).map((e) => e.path)
    : [];

  // The folders that have to exist before any of this can be written, deepest
  // last so each one's parent is made first.
  const directories = [...new Set(
    [...create, ...update]
      .map((f) => path.posix.dirname(f.path))
      .filter((dir) => dir && dir !== '.')
      .flatMap((dir) => {
        const parts = dir.split('/');
        return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
      }),
  )].sort((a, b) => a.split('/').length - b.split('/').length);

  return {
    create,
    update,
    unchanged,
    remove,
    directories,
    protectedFromDelete,
    bytes: [...create, ...update].reduce((sum, f) => sum + f.bytes, 0),
    /// Nothing to do is worth saying out loud rather than running an empty
    /// deploy and reporting success.
    isNoOp: create.length === 0 && update.length === 0 && remove.length === 0,
  };
}

/// A sentence describing the plan, for the confirmation and for the alert.
export function describePlan(plan) {
  const parts = [];
  if (plan.create.length) parts.push(`${plan.create.length} new`);
  if (plan.update.length) parts.push(`${plan.update.length} changed`);
  if (plan.remove.length) parts.push(`${plan.remove.length} deleted`);
  if (plan.unchanged.length) parts.push(`${plan.unchanged.length} unchanged`);
  return parts.length ? parts.join(', ') : 'nothing to do';
}

/// Sanity checks that stop a plan which is probably a mistake.
///
/// These are not about malice. They are about the zip somebody built from the
/// wrong folder, which is a far more common way to destroy a website than
/// anything an attacker does.
export function assertSensible(plan, target, { deleteMissing, force = false }) {
  if (!deleteMissing || force) return;

  // Wiping a site that has content, replacing it with almost nothing, is
  // what "I zipped the wrong folder" looks like from here.
  const removing = plan.remove.length;
  const writing = plan.create.length + plan.update.length;

  if (target.length >= 10 && removing >= target.length * 0.9 && writing < 3) {
    throw new DeployRefusal(
      `This would delete ${removing} of the ${target.length} files on the server and put back only ` +
        `${writing}. That is usually a zip built from the wrong folder. Check the preview, and tick ` +
        '"I know, do it anyway" if it is really what you want.',
    );
  }
}

export class DeployRefusal extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}
