// Reading a zip somebody uploaded.
//
// A zip file is not data, it is a set of instructions for writing files, and
// the instructions come from outside. Three of them are attacks, and all three
// are old enough to have names:
//
//   Zip Slip. An entry called "../../../../etc/passwd" is a perfectly legal
//   zip entry. Extracted naively it writes wherever it likes. Every path here
//   is resolved and then checked to be inside the destination — checked after
//   resolving, because "a/../../b" only looks safe before.
//
//   Zip bombs. A megabyte of zip can hold a terabyte of zeroes. Nothing is
//   trusted from the header: the uncompressed size is counted as it is read,
//   and reading stops the moment the running total passes the cap.
//
//   Symlinks. A zip can carry a symlink entry pointing at /etc, and a later
//   entry can then write "through" it. Symlinks are refused outright. This
//   deploys websites; nothing here needs one.
//
// Nothing in this file executes anything. It turns a zip into a list of paths
// and buffers, and that is all it does.

import path from 'node:path';
import yauzl from 'yauzl';

/// Caps. Generous enough for any website this portal will be asked to deploy,
/// small enough that a hostile archive cannot exhaust the container.
export const LIMITS = {
  /// Total uncompressed bytes.
  totalBytes: 256 * 1024 * 1024,
  /// A single file. A 64 MB asset in a website is already unusual.
  fileBytes: 64 * 1024 * 1024,
  /// Entries. A large site is a few thousand files; a hundred thousand is an
  /// attack or a mistake, and both should stop here.
  entries: 20000,
  /// How deep a path may nest.
  depth: 24,
};

export class ArchiveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/// Files that must never reach a web root, whatever the archive says.
///
/// `.env` is the one that matters most: a stray .env in a public directory
/// publishes the database password of whoever owns the site, and it is served
/// as plain text by every default Apache and nginx configuration.
const ALWAYS_EXCLUDE = [
  '.git',
  '.gitignore',
  '.gitattributes',
  '.github',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '.idea',
  '.vscode',
  'npm-debug.log',
  'yarn-error.log',
];

/// Whether a path is excluded, by any of its segments.
///
/// Matched per segment rather than by prefix, so "src/.env" and "a/b/.git/c"
/// are caught as surely as ".env" at the root.
export function isExcluded(relativePath, extra = []) {
  return matchesSegment(relativePath, [...ALWAYS_EXCLUDE, ...extra]);
}

/// Whether any segment of a path is one of `names`, ignoring case.
function matchesSegment(relativePath, names) {
  if (!names.length) return false;
  const blocked = new Set(names.map((e) => e.toLowerCase()));
  return relativePath
    .split('/')
    .some((segment) => blocked.has(segment.toLowerCase()));
}

export const excludedNames = () => [...ALWAYS_EXCLUDE];

/// Normalises an entry's path and refuses anything that could escape.
///
/// Returns null for a path that should simply be skipped — a directory entry,
/// or the "./" some tools write — and throws for one that is trying something.
export function safeEntryPath(raw) {
  const name = String(raw || '').replace(/\\/g, '/');

  // A directory entry carries no content; the directories are made from the
  // file paths instead, so these are dropped rather than refused.
  if (name.endsWith('/')) return null;

  if (!name || name === '.' || name === './') return null;

  // An absolute path, a Windows drive letter, or a UNC path. None of these
  // belong in an archive meant to be unpacked somewhere specific.
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.startsWith('\\\\')) {
    throw new ArchiveError(`The archive contains an absolute path: ${raw}`);
  }

  // A NUL byte truncates a filename in many C libraries, so "safe.txt\0.php"
  // can be two different names depending on who is reading it.
  if (name.includes('\0')) {
    throw new ArchiveError('The archive contains a file name with a null byte in it.');
  }

  // Resolve first, then check. "a/../../b" is only obviously wrong afterwards.
  const resolved = path.posix.normalize(name);
  if (resolved === '..' || resolved.startsWith('../') || resolved.includes('/../')) {
    throw new ArchiveError(`The archive tries to write outside itself: ${raw}`);
  }

  const clean = resolved.replace(/^\.\//, '');
  if (clean.split('/').length > LIMITS.depth) {
    throw new ArchiveError(`The archive nests deeper than ${LIMITS.depth} folders: ${raw}`);
  }

  return clean;
}

/// True for a zip entry that is a symbolic link.
///
/// The file type lives in the top four bits of the high half of the external
/// attributes, where Unix zips record st_mode. 0xA000 is S_IFLNK.
const isSymlink = (entry) => ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;

/// Reads a zip into `{ path, contents }` pairs.
///
/// Everything is held in memory, which is the right trade at these sizes: the
/// alternative is writing attacker-named files to disk before they have been
/// checked, and the checking is the entire point.
///
/// `defaultExclusions: false` drops the deploy list (.git, node_modules and
/// the rest) for the file manager, where unpacking a zip is the same act as
/// uploading what is in it and nothing should quietly go missing. The three
/// guards above are not options; they apply whatever is passed.
///
/// Folder entries are reported in `directories`, so an empty folder in the
/// archive can be made rather than lost.
export function readZip(buffer, { exclude = [], defaultExclusions = true } = {}) {
  const excluded = (relative) =>
    defaultExclusions ? isExcluded(relative, exclude) : matchesSegment(relative, exclude);

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (openErr, zip) => {
      if (openErr || !zip) {
        return reject(new ArchiveError('That does not look like a zip file, or it is damaged.'));
      }

      const files = [];
      const directories = [];
      const skipped = [];
      let totalBytes = 0;
      let seen = 0;
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        // Rejected before closing: closing can itself emit, and the reason
        // this failed is more useful than whatever the close does.
        reject(err);
        try {
          zip.close();
        } catch {
          // Best-effort; the rejection above is what matters.
        }
      };

      const done = () => {
        if (settled) return;
        settled = true;
        if (!files.length && !directories.length) {
          return reject(new ArchiveError('That archive has no files in it.'));
        }
        resolve({ files, directories, skipped, totalBytes });
      };

      // yauzl does its own path validation and rejects an escaping entry
      // before ever handing it to us — which is the right order, but it
      // reports it as a generic stream error. Its message is passed through
      // so the person uploading learns what is actually wrong with their
      // archive rather than that it "could not be read".
      zip.on('error', (err) => {
        const message = String(err?.message || '');
        if (/invalid relative path|absolute path|invalid characters/i.test(message)) {
          return fail(
            new ArchiveError(
              `The archive tries to write outside itself (${message}). ` +
                'Zip the contents of your site folder, not a path leading to it.',
            ),
          );
        }
        fail(new ArchiveError('That zip file could not be read.'));
      });
      zip.on('end', done);

      zip.on('entry', (entry) => {
        seen += 1;
        if (seen > LIMITS.entries) {
          return fail(new ArchiveError(`That archive holds more than ${LIMITS.entries} files.`));
        }

        if (isSymlink(entry)) {
          return fail(
            new ArchiveError(
              `The archive contains a symbolic link (${entry.fileName}). Links are refused: ` +
                'one can point outside the site and let a later file be written through it.',
            ),
          );
        }

        let relative;
        try {
          relative = safeEntryPath(entry.fileName);
          // A folder entry. Checked by the same rules as a file, by its
          // name without the slash, and kept so an empty folder survives.
          if (relative === null && /\/$/.test(String(entry.fileName || '').replace(/\\/g, '/'))) {
            const folder = safeEntryPath(String(entry.fileName).replace(/\\/g, '/').replace(/\/+$/, ''));
            if (folder && !excluded(folder)) directories.push(folder);
          }
        } catch (err) {
          return fail(err);
        }

        if (relative === null) return zip.readEntry();

        if (excluded(relative)) {
          skipped.push(relative);
          return zip.readEntry();
        }

        // The header's own figure, used only to refuse early. The real count
        // below is what the cap is enforced on.
        if (entry.uncompressedSize > LIMITS.fileBytes) {
          return fail(new ArchiveError(`${relative} is larger than ${LIMITS.fileBytes / 1024 / 1024} MB.`));
        }

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            return fail(new ArchiveError(`Could not read ${relative} out of the archive.`));
          }

          const chunks = [];
          let size = 0;

          stream.on('data', (chunk) => {
            size += chunk.length;
            totalBytes += chunk.length;

            // Counted as it arrives, so a header that lies about the size
            // buys nothing.
            if (size > LIMITS.fileBytes) {
              stream.destroy();
              return fail(new ArchiveError(`${relative} is larger than it claimed to be.`));
            }
            if (totalBytes > LIMITS.totalBytes) {
              stream.destroy();
              return fail(
                new ArchiveError(
                  `The archive unpacks to more than ${LIMITS.totalBytes / 1024 / 1024} MB. ` +
                    'If that is genuine, deploy it in parts.',
                ),
              );
            }
            chunks.push(chunk);
          });

          stream.on('error', () => fail(new ArchiveError(`Could not read ${relative} out of the archive.`)));
          stream.on('end', () => {
            files.push({ path: relative, contents: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });

      zip.readEntry();
    });
  });
}

/// Strips a single wrapping folder, if the whole archive sits inside one.
///
/// Downloading a zip from GitHub gives you "repo-main/index.html", not
/// "index.html", and deploying that would produce a site at /repo-main/. This
/// is what everybody expects to happen silently, so it does — but only when
/// there is exactly one top-level folder and nothing beside it, which is the
/// only case where the intent is unambiguous.
export function stripCommonRoot(files) {
  if (!files.length) return { files, stripped: null };

  const tops = new Set(files.map((f) => f.path.split('/')[0]));
  if (tops.size !== 1) return { files, stripped: null };

  const [top] = [...tops];
  // Every path must actually be inside it — a single file at the root called
  // "index.html" would otherwise be "stripped" into nothing.
  if (!files.every((f) => f.path.startsWith(`${top}/`))) return { files, stripped: null };

  return {
    files: files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) })),
    stripped: top,
  };
}
