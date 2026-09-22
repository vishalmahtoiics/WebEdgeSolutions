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

Then open <http://localhost:3000/portal> and sign in with the credentials printed by the
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

## The public storefront

The root of the site is a public shop. Anyone can see what is for sale and order
it, with no account:

| | |
| --- | --- |
| `/` | The storefront — hosting plans, domain search, ordering, payment |
| `/portal` | The portal, for you and your customers |
| `/webmail` | The mail app, or `MAIL_HOST` if one is set |

> **The portal moved to `/portal` when the storefront took the root.** Nothing
> about it changed otherwise — it keeps its own routes in the URL hash, so the
> path it is served from is not part of its routing. Update any bookmark.

### What a Super Admin sets up

**Plans & Pricing** in the portal holds three things:

- **Hosting plans** — name, tagline, price, billing period, and the list of
  selling points that become the ticks on the public card. One can be flagged
  *Most popular*, and a "was" price shows struck through beside the real one.
- **Domain prices** — one row per ending, because a `.com` and a `.in` are
  genuinely different prices. Both the first-year and the renewal price are
  held, and the renewal is shown to customers so nobody is surprised a year
  later.
- **Storefront settings** — the business name, the headline, the support email,
  the **UPI ID** money arrives at, the payee name, and the WhatsApp number.

A plan can be hidden rather than deleted, and one with orders against it is
hidden automatically: an order has to keep saying what was bought.

### How buying works

1. A visitor picks a plan, or searches a name and picks an ending. The domain
   search prices every ending and asks the registry which are free — when no
   provider can answer, the prices still come back and availability reads
   *Unconfirmed* rather than the page failing.
2. They give a name, email and phone, and place the order. **The price is
   worked out on the server** from the plan or the ending; whatever the browser
   sent is ignored.
3. They get an order reference and a payment page: the UPI ID with a copy
   button, a `upi://pay` deep link that opens GPay or PhonePe with the amount
   and reference filled in, and a QR code for paying from another device.
4. They pay, then type the reference their app gave them.
5. You see it in **Orders**, check your bank account, and confirm it.

### UPI payments are not verified automatically

This is the part people assume works the other way round, so it is worth being
blunt: **a UPI transfer cannot report itself back to a website.** There is no
webhook. A reference a customer types is a claim, and anybody could invent one.

So the portal never marks an order paid on its own. An order moves to *Payment
reported* when the customer says they have paid, and only a person pressing
**I have received the money** moves it to *Paid* — and that records who pressed
it. The public site says the same thing in the same words, so no customer is
misled into thinking a confirmation is automatic.

If you later add a real gateway, it slots into the same order model and the
confirmation becomes automatic. Nothing else has to change.

### Order references

A reference is the only key the public lookup accepts, which makes it a bearer
token. So it is random rather than sequential — around 49 bits — and drawn from
an alphabet with both halves of each confusable pair removed (no O or 0, I or 1,
S or 5), because these get read out over the phone.

And what a reference opens is deliberately narrow: the plan, the amount, the
status and how to pay. **Not** the customer's name, email or phone number. A
reference will leak eventually; it should not take personal details with it.

### Bounds

Orders are limited to 10 per hour per address, domain searches to 40 per 15
minutes, payment reports to 20 per hour. The store can be closed with a switch,
which leaves the prices readable but takes no orders.

> Money is stored in paise as whole integers everywhere. ₹1,499.99 cannot be
> held exactly in binary floating point, and a rounding error in a figure
> somebody is asked to pay is not an acceptable class of bug.

---

## Provider capabilities

Each adapter declares what it can do, and the UI adapts. For Hostinger:

| Feature | Supported | Endpoint |
| --- | --- | --- |
| Domains | yes | `GET /api/domains/v1/portfolio`, `GET /api/hosting/v1/websites` |
| Domain details | yes | `GET /api/domains/v1/portfolio/{domain}` |
| DNS records (read) | yes | `GET /api/dns/v1/zones/{domain}` |
| DNS records (add / edit / delete) | yes | `PUT /api/dns/v1/zones/{domain}` — **changes real DNS** |
| Is a name free to register | yes | `POST /api/domains/v1/availability` |
| Email accounts | yes | `GET /api/mail/v1/orders` → `GET /api/mail/v1/orders/{orderId}/mailboxes` |
| Create / delete mailbox | yes | `POST` / `DELETE /api/mail/v1/mailboxes` — **changes the real account** |
| Change mailbox password | yes | `PATCH /api/mail/v1/mailboxes/{id}/password` |
| Forwarders, aliases, auto-replies, catch-all | read only | `GET /api/mail/v1/orders/{orderId}/…` |
| Servers (VPS) | yes | `GET /api/vps/v1/virtual-machines` |
| FTP / FTPS credentials | **no** | Not exposed by the API — configure manually per domain. |
| Database credentials | **no** | Not exposed by the API — configure manually per domain. |
| What a site is built on | **no** | Not in the API — detected from the site's files or homepage. |
| Nameservers, domain lock, WHOIS privacy | read only | `GET /api/domains/v1/portfolio/{domain}` |

Reference: [Hostinger API documentation](https://docs.hostinger.com/api-reference/overview).

### Adding another provider

1. Create `src/providers/<name>.js` exporting an adapter with a `key`, `label`,
   `capabilities`, and a `testConnection(token)` method. Implement whichever of
   `listDomains`, `getDomainDetails`, `listDnsRecords`, `listEmailAccounts`,
   `createDnsRecord`, `updateDnsRecord`, `deleteDnsRecord`,
   `checkDomainAvailability` and `listServers` that provider supports.
2. Register it in `src/providers/index.js`.

Unimplemented methods degrade gracefully — the relevant panel falls back to
manual entry instead of erroring.

---

## DNS

The DNS tab lists a domain's records, and every row says **where** it lives:

| | |
| --- | --- |
| **Live** | In the zone the internet resolves. Editing it changes real DNS. |
| **Portal only** | Kept here as a note. It resolves nowhere, and a zone reload will not overwrite it. |

Adding, editing and deleting a Live record goes to the provider for real. The
reply always says which happened, so a toast reading "Added A blog to the live
DNS zone" is a different event from "Record saved", and you can tell them apart
without guessing.

### Why a DNS edit is careful here

Hostinger has no per-record endpoint. A zone is replaced whole
(`PUT /api/dns/v1/zones/{domain}`), so "add one record" is really read the zone,
change one thing, write it all back. That is the one operation in this portal
that can destroy data it was never asked to touch, so four things guard it:

1. **Nothing is normalised on the way through.** The upstream objects are
   deep-cloned and only the group being edited is rebuilt. MX priorities, and
   any field Hostinger sends that this portal has never heard of, survive the
   round trip. There is a test that asserts exactly this.
2. **The record count must match the edit.** An add must produce exactly one
   more record than was read, a delete exactly one fewer, an edit the same
   number. Anything else is refused with the zone untouched — which catches a
   zone-wipe as a special case, while still allowing you to deliberately delete
   the last record in a zone.
3. **An empty read is treated as a failed read, not an empty zone.** A missing
   zone legitimately reads as empty. But if a live zone 404s transiently,
   "read empty, add one record, write" would replace real DNS with a single
   record. So each write says how many records the portal already believes are
   up there, and a read that contradicts that is refused.
4. **The zone is read back after every write.** A provider that accepts a write
   and changes nothing is otherwise indistinguishable from one that worked. If
   the zone does not show the change, you are told so rather than shown a
   success message.

MX and NS deletions say what they will break — email stopping, or the domain
ceasing to resolve — before you confirm.

> TTL belongs to the (name, type) group upstream, not to the individual value.
> Giving a new TTL to a name that already has records moves them all, so the
> reply says how many it moved.

---

## Is a name free to register

**Domains → Check availability** (Super Admin only) checks a name across
endings through whichever connected provider can answer.

The registry's answer is passed through as it comes, including **Not sure**
when it does not answer clearly — telling someone a taken name is free is a
worse failure than admitting the registry was silent. A name already in the
portal is labelled as such rather than as available, and a restriction the
registry reports (premium, reserved) is shown verbatim.

Checking reserves nothing. **Add to portal** only saves retyping the name — you
still register it with a registrar yourself.

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

## What a site is built on

Every domain shows the technology behind it — WordPress, Laravel, a hand-built
static site — on the domains list and on its own page.

**The provider API does not report this.** Hostinger's websites endpoint returns
a domain, a hosting username and an order id, and nothing about the platform. So
this is worked out for real, from one of three places, and the answer always
carries the evidence that produced it:

| Where | What it reads | Shown as |
| --- | --- | --- |
| **Files** | The site's own filesystem, over the FTP or SFTP credentials already stored. `wp-config.php` in the web root is not an inference; `wp-includes/version.php` gives the exact release. | Confirmed |
| **Site** | The homepage, for domains with no file access saved: the generator tag, the asset paths, and response headers like `x-shopid` or `x-drupal-cache`. | Confirmed for a generator tag, otherwise Likely |
| **By hand** | Whatever a Super Admin types. | Set by your administrator |

Files are tried first because they prove it; the homepage is the fallback. A
domain with neither says so, naming what it tried, rather than showing a blank.

Recognised from the filesystem: WordPress, Drupal, Joomla, Magento, PrestaShop,
OpenCart, Laravel and Next.js, each with its version where the install records
one, plus plain PHP and static sites. From the homepage, also Shopify, Wix,
Squarespace, Webflow, Ghost, TYPO3, Hugo, Jekyll and Gatsby.

Detection runs inside **Sync Everything** and inside **Refresh**, so it keeps
itself current, and there is a **Detect now** button for checking on the spot.
It never fails either action: a site that is down or an FTP password that has
gone stale leaves the previous answer alone and only moves the "last checked"
time.

### Overriding it

A Super Admin can set the technology by hand, the same way mailbox figures work:
detection writes only the detected columns, so an override survives every later
sync, and clearing it reveals the detected value again unchanged. While an
override is showing, the admin's own view says what detection last found.

Users see the technology for their own domains, because it describes their
website. They do not see the override controls, and nothing in the answer names
a hosting provider.

> The portal only ever fetches public host names over http or https. Addresses
> that are not on the public web — IP literals, `localhost`, `.local`,
> `.internal` — are refused, redirects are capped at three, and no more than
> 256 KB of a page is read.

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

## Database (SQL)

Each domain can have a **Database** tab: tables, rows, structure, exports, a row
editor and a SQL query editor, over MySQL or MariaDB.

**The provider API does not hand out database credentials**, so these are
entered by hand under **FTP & Server** — host, port, database, user, password —
exactly as FTP is. The password is encrypted at rest (AES-256-GCM) and never
sent to the browser; the page only ever learns that one is stored.

> **Remote MySQL is the prerequisite, and the usual reason this fails.** Shared
> hosting blocks database connections from outside by default. Add the portal
> server's IP under *Remote MySQL* in your hosting control panel, or nothing
> here will connect. The error message says this rather than reporting a bare
> timeout, because that is the answer nine times out of ten.

| | |
| --- | --- |
| Tables | Name, engine, size, and the engine's row estimate (marked as an estimate) |
| Browse | Paged rows, search across every column, sort by any column |
| Structure | Columns, types, keys, indexes, and an exact row count |
| Query | One statement at a time, results capped at 500 rows |
| Rows | Edit or delete a single row, by primary key |
| Export | The whole table as CSV or as INSERT statements, streamed |

### Writes are off until you turn them on

`Allow statements that change data` is a per-domain switch, off by default. With
it off the query editor runs only SELECT and SHOW. With it on, anyone who can
reach that domain — including an assigned user — can INSERT, UPDATE, DELETE and
DROP for real, with no undo. Only a Super Admin can move the switch: a user who
could grant themselves writes would not be limited by it.

### How a statement is read before it runs

A query editor is the most dangerous thing in this portal, because two
statements can look almost identical and cost wildly different amounts.
`DELETE FROM orders WHERE id = 5` and `DELETE FROM orders` differ by six
characters and by a whole table. So the editor asks the server what a statement
means as you type, and shows the verdict — *Reads data*, *Changes data*,
*Destroys data*, *Not allowed* — on the button itself.

Getting that verdict right is not a matter of pattern-matching the raw text.
Comments and string literals are removed first, and only what remains is read
as keywords, which is what makes these come out correctly:

| Statement | Read as | Why a naive check gets it wrong |
| --- | --- | --- |
| `SELECT 'drop table users'` | Reads data | The keyword is inside a string |
| ``SELECT * FROM `drop` `` | Reads data | The keyword is a table's name |
| `SELECT 1; -- x`⏎`DROP TABLE users` | Refused | Two statements, the second hidden behind a comment |
| `/*!40101 DROP TABLE users */` | Destroys data | MySQL executes this; it only looks like a comment |
| `WITH t AS (SELECT 1) DELETE FROM posts …` | Changes data | The first `SELECT` belongs to the CTE, not the statement |
| `UPDATE a SET x = (SELECT y WHERE z)` | Destroys data | The `WHERE` is the subquery's, so every row changes |

Three more rules hold throughout:

- **One statement at a time**, enforced in the classifier and again at the
  protocol (`multipleStatements: false`), so a query box cannot become several.
- **A destructive or structural statement needs its table typed out** before it
  will run. A wrong name does not count.
- **Statements that reach past the data are refused outright**, whatever the
  write setting: `INTO OUTFILE`, `LOAD DATA`, `LOAD_FILE()`, `GRANT`,
  `CREATE USER`, `SET GLOBAL`, `USE`, `DROP DATABASE`. None is part of managing
  a website's tables, and they are the primitives that turn database access
  into server access.

### The statement log

Every statement that changed something is recorded with who ran it, when, and
what it targeted — written *before* it runs, so one that takes the connection
down with it still leaves a trace. Reads are not logged; they are the ordinary
case and would bury the entries that matter. Super Admin only, since it is a
record of everyone's actions.

### Bounds

A statement is stopped by the server after 15 seconds. Results are capped at
500 rows, streamed so a `SELECT *` over a large table cannot be pulled into
memory whole; a truncated result says it was truncated. Identifiers are never
interpolated from a request — a table or column name is checked against what
the server itself reports before it reaches a statement — and values are always
bound as parameters.

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

```bash
npm test
```

Nothing needs to be running first — each suite starts its own server on its own
port. Set `TEST_BASE_URL` to aim the end-to-end suite at a server you are
already running instead, which is useful against a deployment.

Covers authentication, authorization boundaries, provider configuration,
credential handling, domains, DNS, email, files, webmail, technology detection
and the database tools, plus the full sync flow including the no-duplicates
guarantee.

**What runs against something real, and what runs against a stub:**

| Suite | Runs against |
| --- | --- |
| Files | A real FTP server (`ftp-srv`), including path-traversal attempts |
| Webmail and the mail app | A real IMAP server (`hoodiecrow-imap`) and a real SMTP server (`smtp-server`) |
| Technology detection | A real FTP server holding real WordPress, Laravel, Next.js, static and PHP trees, plus a real HTTP server serving the markup those platforms send |
| Database | A real MySQL or MariaDB server |
| Hostinger adapter, sync, DNS writes | A local stub serving Hostinger's documented response shapes |

The provider suites use a stub because Hostinger's API cannot be reached from a
test run without live credentials. Everything else talks to a real server of
the kind it will face in production.

The database suite needs a MySQL or MariaDB server on the usual socket. Without
one those tests **skip** rather than fail, so `npm test` still passes on a
machine that has no database engine beyond the portal's own Postgres. Point it
elsewhere with `TEST_MYSQL_SOCKET`. On Debian or Ubuntu:

```bash
apt-get install -y mariadb-server && service mariadb start
```

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
  lib/                 Encryption, storage, mail, SQL, DNS zones, detection, helpers
  middleware/          Authentication, authorization, validation
  providers/           Pluggable provider adapters (hostinger.js)
  routes/              API endpoints
  services/            Provider credentials and sync logic
public-store/          The public storefront, served at /
  index.html           Shell
  css/store.css        Styles
  js/                  Storefront, ordering and payment
public/                The portal, served at /portal
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
