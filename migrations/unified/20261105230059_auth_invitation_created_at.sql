-- SQLite requires a constant default when adding a non-null column to existing rows.
ALTER TABLE "Invitation"
  ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

-- Original invitation creation times were not recorded; backfill the migration time.
UPDATE "Invitation" SET "createdAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
