-- AlterTable
ALTER TABLE "app_settings" ADD COLUMN     "publicImapHost" TEXT,
ADD COLUMN     "publicImapPort" INTEGER,
ADD COLUMN     "publicSmtpHost" TEXT,
ADD COLUMN     "publicSmtpPort" INTEGER,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "billing_documents" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "domain_settings" ADD COLUMN     "mailSetupMode" TEXT NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "publicImapHost" TEXT,
ADD COLUMN     "publicImapPort" INTEGER,
ADD COLUMN     "publicSmtpHost" TEXT,
ADD COLUMN     "publicSmtpPort" INTEGER;

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "plans" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "scheduled_jobs" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "store_settings" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tickets" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tld_prices" ALTER COLUMN "updatedAt" DROP DEFAULT;
