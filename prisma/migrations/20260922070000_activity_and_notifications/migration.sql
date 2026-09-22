-- Knowing what happened, and being told about it.
--
-- Two new tables; nothing existing is touched. The activity log is written
-- before any email is attempted, so a mail server that is down or slow costs
-- the notification but never the record.

CREATE TABLE IF NOT EXISTS "activity_log" (
  "id"          TEXT NOT NULL,
  -- A dotted name: "dns.record.deleted". Grouped by its first part so a whole
  -- area can be silenced at once.
  "event"       TEXT NOT NULL,
  "actorId"     TEXT,
  -- Kept as text too, so an entry still reads correctly once the account it
  -- names has been deleted.
  "actorLabel"  TEXT,
  "actorRole"   TEXT,
  "summary"     TEXT NOT NULL,
  "detail"      TEXT,
  "domainId"    TEXT,
  "domainName"  TEXT,
  "ip"          TEXT,
  -- Whether an email went out, and why not when it did not. Without this,
  -- "I never got an alert" cannot be answered.
  "notified"    BOOLEAN NOT NULL DEFAULT false,
  "notifyError" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "activity_log_createdAt_idx" ON "activity_log" ("createdAt");
CREATE INDEX IF NOT EXISTS "activity_log_event_createdAt_idx" ON "activity_log" ("event", "createdAt");

DO $$ BEGIN
  ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_domainId_fkey"
    FOREIGN KEY ("domainId") REFERENCES "domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row, addressed by a fixed id. Notifications start switched off: a fresh
-- install must not try to send mail through a server nobody has configured.
CREATE TABLE IF NOT EXISTS "app_settings" (
  "id"              TEXT NOT NULL DEFAULT 'default',
  "smtpHost"        TEXT,
  "smtpPort"        INTEGER,
  "smtpSecure"      BOOLEAN NOT NULL DEFAULT true,
  "smtpUser"        TEXT,
  -- Encrypted at rest (AES-256-GCM), stored as iv:tag:ciphertext.
  "smtpPassword"    TEXT,
  "fromAddress"     TEXT,
  "fromName"        TEXT,
  "notifyEmails"    TEXT,
  "notifyEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "notifyDns"       BOOLEAN NOT NULL DEFAULT true,
  "notifyEmailMgmt" BOOLEAN NOT NULL DEFAULT true,
  "notifyFiles"     BOOLEAN NOT NULL DEFAULT true,
  "notifyDatabase"  BOOLEAN NOT NULL DEFAULT true,
  "notifyUsers"     BOOLEAN NOT NULL DEFAULT true,
  "notifySettings"  BOOLEAN NOT NULL DEFAULT true,
  "notifyOrders"    BOOLEAN NOT NULL DEFAULT true,
  "notifySecurity"  BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);
