-- Five features that share one migration because they share one deployment:
-- scheduled work, two-factor sign-in, quotations and invoices with GST, and
-- support tickets.
--
-- Everything here is additive. Existing columns keep their types, and every
-- new column on an existing table is nullable or defaulted, so an older
-- release running against this schema mid-deploy still works.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "DocumentKind" AS ENUM ('QUOTATION', 'INVOICE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'PAID', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'AWAITING_CUSTOMER', 'AWAITING_SUPPORT', 'RESOLVED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Two-factor authentication on the account
-- ---------------------------------------------------------------------------

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpSecret" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpEnabledAt" TIMESTAMP(3);
-- The last 30-second step a code was accepted for, so the same six digits
-- cannot be used twice inside their window.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totpLastStep" BIGINT;

CREATE TABLE IF NOT EXISTS "recovery_codes" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  -- SHA-256 of the code. These are long random strings, not chosen passwords:
  -- there is nothing to brute-force, and sign-in has to try them one by one.
  "codeHash"  TEXT NOT NULL,
  "hint"      TEXT NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "recovery_codes_userId_idx" ON "recovery_codes" ("userId");

DO $$ BEGIN
  ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Work that happens on its own
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
  -- The job's own name, not a cuid: there is one row per job.
  "id"             TEXT NOT NULL,
  "lastRunAt"      TIMESTAMP(3),
  "lastOk"         BOOLEAN,
  "lastMessage"    TEXT,
  "lastDurationMs" INTEGER,
  -- Held while running. A lock left behind by a killed process is broken
  -- after an hour rather than blocking the job forever.
  "runningSince"   TIMESTAMP(3),
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "expiry_reminders" (
  "id"         TEXT NOT NULL,
  "domainId"   TEXT NOT NULL,
  "daysBefore" INTEGER NOT NULL,
  -- A date, not a timestamp: the ladder is in days, and a timezone shift must
  -- not make yesterday's reminder due again.
  "expiresOn"  DATE NOT NULL,
  "sentAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered"  BOOLEAN NOT NULL DEFAULT false,
  "sentTo"     TEXT,
  CONSTRAINT "expiry_reminders_pkey" PRIMARY KEY ("id")
);

-- The key that makes a renewal work without any extra code: renewing moves
-- expiresOn, so the whole ladder becomes due again for the new date.
CREATE UNIQUE INDEX IF NOT EXISTS "expiry_reminders_domainId_daysBefore_expiresOn_key"
  ON "expiry_reminders" ("domainId", "daysBefore", "expiresOn");
CREATE INDEX IF NOT EXISTS "expiry_reminders_domainId_idx" ON "expiry_reminders" ("domainId");

DO $$ BEGIN
  ALTER TABLE "expiry_reminders" ADD CONSTRAINT "expiry_reminders_domainId_fkey"
    FOREIGN KEY ("domainId") REFERENCES "domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Settings for the scheduler and the new alert areas
-- ---------------------------------------------------------------------------

ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "notifySupport"  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "notifySchedule" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "notifyBilling"  BOOLEAN NOT NULL DEFAULT true;

-- Off by default. A portal that started contacting providers and customers the
-- moment it booted would be a surprise, and surprises here cost trust.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "jobsEnabled"       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "jobHour"           INTEGER NOT NULL DEFAULT 2;
-- Minutes east of UTC; 330 is India. Stored rather than read from the host so
-- a container running in UTC still fires these at the hour the operator meant.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "jobTimezoneOffset" INTEGER NOT NULL DEFAULT 330;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "autoSyncEnabled"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "expiryRemindersEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "expiryReminderDays"     TEXT NOT NULL DEFAULT '30,15,7,1';
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "expiryRemindCustomer"   BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- The seller's own identity, for invoices
-- ---------------------------------------------------------------------------

ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "legalName"    TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "addressLine1" TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "addressLine2" TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "city"         TEXT;
-- Two digits, as GST uses them. This is what decides CGST + SGST against
-- IGST, so it is not decorative.
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "stateCode"    TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "stateName"    TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "pincode"      TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "gstin"        TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "pan"          TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "bankName"     TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "bankAccount"  TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "bankIfsc"     TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "bankBranch"   TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "invoicePrefix"   TEXT NOT NULL DEFAULT 'INV';
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "quotationPrefix" TEXT NOT NULL DEFAULT 'QTN';
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "defaultTaxPct"   INTEGER NOT NULL DEFAULT 18;
-- Off is a real case, not an oversight: below the registration threshold a
-- business issues a bill of supply with no tax on it at all.
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "gstEnabledByDefault" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "invoiceTerms"   TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "quotationTerms" TEXT;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "quotationValidDays" INTEGER NOT NULL DEFAULT 15;

-- ---------------------------------------------------------------------------
-- Quotations and invoices
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "billing_documents" (
  "id"     TEXT NOT NULL,
  "kind"   "DocumentKind" NOT NULL,
  -- INV/2026-27/0001. Sequential within its series and never reused: a
  -- cancelled invoice keeps its number.
  "number" TEXT NOT NULL,
  -- April to March, because that is the year GST is filed against.
  "series" TEXT NOT NULL,
  "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',

  -- The customer, copied rather than referenced: an address that changes next
  -- year must not quietly rewrite a document already issued.
  "customerName"      TEXT NOT NULL,
  "customerEmail"     TEXT,
  "customerPhone"     TEXT,
  "customerAddress"   TEXT,
  "customerGstin"     TEXT,
  "customerStateCode" TEXT,

  "userId"   TEXT,
  "domainId" TEXT,
  "orderId"  TEXT,

  "issueDate"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueDate"    TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),

  "gstEnabled"       BOOLEAN NOT NULL DEFAULT true,
  "sellerGstin"      TEXT,
  "sellerStateCode"  TEXT,
  -- True when the two states differ, so one IGST line replaces CGST + SGST.
  "isInterState"     BOOLEAN NOT NULL DEFAULT false,
  "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false,

  "subtotalMinor"   INTEGER NOT NULL DEFAULT 0,
  "discountMinor"   INTEGER NOT NULL DEFAULT 0,
  "taxableMinor"    INTEGER NOT NULL DEFAULT 0,
  "cgstMinor"       INTEGER NOT NULL DEFAULT 0,
  "sgstMinor"       INTEGER NOT NULL DEFAULT 0,
  "igstMinor"       INTEGER NOT NULL DEFAULT 0,
  "totalMinor"      INTEGER NOT NULL DEFAULT 0,
  "amountPaidMinor" INTEGER NOT NULL DEFAULT 0,
  "currency"        TEXT NOT NULL DEFAULT 'INR',

  "notes" TEXT,
  "terms" TEXT,

  "sentOn"           TIMESTAMP(3),
  "paidOn"           TIMESTAMP(3),
  "paymentReference" TEXT,

  -- A quotation that became an invoice points at it, and back. Neither is a
  -- copy: the quotation stays exactly as it was quoted.
  "convertedToId"   TEXT,
  "convertedFromId" TEXT,

  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "billing_documents_number_key" ON "billing_documents" ("number");
CREATE UNIQUE INDEX IF NOT EXISTS "billing_documents_convertedToId_key" ON "billing_documents" ("convertedToId");
CREATE UNIQUE INDEX IF NOT EXISTS "billing_documents_convertedFromId_key" ON "billing_documents" ("convertedFromId");
CREATE INDEX IF NOT EXISTS "billing_documents_kind_issueDate_idx" ON "billing_documents" ("kind", "issueDate");
CREATE INDEX IF NOT EXISTS "billing_documents_status_idx" ON "billing_documents" ("status");

DO $$ BEGIN
  ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_domainId_fkey"
    FOREIGN KEY ("domainId") REFERENCES "domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "billing_items" (
  "id"         TEXT NOT NULL,
  "documentId" TEXT NOT NULL,

  "description" TEXT NOT NULL,
  -- 998315 is web hosting. Typed rather than guessed: a wrong code on a filed
  -- return is the customer's problem, so the portal does not invent one.
  "hsnCode"     TEXT,

  "quantity"       INTEGER NOT NULL,
  "unitPriceMinor" INTEGER NOT NULL,
  -- Whole percent: 0, 5, 12, 18, 28.
  "taxRatePct"     INTEGER NOT NULL DEFAULT 18,

  "lineSubtotalMinor" INTEGER NOT NULL,
  "lineDiscountMinor" INTEGER NOT NULL DEFAULT 0,
  "lineTaxableMinor"  INTEGER NOT NULL,
  "lineTaxMinor"      INTEGER NOT NULL,
  "lineTotalMinor"    INTEGER NOT NULL,

  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "billing_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "billing_items_documentId_idx" ON "billing_items" ("documentId");

DO $$ BEGIN
  ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "billing_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The next number in each series. Incremented with an atomic UPDATE, which is
-- the only way two documents created at the same moment cannot take the same
-- number.
CREATE TABLE IF NOT EXISTS "document_counters" (
  "id"         TEXT NOT NULL,
  "kind"       "DocumentKind" NOT NULL,
  "series"     TEXT NOT NULL,
  "nextNumber" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "document_counters_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "document_counters_kind_series_key"
  ON "document_counters" ("kind", "series");

-- ---------------------------------------------------------------------------
-- Support tickets
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "tickets" (
  "id" TEXT NOT NULL,
  -- Short and sayable over the phone: TKT-7K3M9Q.
  "reference" TEXT NOT NULL,
  "subject"   TEXT NOT NULL,

  "status"   "TicketStatus"   NOT NULL DEFAULT 'OPEN',
  "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
  -- Free text with a suggested list rather than an enum, so a category can be
  -- added without a migration.
  "category" TEXT,

  "userId"   TEXT NOT NULL,
  "domainId" TEXT,

  -- Who spoke last, kept alongside status rather than derived from it: an
  -- admin can mark a ticket resolved without that changing who replied last.
  "lastReplyAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastReplyByRole" "Role" NOT NULL DEFAULT 'USER',

  "closedAt"  TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tickets_reference_key" ON "tickets" ("reference");
CREATE INDEX IF NOT EXISTS "tickets_status_lastReplyAt_idx" ON "tickets" ("status", "lastReplyAt");
CREATE INDEX IF NOT EXISTS "tickets_userId_lastReplyAt_idx" ON "tickets" ("userId", "lastReplyAt");

DO $$ BEGIN
  ALTER TABLE "tickets" ADD CONSTRAINT "tickets_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "tickets" ADD CONSTRAINT "tickets_domainId_fkey"
    FOREIGN KEY ("domainId") REFERENCES "domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ticket_messages" (
  "id"       TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,

  "authorId"    TEXT,
  "authorLabel" TEXT NOT NULL,
  "authorRole"  "Role" NOT NULL,

  "body" TEXT NOT NULL,
  -- A note for your own side of the desk. Never returned to the customer —
  -- enforced in the query, not by hiding it in the interface.
  "isInternal" BOOLEAN NOT NULL DEFAULT false,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ticket_messages_ticketId_createdAt_idx"
  ON "ticket_messages" ("ticketId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "tickets" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
