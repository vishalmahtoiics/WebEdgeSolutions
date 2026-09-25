// Which code this process is running.
//
// "I pushed the fix but still see the bug" is almost always a server still
// running the old code: pulled but not restarted, or a deploy that never
// rebuilt. The only way to tell from the outside is for the running process
// to say which commit it started from, so it does.
//
// Read once, when the process starts, on purpose. Pulling new code without
// restarting changes .git on disk while the old code keeps running; reading
// it again later would report the new commit and hide exactly the problem
// this is here to show.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/// The commit from the platform, when it provides one. Container builds do
/// not copy .git (see .dockerignore), so this is the only source there.
function fromEnvironment() {
  const value =
    process.env.SOURCE_COMMIT || // Coolify
    process.env.RAILWAY_GIT_COMMIT_SHA || // Railway
    process.env.RENDER_GIT_COMMIT || // Render
    process.env.GIT_COMMIT ||
    process.env.COMMIT_SHA;
  return value && /^[0-9a-f]{7,40}$/i.test(value.trim()) ? value.trim() : null;
}

/// The commit a git checkout is on, read from the files git keeps, so that
/// neither git nor a shell is needed.
function fromCheckout() {
  try {
    const gitDir = path.join(root, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return /^[0-9a-f]{40}$/i.test(head) ? head : null;

    const ref = head.slice(4).trim();
    try {
      return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    } catch {
      // A ref that has been packed lives in packed-refs instead.
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      return line ? line.split(' ')[0] : null;
    }
  } catch {
    return null;
  }
}

const commit = fromEnvironment() || fromCheckout();
const startedAt = new Date().toISOString();

/// `{ commit, startedAt }`, where `commit` is a short hash or null when the
/// process cannot tell.
export const portalVersion = () => ({ commit: commit ? commit.slice(0, 7) : null, startedAt });
