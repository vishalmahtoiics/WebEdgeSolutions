-- AlterTable
ALTER TABLE "domain_settings" ADD COLUMN     "imapHost" TEXT,
ADD COLUMN     "imapPort" INTEGER,
ADD COLUMN     "imapSecure" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "smtpSecure" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN     "encryptedPassword" TEXT;
