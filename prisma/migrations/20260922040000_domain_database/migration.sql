-- Database access per domain.
--
-- Written by hand so it is safe against a live database: every column is
-- nullable or defaulted and added with IF NOT EXISTS, so applying this to a
-- deployment that already holds domains changes no existing row.

ALTER TABLE "domain_settings" ADD COLUMN IF NOT EXISTS "dbHost" TEXT;
ALTER TABLE "domain_settings" ADD COLUMN IF NOT EXISTS "dbPort" INTEGER;
ALTER TABLE "domain_settings" ADD COLUMN IF NOT EXISTS "dbName" TEXT;
ALTER TABLE "domain_settings" ADD COLUMN IF NOT EXISTS "dbUser" TEXT;

-- Encrypted at rest (AES-256-GCM), stored as iv:tag:ciphertext.
ALTER TABLE "domain_settings" ADD COLUMN IF NOT EXISTS "dbPassword" TEXT;

-- Read-only unless switched on for a domain, so no database becomes writable
-- merely by this migration running.
ALTER TABLE "domain_settings" ADD COLUMN IF NOT EXISTS "dbAllowWrites" BOOLEAN NOT NULL DEFAULT false;
