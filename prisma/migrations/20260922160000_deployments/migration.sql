-- Deploying a website onto a hosting account.
--
-- The portal writes files over FTP, FTPS or SFTP. It does not run anything it
-- deploys. Every deploy records what it created and what it moved aside, which
-- is what makes rollback exact rather than a guess.

DO $$ BEGIN
  CREATE TYPE "DeploySource" AS ENUM ('ZIP', 'GIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DeployStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "deployments" (
  "id"       TEXT NOT NULL,
  "domainId" TEXT NOT NULL,

  -- Per-domain and sequential, so it can be spoken about: "roll back deploy
  -- 7". Not a cuid, which nobody can read out loud.
  "number" INTEGER NOT NULL,

  "source" "DeploySource" NOT NULL,
  "status" "DeployStatus" NOT NULL DEFAULT 'RUNNING',

  -- Where it came from. Only one of these sets is filled in.
  "gitUrl"      TEXT,
  "gitRef"      TEXT,
  "gitCommit"   TEXT,
  "archiveName" TEXT,

  -- Relative to the domain's configured FTP root, so a deploy can target a
  -- subfolder without ever addressing anything above that root.
  "targetPath" TEXT NOT NULL DEFAULT '/',
  -- Off is the safer default: deleting somebody's uploads folder because it
  -- was not in the zip is the worse mistake.
  "deleteMissing" BOOLEAN NOT NULL DEFAULT false,
  "keepPaths"     TEXT,

  "filesCreated"   INTEGER NOT NULL DEFAULT 0,
  "filesUpdated"   INTEGER NOT NULL DEFAULT 0,
  "filesDeleted"   INTEGER NOT NULL DEFAULT 0,
  "filesUnchanged" INTEGER NOT NULL DEFAULT 0,
  "bytesUploaded"  INTEGER NOT NULL DEFAULT 0,

  -- Where the replaced files were moved to. Null once the backup has been
  -- pruned, which is also what marks a deploy as no longer rollable back.
  "backupPath"   TEXT,
  "createdPaths" JSONB,
  "movedAside"   JSONB,

  -- path -> sha256 of what was written, so the next deploy can skip files
  -- that have not changed.
  "manifest" JSONB,

  "message" TEXT,
  "error"   TEXT,

  "actorId"    TEXT,
  "actorLabel" TEXT,

  "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,

  CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "deployments_domainId_number_key" ON "deployments" ("domainId", "number");
CREATE INDEX IF NOT EXISTS "deployments_domainId_startedAt_idx" ON "deployments" ("domainId", "startedAt");

DO $$ BEGIN
  ALTER TABLE "deployments" ADD CONSTRAINT "deployments_domainId_fkey"
    FOREIGN KEY ("domainId") REFERENCES "domains" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The alert areas gain one for deploys.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "notifyDeploy" BOOLEAN NOT NULL DEFAULT true;
