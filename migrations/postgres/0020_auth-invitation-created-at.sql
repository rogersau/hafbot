-- Historical invitations have no creation time; use the migration time for those rows.
ALTER TABLE "Invitation"
  ADD COLUMN "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
