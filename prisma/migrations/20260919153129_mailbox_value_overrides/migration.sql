-- Split mailbox size/usage into "what the provider reports" and "what an
-- administrator chose to show".
--
-- Written to be safe on a database that is already live:
--   * the existing columns are RENAMED, not dropped and re-added, so quota and
--     usage figures already synced are carried over rather than lost;
--   * the session table is created only if it is not already there, because
--     connect-pg-simple used to create it at boot and existing deployments
--     will already have it.

-- Carry the existing values over as the provider-reported ones.
ALTER TABLE "email_accounts" RENAME COLUMN "quotaMb" TO "providerQuotaMb";
ALTER TABLE "email_accounts" RENAME COLUMN "usedMb" TO "providerUsedMb";

-- Administrator overrides. NULL means "show the provider's value".
ALTER TABLE "email_accounts" ADD COLUMN "quotaMbOverride" INTEGER;
ALTER TABLE "email_accounts" ADD COLUMN "usedMbOverride" INTEGER;

-- The express-session store, now owned by migrations rather than created at
-- boot. Existing deployments already have this table.
CREATE TABLE IF NOT EXISTS "user_sessions" (
    "sid" TEXT NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions"("expire");
