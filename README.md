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
| `NOTIFY_BURST_LIMIT` | no | Alerts allowed per ten minutes before the rest are summarised. Defaults to `30`. |
| `SCHEDULER_TICK_MS` | no | How often the portal checks whether an overnight job is owed. Defaults to five minutes; there is rarely a reason to change it. |
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
| `/mails` | The mail app. Also at `/mail` and `/webmail`, and on `MAIL_HOST` if one is set |

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

There is also a full mail client that people reach with no portal account at
all: they go to the address, type their **email address and the mailbox's own
password**, and they are in.

**On the main site** it answers at three paths, all serving the same app:

```
yourdomain.com/mails      ← the one to give people
yourdomain.com/mail       ← because half of them will type this
yourdomain.com/webmail    ← the original address, still working
```

**On a hostname of its own**, point a subdomain at the same app and set
`MAIL_HOST`:

```
MAIL_HOST=mails.yourdomain.com
```

That hostname then serves the mail client from its root instead of the
storefront. It is the nicest address to hand out, but nothing depends on it:
the paths above keep working whether the subdomain exists or not.

The only setup it needs is the domain's IMAP and SMTP settings under **FTP &
Server**. Every mailbox on a domain that has those can sign in; no mailbox
password has to be saved in the portal, and none is.

### When somebody cannot sign in

Webmail tells the person at the door almost nothing — "check the address and
password" — because whether a domain is hosted here is not a stranger's
business. That is right, and on its own it left *you* with no way to tell a
wrong password from an IMAP host that was never filled in. Two things answer
that:

**Test a mailbox sign-in**, at the bottom of **FTP & Server**. Type a mailbox
address and its password and it runs the same sign-in the mail app runs,
against the same servers, and reports what the server actually said — separately
for reading and for sending, with the host and port it used. The password is
used for the test and never stored. Super Admin only: it is a small oracle on
somebody's password, so it is not left open to every account.

**The activity log.** Every failed webmail sign-in is recorded with the real
reason, under **Alerts & Activity**. Four things it tells apart:

| What the log says | What to do |
| --- | --- |
| No domain called *x* exists in this portal | Add the domain, then fill in its mail settings |
| *x* has no IMAP host saved | Fill in IMAP host and port under FTP & Server |
| The mail server rejected the password | The settings are fine — it is the password, the address, or a mailbox that does not exist |
| The mail server could not be reached | Wrong host, wrong port, or encryption set the wrong way |

That last one is also told to the person signing in, in those words. It used to
come out as a generic failure, which sent them off to change a password that
was never the problem. Saying it does reveal that the address's domain is
configured here — a fair trade, since anyone can read a domain's MX records,
and the alternative is a customer resetting their password over and over while
a server sits unreachable.

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

## Change alerts

**Alerts & Activity** in the portal tells you by email whenever somebody changes
something. Set your own SMTP server there, say who to tell, and choose which
areas are worth hearing about.

| Area | What triggers it |
| --- | --- |
| DNS | A record added, changed or deleted **in a live zone**. A portal-only note is not a change to the internet, so it is not alerted on. |
| Mailboxes | A mailbox created or permanently deleted, or its password changed. |
| Files | A file or folder deleted through the file manager. |
| Database | A `DROP`, `TRUNCATE` or other statement that changes structure. Not every `INSERT` — that would bury the one that mattered. |
| Accounts | A portal account created or deleted. |
| Settings | Connection details changed, or these notification settings changed. |
| Orders | A new order from the public site, or a customer reporting a payment. |
| Sign-in failures | Somebody trying passwords against your portal. |

Subjects are written to be read on a phone: *"Deleted a MX record from the live
DNS zone — this can break email on example.com"* says the consequence before you
have opened anything.

### An alert never costs you the action

A change is written to the activity log **first** and emailed **second**, in the
background, after the response has already gone out. Nothing on the email side
can travel back into the request. So:

- A mail server that is down, slow, or rejecting costs you the alert — never the
  record, and never the action. Somebody deleting a DNS record does not see an
  error because an SMTP host stopped answering. There is a test that points the
  portal at a server which refuses every connection and checks the work still
  happens.
- Nobody waits through an SMTP handshake to find out their file saved.
- When a send fails, the reason is stored on the entry and the page shows a
  count of undelivered alerts — so *"I never got an email"* has an answer.

### The activity log is the product

Email is one way of reading it. The log works whether or not a mail server is
ever configured, records who did what in words (so an entry still reads
correctly after that account is deleted), and can be filtered by area.

### Bounds

At most 30 alerts go out in any ten minutes; past that one message says how many
are being held back, and everything is still recorded. Raise it with
`NOTIFY_BURST_LIMIT` if your portal is busier than that. A test email is limited
to 10 per ten minutes, because it sends real mail through somebody's server.

> Failed sign-ins record the address that was tried. The password never is —
> not in the log, not in the email.

> The SMTP password is encrypted at rest and never sent to the browser, which
> only learns that one is stored.

---

## Deploying a website

The **Deploy** tab on a domain puts a website onto the hosting account: upload
a `.zip`, or give a public git URL, and the files are written into the web root
over the FTP, FTPS or SFTP connection already stored for that domain.

**It uploads files. It does not run anything.** No build step, no install, not
one line of the code being deployed. That is not an omission — running a
customer's build here would run their code with this process's access to the
database and to every provider token and FTP password it holds. A build step is
a reasonable thing to want and it needs a sandbox; until there is one, this
refuses to pretend. Deploy a finished site: plain HTML, PHP, WordPress, or the
contents of your `dist` / `build` folder after you have built it on your own
machine.

**Preview, then deploy.** The plan is worked out and shown first — how many
files are new, changed, deleted or unchanged, with the paths. The deploy button
stays disabled until a preview has been run, and any change to the form
disables it again, because "this will delete 412 files" is only useful before
the event.

**Every deploy can be undone.** Whatever is about to be overwritten or deleted
is moved aside into `.portal-backups/` first — moved, not copied, because a
rename costs no bandwidth, which is what makes backing up affordable enough to
do every single time. The record says exactly which files were created and
which were moved where, so rolling back is deleting the first list and moving
the second one back rather than a guess. The last five backups are kept.

**Two modes.** By default a deploy only adds and replaces. Tick *Replace the
site* to also delete what is on the server but not in your source — and list
the paths to keep, for the folders a customer writes to. A plan that would
delete almost everything and put back almost nothing is refused outright, with
an override for somebody who means it: that is what a zip built from the wrong
folder looks like from here, and it is a far more common way to destroy a
website than anything an attacker does.

**A second deploy of a large site takes seconds.** Each deploy records a
fingerprint of what it wrote, so a file whose content has not changed is not
sent again. A file edited directly on the server will look unchanged to that
comparison — *Upload everything again* is for exactly that case.

### What an archive is not allowed to do

A zip is not data, it is a set of instructions for writing files, and the
instructions come from outside. Three of them are attacks old enough to have
names, and all three are refused:

| | |
| --- | --- |
| **Zip Slip** | An entry called `../../../../etc/passwd` is a legal zip entry. Every path is resolved and *then* checked to be inside the destination — after resolving, because `a/../../b` only looks safe before. |
| **Zip bombs** | A megabyte of zip can hold a terabyte of zeroes. The header is not trusted: the uncompressed size is counted as it is read, and reading stops the moment the running total passes the cap. |
| **Symlinks** | A zip can carry a link pointing at `/etc`, and a later entry can then write *through* it. Links are refused outright — this deploys websites, and nothing here needs one. |

Also refused: absolute paths, Windows drive letters, filenames containing a
null byte, and anything nesting more than 24 folders deep.

And some files never reach a web root whatever the archive says — `.git`,
`node_modules`, `.DS_Store`, and every form of `.env`. That last one matters
most: a stray `.env` in a public directory publishes the database password of
whoever owns the site, and it is served as plain text by every default Apache
and nginx configuration.

Only `https://` repository URLs are accepted, and only without credentials in
them: a token in a URL ends up written into the deployment record and into
every log line of the clone, which is how tokens leak. Private repositories
need a stored credential with its own encryption — a later feature, not
something to smuggle in through a text field.

## Overnight jobs

Two things can happen on their own, once a day, and both are off until you
switch them on under **Alerts & Activity → Overnight jobs**.

**Nightly sync** pulls every provider's domains, DNS records, mailboxes and
detected technology, so the portal is current in the morning without anyone
pressing Sync Everything. One provider failing does not stop the others.

**Domain expiry reminders** warn before a domain lapses. You set the ladder —
`30,15,7,1` by default — and each step sends one email as the domain passes it.
Optionally the customer assigned to the domain is emailed too, in different
words: yours says which domain and how long, theirs says what stops working and
to get in touch.

Three properties are worth knowing, because they are what make this safe to
leave running:

**It runs once a day, not once a tick.** What decides that is the recorded time
of the last run, so a container redeployed four times before lunch still syncs
once.

**It catches up.** A machine that was off at 2am runs the job when it comes
back rather than skipping a day in silence. A missed sync is the case this
exists for.

**A warning is never repeated.** Each reminder is keyed on the domain, the
ladder step and the expiry date. That last part is what makes renewals work
with no code to reset anything: renewing moves the date, so the whole ladder
becomes due again for the new one.

The hour is stored with a timezone offset rather than read from the host clock,
because the host is usually a container running in UTC while the person who
said "2am" meant 2am where they live. The page shows each job's last run, what
it did, how long it took and when it will next run — a switch that has been on
for a month while every run failed looks exactly like one that is working, so
the last result is shown rather than the switch.

You can also press **Run now** on either job. It takes the same lock as the
scheduler, so pressing it while last night's run is still going does not start
a second one.

## Two-factor authentication

The Super Admin account can reach every DNS zone, database, mailbox and FTP
login the portal manages. One password is not a proportionate defence for that,
so **Settings → Two-factor authentication** adds a six-digit code at sign-in.

It works with Google Authenticator, Microsoft Authenticator, Authy, 1Password
or anything else that implements RFC 6238 — the implementation is checked
against the specification's own test vectors, so every one of them agrees with
it.

Setting it up shows a QR code, and the QR is drawn on your own server: the
shared secret never travels to a third-party chart service, which is how this
leaks in other systems. **Nothing is saved to the account until you enter a
working code from the app**, so a badly scanned QR or a tab closed halfway
leaves you exactly where you were rather than locked out by a security feature.

You then get ten **recovery codes**, shown once. Only a fingerprint of each is
stored, so the portal genuinely cannot show them again — not to you, and not to
anyone who has the database. Each works once, and using one is recorded along
with how many are left.

A few details that matter:

- The secret is encrypted at rest, like every other credential here.
- A code that has been used cannot be used again inside its thirty-second
  window, so somebody who reads it over your shoulder gets nothing.
- The password alone produces a *pending* sign-in, not a session. It expires
  after five minutes, and expires into nothing rather than into access.
- Turning it off, or reissuing recovery codes, asks for your password again —
  walking up to an unlocked screen is not enough to remove it.
- A wrong code is alerted on separately from a wrong password: somebody who has
  the password and is working on the second factor is a different, more urgent
  situation.

## Invoices and quotations

**Invoices & Quotes** raises both, with or without GST, and numbers them per
financial year: `INV/2026-27/0001`.

Fill in your registered name, address, state code and GSTIN under **Plans &
Pricing → Business details** first. That is deliberately separate from the
storefront's marketing name, because the name a website uses is very often not
the name a tax document has to carry.

**With GST**, the tax splits by the two state codes: CGST + SGST within your
state, one IGST line across a border. A customer's own GSTIN fills their state
in by itself, since the first two digits of a GSTIN are the state code.

**Without GST**, the document is issued as a bill of supply and says so on its
face. That is not a degraded mode — it is what a business below the
registration threshold is supposed to issue. If you have not saved a GSTIN,
this is what you get, rather than a tax invoice claiming a number you do not
have.

Prices can be entered tax-exclusive or tax-inclusive. Inclusive prices are
worked backwards rather than multiplied down: at 18%, ₹118 holds exactly ₹100
of value and ₹18 of tax, and the total is what you typed, to the paisa.

Every amount is a whole number of paise, never a float, and the arithmetic is
tested over every combination of rate, quantity, discount and rounding to check
the lines always reconcile with the totals. A discount is split across the
lines in amounts that add back to exactly the discount, because each line is
taxed at its own rate.

A **quotation converts into an invoice** without changing the quotation: the
two point at each other, and what you offered stays exactly as it was offered.
Payments can be partial — the balance stays on the invoice, and it is only
marked paid when the whole amount is there. An invoice that has been issued
cannot have its figures edited, and a cancelled one keeps its number: a gap in
a series is ordinary, a repeat is a problem at assessment time.

**On PDFs, plainly:** nothing here generates a PDF file. The document page is
laid out to be printed, and **Print / Save as PDF** is your browser producing
the file. Emailing a document sends the lines and totals as text, and says so —
claiming an attachment and sending a text body would be a small lie that costs
trust the first time somebody looks.

## Support tickets

Customers open tickets from **Support**, and every message stays in the thread
so a month later you can see what was asked and what was answered.

The moment a ticket is opened you are emailed it in full, and the customer gets
an acknowledgement with a reference to quote. Your replies are emailed to them;
theirs are alerted to you. **Internal notes** are yours alone — excluded by the
query rather than hidden in the interface, so they are not one API call away
from being read by the person they were written about. A note does not email
the customer and does not change who the ticket is waiting on.

The ticket is saved before anything is sent, so a mail server that is down
costs you the notification and never the customer's message.

## How it looks

Three front ends — the storefront, the portal and the mail app — share one
design language, served once from `/shared`. A customer who buys on the public
site and then signs in should not feel they have been handed to somebody else.

**Light and dark**, with a switch in the top bar of all three. It follows the
operating system until somebody chooses for themselves, and the choice is
remembered per browser. Dark is a real theme rather than an inversion: the
surfaces are a deep blue-black, the borders lift instead of darkening, and the
brand colour is lightened because the daytime violet goes muddy on a dark
field. The theme is decided by a small script in `<head>`, above the
stylesheet, so a dark-mode visitor never sees a white flash — and it is a
classic script rather than a module precisely because modules are deferred
until after parsing, which is exactly too late.

**Two typefaces, self-hosted.** Space Grotesk for headings, because it has a
face; Inter for everything else, because it is the best screen text there is
and it has proper tabular figures, which a table of money needs. Both are
variable fonts subset to Latin plus the punctuation and symbols this product
actually prints — the rupee sign, the arrows, the tick. 99 KB for the pair,
against 345 KB for the unsubset Inter alone. They are served from this server
rather than a font CDN: the Content-Security-Policy here allows `'self'` and
nothing else, and it also means no third party is told who is reading your
invoices.

**Motion is a layer, never a requirement.** Everything that moves is either an
entrance or a response to something a person did. Nothing loops in the corner
of the eye except the drifting light behind the hero and the sign-in screens,
which is slow enough to be noticed only if you look for it. Pages rise into
place, lists arrive one item after another, primary buttons catch a single
sweep of light on hover, and a button waiting on the network turns into a
spinner without changing width.

The whole system switches itself off for anyone whose computer asks for less
movement — off, not reduced, because somebody who sets that preference often
does so because movement makes them ill:

```css
@media (prefers-reduced-motion: reduce) { /* every animation and transition */ }
```

**Loading shows a skeleton**, not the word "Loading". It says what is coming
and it holds the height, so the content does not shove the page around when it
arrives.

Everything is built for a phone first, because most people arriving at a
hosting site from a WhatsApp link are on one. The portal's rail slides over
the content, the mail app becomes two screens joined by a back button, and the
invoice line editor stops being a six-column grid and becomes a stack.

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

Covers authentication, two-factor sign-in, authorization boundaries, provider
configuration, credential handling, domains, DNS, email, files, webmail,
technology detection, the database tools, GST invoicing, support tickets,
website deploys and the overnight jobs, plus the full sync flow including the
no-duplicates guarantee.

**The suites run one at a time**, which is why `npm test` passes
`--test-concurrency=1`. They share one database and one row of application
settings, so a suite that switches alerts off to check the default would
otherwise be doing it while another has just switched them on. Running a
single file during development is still quick:

```bash
npm run test:file tests/billing.test.js
```

**What runs against something real, and what runs against a stub:**

| Suite | Runs against |
| --- | --- |
| Files | A real FTP server (`ftp-srv`), including path-traversal attempts |
| Webmail and the mail app | A real IMAP server (`hoodiecrow-imap`) and a real SMTP server (`smtp-server`) |
| Technology detection | A real FTP server holding real WordPress, Laravel, Next.js, static and PHP trees, plus a real HTTP server serving the markup those platforms send |
| Database | A real MySQL or MariaDB server |
| Hostinger adapter, sync, DNS writes | A local stub serving Hostinger's documented response shapes |
| Deploys | A real FTP server, with genuinely hostile archives built in the test itself — a Zip Slip entry, a zip bomb, a symlink pointing at the filesystem root |
| Change alerts, support tickets, expiry reminders | A real SMTP server (`smtp-server`), with the messages parsed and read back |
| Two-factor codes | The RFC 6238 test vectors, so every authenticator app agrees with us |
| GST arithmetic | A sweep over every rate, quantity, discount and inclusive-pricing combination, checking the lines always reconcile with the totals |

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
  lib/                 Encryption, storage, mail, SQL, DNS zones, detection, GST, TOTP,
                       archives, deploy plans, helpers
  middleware/          Authentication, authorization, validation
  providers/           Pluggable provider adapters (hostinger.js)
  routes/              API endpoints
  services/            Provider credentials, sync, store, mail, notifications,
                       scheduler, expiry reminders, two-factor, billing, tickets, deploys
public-shared/         One design language, served at /shared and used by all three
  css/base.css         Tokens, primitives, motion — light and dark
  fonts/               Two subset variable fonts, 99 KB for the pair
  js/theme.js          Picks the theme before the first paint
public-store/          The public storefront, served at /
  index.html           Shell
  css/store.css        Styles
  js/                  Storefront, ordering and payment
public/                The portal, served at /portal
  index.html           SPA shell
  css/app.css          Styles
  js/                  Frontend modules and views
public-mail/           The standalone mail app (/mails, /mail, /webmail, or MAIL_HOST)
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
