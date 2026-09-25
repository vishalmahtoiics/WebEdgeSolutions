// Writing a zip.
//
// The reading side lives in archive.js and is careful because its input is
// hostile. This side is the easy half: the portal writes the archive itself,
// from files it has just read off the site, so there is nothing to defend
// against beyond size — and the size is capped before anything is written.
//
// Plain zip, no ZIP64, which holds 65,535 entries and 4 GB. The caps below sit
// well inside both, so an archive this writes opens in every tool there is:
// Windows Explorer, macOS Archive Utility, unzip, and a hosting panel's own
// "Extract".

import { promisify } from 'node:util';
import zlib from 'node:zlib';

const deflateRaw = promisify(zlib.deflateRaw);

/// Caps on what one archive may hold. Everything is built in memory, so these
/// are what stop a "zip the whole site" on a very large site from taking the
/// container down with it.
export const ZIP_LIMITS = {
  totalBytes: 256 * 1024 * 1024,
  entries: 20000,
};

export class ZipLimitError extends Error {
  constructor(message) {
    super(message);
    this.status = 413;
  }
}

/// MS-DOS date and time, which is what a zip header holds. Two-second
/// resolution and nothing before 1980, which is the format's, not ours.
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/// Builds a zip from `{ path, contents, directory, modifiedAt }` entries.
///
/// Paths use "/" and are relative; a directory entry is written with a
/// trailing slash so an empty folder survives the round trip. Each file is
/// deflated, or stored as-is when deflating does not make it smaller — an
/// image or an existing zip gains nothing and costs time to unpack.
export async function buildZip(entries) {
  if (entries.length > ZIP_LIMITS.entries) {
    throw new ZipLimitError(`That is more than ${ZIP_LIMITS.entries} files to put in one zip.`);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;
  let total = 0;

  for (const entry of entries) {
    const directory = Boolean(entry.directory);
    const name = Buffer.from(directory ? `${entry.path.replace(/\/+$/, '')}/` : entry.path, 'utf8');
    const raw = directory ? Buffer.alloc(0) : entry.contents || Buffer.alloc(0);

    total += raw.length;
    if (total > ZIP_LIMITS.totalBytes) {
      throw new ZipLimitError(
        `That is more than ${ZIP_LIMITS.totalBytes / 1024 / 1024} MB to put in one zip. Select less at a time.`,
      );
    }

    const crc = zlib.crc32(raw) >>> 0;
    let method = 0;
    let data = raw;
    if (raw.length) {
      const deflated = await deflateRaw(raw);
      if (deflated.length < raw.length) {
        method = 8;
        data = deflated;
      }
    }

    const { time, date } = dosDateTime(entry.modifiedAt);
    // Bit 11: the name is UTF-8. Without it, a name with any non-ASCII
    // character in it arrives garbled on Windows.
    const flags = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Made by Unix, so the mode below is read as a Unix mode.
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number, internal attributes: all empty.
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // A plain file or folder, never a link: 0644 and 0755, plus the DOS
    // directory bit for tools that only look at that.
    const mode = directory ? 0o40755 : 0o100644;
    central.writeUInt32LE(((mode << 16) | (directory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}
