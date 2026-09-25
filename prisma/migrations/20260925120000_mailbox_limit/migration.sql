-- How many mailboxes a customer may have on a domain. Null is no limit.
ALTER TABLE "domain_settings" ADD COLUMN "maxMailboxes" INTEGER;
