-- hafbot:migration {"phase":"expand"}
-- Better Auth's organization plugin stores the selected workspace on the current session.
-- Nullable keeps sessions created before workspace provisioning valid until their first selection.
ALTER TABLE "Session" ADD COLUMN "activeOrganizationId" TEXT;
