-- What a site is built on.
--
-- Written by hand rather than generated so it is safe to run against a live
-- database: every column is nullable and added with IF NOT EXISTS, so applying
-- this to a deployment that already carries domains changes no existing row.

ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "detectedTech" TEXT;
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "detectedTechVersion" TEXT;
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "detectedTechSource" TEXT;
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "detectedTechEvidence" TEXT;
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "detectedTechLevel" TEXT;
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "detectedTechAt" TIMESTAMP(3);

-- The administrator's own answer, which detection never overwrites.
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "techOverride" TEXT;
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "techVersionOverride" TEXT;
