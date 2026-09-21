// File access over FTP, FTPS and SFTP.
//
// One interface over two very different clients, so the routes and the UI never
// have to care which protocol a domain uses.
//
// Every path that arrives from the browser goes through `resolvePath`, which
// confines it beneath the configured root. Without that, "../.." in a path is
// an invitation to read the rest of the server.

import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';

const CONNECT_TIMEOUT_MS = 15000;

/// Largest file the text editor will open. Bigger files are still downloadable;
/// they are just not something to load into a textarea.
export const MAX_EDITABLE_BYTES = 512 * 1024;

export class StorageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/// Joins a browser-supplied path onto the root and refuses anything that climbs
/// out of it. Returns a POSIX path, because that is what both protocols speak.
export function resolvePath(root, requested = '/') {
  const base = path.posix.resolve('/', root || '/');
  const joined = path.posix.resolve(base, `.${path.posix.resolve('/', requested)}`);

  if (joined !== base && !joined.startsWith(`${base}/`)) {
    throw new StorageError('That path is outside the allowed directory.', 403);
  }
  return joined;
}

/// The path to show the user: relative to the root, so the root looks like "/".
export function toDisplayPath(root, absolute) {
  const base = path.posix.resolve('/', root || '/');
  if (absolute === base) return '/';
  return absolute.startsWith(`${base}/`) ? absolute.slice(base.length) : absolute;
}

function entryFrom({ name, isDirectory, size, modifiedAt, rawModifiedAt }) {
  // Only MLSD gives a real timestamp. Plain LIST gives strings like
  // "Sep 21 17:38", which `new Date()` happily misreads as the year 2001 — so
  // the raw text is passed through for display instead of being guessed at.
  const iso = modifiedAt instanceof Date && !Number.isNaN(modifiedAt.getTime())
    ? modifiedAt.toISOString()
    : null;

  return {
    name,
    type: isDirectory ? 'directory' : 'file',
    size: isDirectory ? null : (size ?? null),
    modifiedAt: iso,
    modifiedLabel: iso ? null : rawModifiedAt || null,
  };
}

// ---------------------------------------------------------------------------
// FTP / FTPS
// ---------------------------------------------------------------------------

async function connectFtp(settings, secure) {
  const client = new FtpClient(CONNECT_TIMEOUT_MS);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: settings.host,
      port: settings.port || 21,
      user: settings.username,
      password: settings.password,
      secure,
      // Hosting panels very often present a self-signed or mismatched
      // certificate. Refusing those would make FTPS unusable for the people
      // this is built for, so the connection is encrypted but unverified.
      secureOptions: secure ? { rejectUnauthorized: false } : undefined,
    });
  } catch (err) {
    client.close();
    throw new StorageError(friendlyConnectError(err), 502);
  }

  return {
    async list(dir) {
      const items = await client.list(dir);
      return items
        .filter((i) => i.name !== '.' && i.name !== '..')
        .map((i) =>
          entryFrom({
            name: i.name,
            isDirectory: i.isDirectory,
            size: i.size,
            modifiedAt: i.modifiedAt,
            rawModifiedAt: i.rawModifiedAt,
          }),
        );
    },
    async read(file) {
      // basic-ftp writes into a stream, so collect it into a buffer.
      const chunks = [];
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });
      await client.downloadTo(sink, file);
      return Buffer.concat(chunks);
    },
    async write(file, buffer) {
      await client.uploadFrom(Readable.from(buffer), file);
    },
    async mkdir(dir) {
      await client.ensureDir(dir);
    },
    async rename(from, to) {
      await client.rename(from, to);
    },
    async removeFile(file) {
      await client.remove(file);
    },
    async removeDir(dir) {
      await client.removeDir(dir);
    },
    async close() {
      client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

async function connectSftp(settings) {
  const client = new SftpClient();
  try {
    await client.connect({
      host: settings.host,
      port: settings.port || 22,
      username: settings.username,
      password: settings.password,
      readyTimeout: CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    throw new StorageError(friendlyConnectError(err), 502);
  }

  return {
    async list(dir) {
      const items = await client.list(dir);
      return items.map((i) =>
        entryFrom({
          name: i.name,
          isDirectory: i.type === 'd',
          size: i.size,
          modifiedAt: i.modifyTime ? new Date(i.modifyTime) : null,
        }),
      );
    },
    read: (file) => client.get(file),
    write: (file, buffer) => client.put(buffer, file),
    mkdir: (dir) => client.mkdir(dir, true),
    rename: (from, to) => client.rename(from, to),
    removeFile: (file) => client.delete(file),
    removeDir: (dir) => client.rmdir(dir, true),
    close: () => client.end(),
  };
}

/// Connection errors arrive as library-specific codes; turn the common ones
/// into something an operator can act on.
function friendlyConnectError(err) {
  const code = err?.code;
  if (code === 'ENOTFOUND') return 'The FTP host could not be found. Check the host name.';
  if (code === 'ECONNREFUSED') return 'The server refused the connection. Check the host and port.';
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(err?.message || '')) {
    return 'The server did not respond in time. Check the host, port and any firewall.';
  }
  if (/530|authentication|password/i.test(err?.message || '')) {
    return 'The server rejected these credentials. Check the username and password.';
  }
  return `Could not connect: ${err?.message || 'unknown error'}`;
}

/// Opens a connection for a domain's stored settings.
export async function openStorage(settings) {
  if (!settings?.host || !settings?.username) {
    throw new StorageError('FTP is not configured for this domain yet.', 400);
  }
  if (!settings.password) {
    throw new StorageError('No FTP password is stored for this domain.', 400);
  }

  const protocol = (settings.protocol || 'FTP').toUpperCase();
  if (protocol === 'SFTP') return connectSftp(settings);
  if (protocol === 'FTPS') return connectFtp(settings, true);
  return connectFtp(settings, false);
}

/// Runs `fn` against a connection and always closes it, so a thrown error
/// cannot leave a socket open against someone's server.
export async function withStorage(settings, fn) {
  const storage = await openStorage(settings);
  try {
    return await fn(storage);
  } finally {
    try {
      await storage.close();
    } catch {
      // Closing is best-effort; the operation's own result matters more.
    }
  }
}
