# Hosting Management Portal

A lightweight hosting management portal: connect a hosting provider's API, test the
connection, sync domains into PostgreSQL, and manage domains, DNS, mailboxes,
users and resource allocations from one clean dashboard.

**Hostinger** is supported out of the box. The provider layer is pluggable, so
additional hosts can be added without touching the rest of the application.

- **Backend** — Node.js + Express, session authentication
- **Database** — PostgreSQL via Prisma ORM
- **Frontend** — plain HTML/CSS/JS (ES modules, no build step)

---

## Quick start

```bash
npm install
npm run setup     # creates .env, runs migrations, generates the client, seeds the admin
npm run dev
```

Then open <http://localhost:3000> and sign in with the credentials printed by the
seed step (`admin@example.com` / `Admin@12345` by default).

> Change the admin password from **Settings** straight after the first sign-in.

### Manual setup

If you prefer to run each step yourself:

```bash
cp .env.example .env      # then edit DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY
npm install
npx prisma migrate dev
npx prisma generate
npm run seed
npm run dev
```

### Prerequisites

- Node.js 18 or newer
- A PostgreSQL database you can connect to

Create one locally with:

```bash
createdb hostportal
psql -c "CREATE ROLE hostportal LOGIN PASSWORD 'hostportal';"
psql -c "ALTER DATABASE hostportal OWNER TO hostportal;"
psql -c "ALTER ROLE hostportal CREATEDB;"   # only needed for `prisma migrate dev`
```

---

## Deploying (Coolify, Railway, Render, Docker)

These platforms build with `npm ci` and then run `npm start` — there is no
separate release step. So `npm start` does the whole job: it waits for the
database, applies migrations, ensures a Super Admin exists, and then serves.
All three steps are safe to repeat on every restart.

Use `npm run start:server` instead if you handle migrations yourself, or set
`SKIP_MIGRATIONS=true`.

### Coolify, step by step

1. **Create a PostgreSQL database** in your Coolify project. Copy its
   connection string.
2. **Create an Application** from this repository and pick the branch to
   deploy. Coolify detects Node.js via Nixpacks; the `nixpacks.toml` in this
   repo adds the Prisma client generation step.
3. **Set the environment variables** below, then deploy.
4. **Open the app and sign in** with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then
   change the password from **Settings**.

### Required environment variables

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The connection string from step 1. Use the database's **service name** as the host, not `localhost`. |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` — must be exactly 64 hex characters. |
| `ADMIN_EMAIL` | The first Super Admin's email. |
| `ADMIN_PASSWORD` | Their initial password — change it after signing in. |
| `SECURE_COOKIES` | `true` if the site is served over **https**, `false` if over **http**. See below. |
| `PORT` | Optional; most platforms set this for you. |

Mark these **Runtime** variables. Coolify warns if `NODE_ENV=production` is
also available at build time, because it can skip devDependencies — this app
does not need devDependencies to build, but leaving `NODE_ENV` runtime-only
avoids the warning.

### Two things that commonly go wrong

**"Something went wrong. Please try again." when signing in.**
Almost always an un-migrated database: the `users` table does not exist yet.
Check the container log — it will say so and name the fix. If your platform
runs `node src/server.js` directly, change the start command to `npm start`
so migrations run first.

**Sign-in appears to do nothing, with no error.**
`SECURE_COOKIES=true` while the site is served over plain `http://`. The
browser discards a `Secure` cookie on an insecure connection, so the session
never sticks. The app now returns an explicit error saying exactly this
instead of failing silently. Either enable HTTPS or set `SECURE_COOKIES=false`.

### Health check

Point your platform's health check at `/api/health`, which returns
`{"ok":true}` without touching the database.


---

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `SESSION_SECRET` | yes | Signs session cookies. Generate with `openssl rand -hex 32`. |
| `ENCRYPTION_KEY` | yes | 64 hex characters (32 bytes) used to encrypt provider API tokens at rest. Generate with `openssl rand -hex 32`. |
| `PORT` | no | Defaults to `3000`. |
| `NODE_ENV` | no | Set to `production` when deploying. |
| `SECURE_COOKIES` | no | Set to `true` when serving over HTTPS. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | no | Used to create the first Super Admin on seed/first boot. |
| `SKIP_MIGRATIONS` | no | Set to `true` to stop `npm start` applying migrations and seeding. |

`npm run setup` generates real random values for `SESSION_SECRET` and
`ENCRYPTION_KEY` the first time it runs.

> Changing `ENCRYPTION_KEY` later makes existing provider tokens unreadable —
> you would need to re-enter them.

---

## Using the portal

1. **Providers / APIs → Add Provider** — choose Hostinger and paste your API
   token (hPanel → Account → API). The token is encrypted before it is stored.
2. **Test Connection** — calls the provider's API and reports success or the
   exact failure. The **Sync Domains** button unlocks only after a test passes.
3. **Sync Everything** — one click: imports domains, then the DNS zone and
   mailboxes for each one, all saved locally. **Sync Domains** does the domain
   list alone. Both are safe to repeat — domains are matched by name, so
   nothing is duplicated.
4. **Domains → Manage** — per-domain tabs for information, DNS records,
   mailboxes, and FTP/server details.
5. **Users** — create users, assign them specific domains, and set their
   resource allocation.

### Where data comes from

Every record is labelled so you always know its origin:

- `Hostinger` (or whatever you named the provider) — fetched from the API
- `Manually Added` — entered by an administrator

Nothing is invented. If the provider's API does not expose something, the portal
says so and lets you fill it in by hand rather than displaying placeholder data.

**Manual entries are never overwritten by a sync.** A domain you added by hand
is skipped during sync; a DNS record or mailbox you added or edited is kept
while the provider-sourced ones are refreshed.

---

## Provider capabilities

Each adapter declares what it can do, and the UI adapts. For Hostinger:

| Feature | Supported | Endpoint |
| --- | --- | --- |
| Domains | yes | `GET /api/domains/v1/portfolio`, `GET /api/hosting/v1/websites` |
| Domain details | yes | `GET /api/domains/v1/portfolio/{domain}` |
| DNS records | yes | `GET /api/dns/v1/zones/{domain}` |
| Email accounts | yes | `GET /api/mail/v1/orders` → `GET /api/mail/v1/orders/{orderId}/mailboxes` |
| Create / delete mailbox | yes | `POST` / `DELETE /api/mail/v1/mailboxes` — **changes the real account** |
| Change mailbox password | yes | `PATCH /api/mail/v1/mailboxes/{id}/password` |
| Forwarders, aliases, auto-replies, catch-all | read only | `GET /api/mail/v1/orders/{orderId}/…` |
| Servers (VPS) | yes | `GET /api/vps/v1/virtual-machines` |
| FTP / FTPS credentials | **no** | Not exposed by the API — configure manually per domain. |

Reference: [Hostinger API documentation](https://docs.hostinger.com/api-reference/overview).

### Adding another provider

1. Create `src/providers/<name>.js` exporting an adapter with a `key`, `label`,
   `capabilities`, and a `testConnection(token)` method. Implement whichever of
   `listDomains`, `getDomainDetails`, `listDnsRecords`, `listEmailAccounts` and
   `listServers` that provider supports.
2. Register it in `src/providers/index.js`.

Unimplemented methods degrade gracefully — the relevant panel falls back to
manual entry instead of erroring.

---

## Email management

Under **Domains → Manage → Emails** you can:

- **Create Mailbox** — creates a real mailbox on the hosting account. The local
  record is written only after the provider confirms, so the portal never lists
  a mailbox that does not exist.
- **Password** — sets a new mailbox password at the provider. The portal never
  stores mailbox passwords.
- **Track Manually** — records a mailbox that the portal should know about
  without touching the provider, for domains with no API-managed email.

Forwarders, aliases, auto-replies and the catch-all are read live from the
provider and shown read-only; they are managed in the provider's own panel.

### Two kinds of delete

These are deliberately separate, because they are very different acts:

| Action | Effect |
| --- | --- |
| **Remove from portal only** | Deletes the portal's record. The mailbox and its mail are untouched at the provider. |
| **Delete permanently** | Destroys the mailbox and every message in it at the provider. Requires typing the full address to confirm. Cannot be undone. |

A mailbox that exists only in the portal cannot be deleted at the provider —
the API rejects it rather than guessing what was meant.

Users can manage mailboxes on the domains assigned to them, and only those.

### Real values and custom ones

Each mailbox carries two figures for size and usage: **what the server reports**
and, optionally, **what a Super Admin decided to show**.

In **Edit**, every figure has its own checkbox:

- **ticked** — the real value from the server is shown, and it keeps updating on
  every sync;
- **unticked** — your own figure is shown instead. The real one is still stored
  underneath and still refreshed, so ticking the box again restores it.

The real value is always printed under the field, so you can see what the
server says even while displaying something else. A mailbox with an override is
marked **Custom** in the list.

Editing a mailbox no longer detaches it from the provider: the real numbers keep
tracking, and syncs update rows in place rather than deleting and recreating
them, so overrides and notes survive.

Normal users see only the effective figure — never the two apart.

> Mailbox usage is reported by Hostinger as `storageUsed` / `storageQuota` in
> **kilobytes**, and is converted to MB/GB for display.


---

## File manager

Once a domain has FTP details under **FTP & Server**, the **Files** tab browses
the site over FTP, FTPS or SFTP:

- browse folders, with breadcrumbs
- upload and download files
- create folders, rename and delete
- open small text files in an editor and save them back

**Root folder** is the important setting. Everything the file manager does is
resolved beneath it — usually `/public_html`. A path from the browser can never
climb above it: `../../etc/passwd` resolves back inside the root rather than
out of it, and the tests prove a file placed just outside stays unreachable.

Other limits worth knowing:

| | |
| --- | --- |
| Upload size | 25 MB per file |
| Editable as text | up to 512 KB; binary files are refused rather than mangled |
| Deleting the root | refused, so one click cannot wipe a site |

**Test Connection** on this tab checks the stored credentials the same way the
provider page checks an API token.

Assigned users get the file manager for their own domains. FTP credentials
themselves are Super Admin only — they point at a real server, and a user who
could edit the host could aim the portal somewhere it has no business going.

> FTPS connections are encrypted but the certificate is not verified, because
> hosting panels very often present a self-signed or mismatched one and
> refusing those would make FTPS unusable here.


---

## Webmail

A mailbox can be opened from inside the portal: **Open inbox** on any mailbox,
on the domain's Emails tab or the Emails page.

- read the inbox and other folders, paged newest-first
- open a message, with attachments to download
- reply, or compose a new message
- delete (moved to Trash where the server has one)

Two things are needed first, both under **FTP & Server**:

| Setting | Usual value |
| --- | --- |
| IMAP host / port | `imap.yourprovider.com` / `993` |
| SMTP host / port | `smtp.yourprovider.com` / `465` |

Then **Mailbox password** on the inbox page — the mailbox's own password, the
one used to sign in to webmail. It is encrypted before being stored, never sent
back to the page, and checked against the mail server before it is accepted, so
a typo is caught immediately rather than on the first attempt to read mail.

Nothing is cached: every action opens a connection, does its work and closes it,
so the portal never holds a stale copy of an inbox and never keeps a session
open against a mail server.

HTML messages are rendered in a sandboxed frame with no scripts and no access
to the portal, since a message body is somebody else's markup. The From address
is always the mailbox itself — the mail server would reject anything else.

Assigned users get webmail for mailboxes on their own domains.

### The standalone mail app

There is also a full mail client that people reach on its own hostname, with no
portal account at all: they go to the address, type their **email address and
the mailbox's own password**, and they are in.

Point a hostname at the same app and set `MAIL_HOST`:

```
MAIL_HOST=mails.yourdomain.com
```

That hostname then serves the mail client instead of the portal. Without it —
or before the DNS exists — the same app is at `/webmail` on the normal address.

The only setup it needs is the domain's IMAP and SMTP settings under **FTP &
Server**. Every mailbox on a domain that has those can sign in; no mailbox
password has to be saved in the portal, and none is.

What it does:

| | |
| --- | --- |
| Folders | Inbox, Sent, Drafts, Junk, Trash and any others, with unread counts |
| Reading | Paged newest-first, HTML or plain text, attachments to download |
| Search | Across sender, subject and body — the mail server does the matching, so it reaches past the page you are looking at |
| Writing | Compose, reply, reply-all and forward, with Cc, Bcc and up to 10 attachments of 15 MB each |
| Managing | Star, mark read or unread, move between folders, delete to Trash |
| On a phone | One pane at a time, with folders behind the menu button |

A sent message is filed to the Sent folder as a byte-identical copy of what
actually left the server. Bcc recipients receive it, but no Bcc header travels
with the message, so nobody on the To line learns who else got it.

Forwarding carries the original along as a `message/rfc822` attachment rather
than pasting its text, so formatting and its own attachments survive intact.

**About the password.** It is never written to the database as a mailbox
credential. It lives in the server-side session, encrypted with the application
key, and goes away when the session ends. A wrong address and a wrong password
give the same answer, so the sign-in page cannot be used to find out which
domains are hosted here. Sign-ins are rate limited.

HTML messages render in a sandboxed frame — no scripts, no access to the page
around them — and the app's content security policy blocks remote loads, so
tracking pixels never fire. The reader says so when a message contains images
it did not load.


---

## Roles and access

**Super Admin** manages everything: providers, all domains, users, and resource
allocations.

**User** sees only the domains assigned to them. Authorization is enforced in
the backend on every domain-scoped route, so changing an id in the URL returns
`404` rather than another user's data. Disabling an account revokes access
immediately, including any session already signed in.

### Users never see the provider

The portal is white-label for normal users. They see their domains, DNS and
mailboxes as facts about their own service — never which hosting company is
behind them, and never which rows came from an API rather than being typed in.

That is enforced in the API responses, not by hiding things in the browser:
a user reading the network tab learns nothing either. For a non-admin every
response omits the provider name, the adapter key, `sourceLabel`, `source`,
`isFromProvider` and the upstream record ids. Endpoint paths are named for what
they return rather than where the data comes from, and the Provider/Manual
columns are gone.

Instead of "Load from provider", a user gets one **Refresh** button per domain,
which reloads its DNS records and mailboxes. A test asserts that no response a
user can reach contains the provider's name.

> One honest limit: real DNS record *values* are shown as they are. If a
> domain's MX record points at `mx1.hostinger.com`, the user sees that — it is
> their own DNS data, and altering it would make the portal lie about their
> zone.

---

## Security

- Passwords hashed with bcrypt (cost 12).
- Provider API tokens, **FTP passwords and mailbox passwords** encrypted at rest with AES-256-GCM
  and **never** sent to the browser — the UI only ever sees the last four
  characters.
- Every file-manager path is confined beneath the domain's configured root.
- Sessions stored server-side in PostgreSQL; cookies are `httpOnly` and
  `sameSite=lax`, and `Secure` when `SECURE_COOKIES=true`.
- Session is regenerated on sign-in to prevent session fixation.
- All request bodies validated with zod.
- Rate limiting on the sign-in endpoint.
- Security headers and a strict Content-Security-Policy via helmet.
- No credentials are hard-coded; everything sensitive comes from the environment.

---

## Testing

With the app running (`npm run dev`) in another terminal:

```bash
npm test
```

Covers authentication, authorization boundaries, provider configuration,
credential handling, domain/DNS/email management, and the full sync flow
including the no-duplicates guarantee.

The adapter and sync suites run against a local stub that serves Hostinger's
documented response shapes, so they verify the integration without needing live
credentials.

---

## Project structure

```
prisma/
  schema.prisma        Database schema
  seed.js              Creates the first Super Admin
scripts/
  setup.js             One-command local setup
  start.js             Production entrypoint: waits for DB, migrates, seeds
src/
  server.js            Express app and middleware
  config.js            Environment configuration
  lib/                 Encryption, error helpers
  middleware/          Authentication, authorization, validation
  providers/           Pluggable provider adapters (hostinger.js)
  routes/              API endpoints
  services/            Provider credentials and sync logic
public/
  index.html           SPA shell
  css/app.css          Styles
  js/                  Frontend modules and views
public-mail/           The standalone mail app (served on MAIL_HOST, or /webmail)
  index.html           Shell
  css/mail.css         Styles
  js/                  Mail client modules
tests/                 Test suites
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run setup` | Full first-time setup. |
| `npm run dev` | Start with auto-reload. |
| `npm start` | Production start: waits for the database, migrates, seeds, then serves. |
| `npm run start:server` | Start the server only, without migrating or seeding. |
| `npm test` | Run the test suites. |
| `npm run seed` | Create the Super Admin (idempotent). |
| `npm run migrate` | Create and apply a migration. |
| `npm run studio` | Browse the database with Prisma Studio. |
