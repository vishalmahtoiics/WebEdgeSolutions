-- A record of every statement that changed something, and who ran it.
--
-- Safe on a live database: a new table, and nothing existing is touched.

CREATE TABLE IF NOT EXISTS "database_query_log" (
  "id"        TEXT NOT NULL,
  "domainId"  TEXT NOT NULL,
  -- Kept when the account is deleted: the record of the statement outlives the
  -- person who ran it, which is the point of having it.
  "userId"    TEXT,
  "sql"       TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "verb"      TEXT NOT NULL,
  "target"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "database_query_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "database_query_log_domainId_createdAt_idx"
  ON "database_query_log" ("domainId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "database_query_log"
    ADD CONSTRAINT "database_query_log_domainId_fkey"
    FOREIGN KEY ("domainId") REFERENCES "domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "database_query_log"
    ADD CONSTRAINT "database_query_log_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
