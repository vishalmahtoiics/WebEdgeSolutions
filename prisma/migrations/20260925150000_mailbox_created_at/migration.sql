-- When a mailbox was made on the hosting account, as the provider reports it.
ALTER TABLE "email_accounts" ADD COLUMN "providerCreatedAt" TIMESTAMP(3);
