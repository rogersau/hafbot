import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/profile/preferences")({
  server: {
    handlers: {
      GET: handleAdminOperation("profilePreferences.get"),
      PATCH: handleAdminOperation("profilePreferences.patch"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
