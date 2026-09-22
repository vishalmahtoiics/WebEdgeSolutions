// Reading a SQL statement well enough to say what it will do.
//
// This is the security-critical half of the query runner, so it lives on its
// own and is tested on its own. Everything downstream — whether a statement is
// allowed, whether it needs a typed confirmation — rests on getting this right.
//
// The naive version of this check is a regular expression over the raw text,
// and it is wrong in both directions:
//
//   SELECT 'drop table users'        would be flagged as destructive
//   SELECT 1; -- \n DROP TABLE users would slip past a leading-keyword check
//   /*!40101 DROP TABLE users */     is a comment to most readers and a
//                                    statement to MySQL
//
// So comments and string literals are removed first, and only then is the
// remaining text treated as keywords. Identifiers in backticks are swapped for
// placeholders, so a table honestly named `drop` cannot set anything off.

export class SqlError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/// What a statement does, in order of how much it can cost you.
export const KIND = {
  READ: 'read',
  WRITE: 'write',
  SCHEMA: 'schema',
  DESTRUCTIVE: 'destructive',
  BLOCKED: 'blocked',
};

/// Statements that reach past the database and at the server it runs on.
///
/// These are refused whatever the domain's write setting, because none of them
/// is part of managing a website's tables, and they are exactly the primitives
/// used to turn database access into filesystem or account access.
const BLOCKED = [
  { pattern: /\binto\s+(outfile|dumpfile)\b/i, why: 'writes a file onto the database server' },
  { pattern: /\bload\s+data\b/i, why: 'reads a file from the database server' },
  { pattern: /\bload_file\s*\(/i, why: 'reads a file from the database server' },
  { pattern: /^\s*grant\b/i, why: 'changes database account privileges' },
  { pattern: /^\s*revoke\b/i, why: 'changes database account privileges' },
  { pattern: /\b(create|drop|alter)\s+user\b/i, why: 'manages database accounts' },
  { pattern: /^\s*set\s+(global|password)\b/i, why: 'changes the server configuration' },
  { pattern: /^\s*(shutdown|flush|reset|kill)\b/i, why: 'acts on the database server itself' },
  { pattern: /^\s*use\b/i, why: 'switches to another database' },
  { pattern: /^\s*(create|drop)\s+database\b/i, why: 'creates or destroys a whole database' },
];

const READ_VERBS = ['select', 'show', 'describe', 'desc', 'explain', 'analyze', 'check'];
const WRITE_VERBS = ['insert', 'update', 'delete', 'replace'];
const SCHEMA_VERBS = ['create', 'alter', 'rename', 'comment'];
const DESTRUCTIVE_VERBS = ['drop', 'truncate'];

/// Strips what is not code, so what remains can be read as keywords.
///
/// Returns the reduced text plus the identifiers that were lifted out, so a
/// target table can still be recovered by index afterwards.
export function stripForAnalysis(sql) {
  const identifiers = [];
  let out = '';
  let i = 0;
  const text = String(sql ?? '');

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    // Line comments run to the end of the line. MySQL needs "--" followed by
    // whitespace; "#" needs nothing.
    if ((ch === '-' && next === '-' && /[\s]|^$/.test(text[i + 2] ?? ' ')) || ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      // A version-conditional comment is not a comment: MySQL executes what is
      // inside /*! … */ and /*+ … */. Keeping the contents is the whole point.
      const conditional = text[i + 2] === '!' || text[i + 2] === '+';
      if (conditional) {
        const end = text.indexOf('*/', i + 2);
        const inner = text.slice(i + 3, end === -1 ? text.length : end);
        // Drop the version number a /*!NNNNN prefix carries, keep the code.
        out += ` ${inner.replace(/^\d+/, '')} `;
        i = end === -1 ? text.length : end + 2;
        continue;
      }
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }

    // String literals become a placeholder, so their contents cannot be read
    // as keywords. Both doubling ('') and backslash escapes are honoured.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += "'?'";
      continue;
    }

    // A quoted identifier is a name, never a keyword. It is remembered so the
    // target of a DROP can still be reported.
    if (ch === '`') {
      i += 1;
      let name = '';
      while (i < text.length) {
        if (text[i] === '`') {
          if (text[i + 1] === '`') {
            name += '`';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        name += text[i];
        i += 1;
      }
      out += `__ID${identifiers.length}__`;
      identifiers.push(name);
      continue;
    }

    out += ch;
    i += 1;
  }

  return { text: out, identifiers };
}

/// Splits on the semicolons that really separate statements.
export function splitStatements(strippedText) {
  return strippedText
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const resolveIdentifier = (token, identifiers) => {
  if (!token) return null;
  const placeholder = token.match(/^__ID(\d+)__$/);
  if (placeholder) return identifiers[Number(placeholder[1])] ?? null;
  return token.replace(/[^\w$.]/g, '') || null;
};

/// Empties every parenthesised span, leaving only what is at the top level.
///
/// Without this, two things go wrong. A CTE hides the real verb — in
/// `WITH t AS (SELECT 1) DELETE FROM posts …` the first SELECT belongs to the
/// CTE and the statement is a DELETE. And a subquery hides the absence of a
/// WHERE — `UPDATE a SET x = (SELECT y FROM b WHERE c)` has no WHERE of its
/// own and so rewrites every row, while reading as though it were limited.
export function topLevel(text) {
  let out = '';
  let depth = 0;
  for (const ch of String(text ?? '')) {
    if (ch === '(') {
      depth += 1;
      if (depth === 1) out += '(';
      continue;
    }
    if (ch === ')') {
      if (depth === 1) out += ')';
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

const VERBS = /\b(select|insert|update|delete|replace|drop|truncate|create|alter|rename|show|describe|desc|explain|analyze|check|grant|revoke|set|use|load|shutdown|flush|reset|kill)\b/i;

/// The verb that decides what a statement is, and where its body starts.
///
/// Read off the top-level projection, so a CTE's own SELECT cannot stand in for
/// the statement's real verb.
function findVerb(projection) {
  const leading = projection.match(/^\s*([a-z_]+)/i)?.[1]?.toLowerCase() || '';

  if (leading && leading !== 'with') {
    return { verb: leading, index: projection.search(/\S/) };
  }

  // Past the CTE definitions now: the next top-level verb is the statement's.
  const after = projection.slice(projection.toLowerCase().indexOf('with') + 4);
  const hit = after.match(VERBS);
  if (!hit) return { verb: leading || '', index: 0 };

  return { verb: hit[1].toLowerCase(), index: projection.length - after.length + hit.index };
}

/// The table a statement is aimed at, for the confirmation prompt.
function targetOf(body, identifiers) {
  const patterns = [
    /^\s*drop\s+(?:temporary\s+)?table\s+(?:if\s+exists\s+)?([\w$.]+|__ID\d+__)/i,
    /^\s*truncate\s+(?:table\s+)?([\w$.]+|__ID\d+__)/i,
    /^\s*delete\s+(?:\w+\s+)?from\s+([\w$.]+|__ID\d+__)/i,
    /^\s*update\s+(?:ignore\s+)?([\w$.]+|__ID\d+__)/i,
    /^\s*alter\s+table\s+([\w$.]+|__ID\d+__)/i,
    /^\s*rename\s+table\s+([\w$.]+|__ID\d+__)/i,
    /^\s*insert\s+(?:ignore\s+)?(?:into\s+)?([\w$.]+|__ID\d+__)/i,
    /^\s*replace\s+(?:into\s+)?([\w$.]+|__ID\d+__)/i,
    /^\s*create\s+(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w$.]+|__ID\d+__)/i,
  ];
  for (const pattern of patterns) {
    const hit = body.match(pattern);
    if (hit) return resolveIdentifier(hit[1], identifiers);
  }
  return null;
}

/// Reads one statement and reports what running it would mean.
///
/// Throws when the text is not something this runner will accept at all —
/// several statements at once, or nothing.
export function classify(sql) {
  const { text: stripped, identifiers } = stripForAnalysis(sql);
  const statements = splitStatements(stripped);

  if (!statements.length) throw new SqlError('Enter a statement to run.');
  if (statements.length > 1) {
    throw new SqlError(
      `Run one statement at a time. ${statements.length} were found, separated by semicolons — ` +
        'running them together makes it much harder to see what each one did.',
    );
  }

  const one = statements[0];
  const projection = topLevel(one);
  const { verb: found, index } = findVerb(projection);
  const body = projection.slice(index);

  for (const rule of BLOCKED) {
    // Matched against the statement rather than the projection: a blocked
    // construct inside a subquery is still one that runs.
    if (rule.pattern.test(one) || rule.pattern.test(body)) {
      return {
        kind: KIND.BLOCKED,
        verb: found,
        target: null,
        reason: `This statement ${rule.why}, which is outside what a database tool should do from here.`,
      };
    }
  }

  const verb = found;
  const target = targetOf(body, identifiers);
  // Only a WHERE of the statement's own counts; one inside a subquery limits
  // the subquery, not the rows being changed.
  const hasWhere = /\bwhere\b/i.test(body);

  if (READ_VERBS.includes(verb)) {
    return { kind: KIND.READ, verb, target, reason: null };
  }

  if (DESTRUCTIVE_VERBS.includes(verb)) {
    return {
      kind: KIND.DESTRUCTIVE,
      verb,
      target,
      reason:
        verb === 'drop'
          ? `This deletes ${target ? `the table "${target}"` : 'a table'} and everything in it. It cannot be undone.`
          : `This empties ${target ? `the table "${target}"` : 'a table'}. Every row goes, and it cannot be undone.`,
    };
  }

  if (WRITE_VERBS.includes(verb)) {
    // A DELETE or UPDATE with no WHERE takes the whole table with it, which is
    // a different act from changing a few rows even though it reads the same.
    if ((verb === 'delete' || verb === 'update') && !hasWhere) {
      return {
        kind: KIND.DESTRUCTIVE,
        verb,
        target,
        reason:
          `This ${verb}s every row in ${target ? `"${target}"` : 'the table'} — there is no WHERE clause to limit it.`,
      };
    }
    return { kind: KIND.WRITE, verb, target, reason: null };
  }

  if (SCHEMA_VERBS.includes(verb)) {
    return {
      kind: KIND.SCHEMA,
      verb,
      target,
      reason: `This changes the structure of ${target ? `"${target}"` : 'the database'}.`,
    };
  }

  // Something unrecognised. Treated as a write rather than waved through: a
  // verb this code has never heard of is not a reason to assume it is harmless.
  return {
    kind: KIND.WRITE,
    verb: verb || 'unknown',
    target,
    reason: `"${verb || 'This'}" is not a statement this tool recognises, so it is treated as a change.`,
  };
}

/// Whether a statement returns rows, which decides how the result is shown.
export const returnsRows = (kind) => kind === KIND.READ;

/// Whether running it needs the target typed out first.
export const needsConfirmation = (kind) => kind === KIND.DESTRUCTIVE || kind === KIND.SCHEMA;
