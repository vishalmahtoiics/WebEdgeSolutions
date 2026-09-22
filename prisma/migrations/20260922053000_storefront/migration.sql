-- The storefront: plans, domain pricing, orders, and who is selling.
--
-- All new tables and types, so nothing existing is touched. Written by hand
-- with IF NOT EXISTS guards so it is safe to re-run and safe against a live
-- database.
--
-- Money is stored in paise as integers throughout. A price is never a float.

DO $$ BEGIN CREATE TYPE "PlanKind" AS ENUM ('HOSTING', 'EMAIL', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'YEARLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "OrderKind" AS ENUM ('HOSTING', 'DOMAIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE "OrderStatus" AS ENUM
  ('PENDING_PAYMENT', 'PAYMENT_SUBMITTED', 'PAID', 'PROVISIONED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "plans" (
  "id"            TEXT NOT NULL,
  "slug"          TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "kind"          "PlanKind" NOT NULL DEFAULT 'HOSTING',
  "tagline"       TEXT,
  "priceMinor"    INTEGER NOT NULL,
  "wasPriceMinor" INTEGER,
  "currency"      TEXT NOT NULL DEFAULT 'INR',
  "billingPeriod" "BillingPeriod" NOT NULL DEFAULT 'YEARLY',
  "features"      TEXT[],
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "isFeatured"    BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "plans_slug_key" ON "plans" ("slug");
CREATE INDEX IF NOT EXISTS "plans_isActive_sortOrder_idx" ON "plans" ("isActive", "sortOrder");

CREATE TABLE IF NOT EXISTS "tld_prices" (
  "id"            TEXT NOT NULL,
  "tld"           TEXT NOT NULL,
  "registerMinor" INTEGER NOT NULL,
  "renewMinor"    INTEGER,
  "currency"      TEXT NOT NULL DEFAULT 'INR',
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "isPopular"     BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tld_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tld_prices_tld_key" ON "tld_prices" ("tld");
CREATE INDEX IF NOT EXISTS "tld_prices_isActive_sortOrder_idx" ON "tld_prices" ("isActive", "sortOrder");

CREATE TABLE IF NOT EXISTS "orders" (
  "id"                 TEXT NOT NULL,
  -- Effectively a bearer token: the public lookup accepts nothing else, so it
  -- is random rather than sequential.
  "reference"          TEXT NOT NULL,
  "kind"               "OrderKind" NOT NULL,
  "planId"             TEXT,
  "tld"                TEXT,
  "domainName"         TEXT,
  "customerName"       TEXT NOT NULL,
  "customerEmail"      TEXT NOT NULL,
  "customerPhone"      TEXT NOT NULL,
  "message"            TEXT,
  -- Worked out on the server. What the browser thought is never trusted.
  "amountMinor"        INTEGER NOT NULL,
  "currency"           TEXT NOT NULL DEFAULT 'INR',
  "billingPeriod"      "BillingPeriod",
  "status"             "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  -- Unverified by definition: a UPI reference cannot be checked from here.
  "paymentReference"   TEXT,
  "paymentSubmittedAt" TIMESTAMP(3),
  "paidAt"             TIMESTAMP(3),
  "provisionedAt"      TIMESTAMP(3),
  "confirmedById"      TEXT,
  "adminNotes"         TEXT,
  "domainId"           TEXT,
  "userId"             TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "orders_reference_key" ON "orders" ("reference");
CREATE INDEX IF NOT EXISTS "orders_status_createdAt_idx" ON "orders" ("status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "plans" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmedById_fkey"
    FOREIGN KEY ("confirmedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_domainId_fkey"
    FOREIGN KEY ("domainId") REFERENCES "domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row, addressed by a fixed id.
CREATE TABLE IF NOT EXISTS "store_settings" (
  "id"             TEXT NOT NULL DEFAULT 'default',
  "businessName"   TEXT,
  "headline"       TEXT,
  "subheadline"    TEXT,
  "supportEmail"   TEXT,
  "upiId"          TEXT,
  "upiPayeeName"   TEXT,
  "whatsappNumber" TEXT,
  "currency"       TEXT NOT NULL DEFAULT 'INR',
  "isOpen"         BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_settings_pkey" PRIMARY KEY ("id")
);
