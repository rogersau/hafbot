import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/clans/requests/review")({
  server: {
    handlers: {
      POST: handleAdminOperation("clansRequestsReview.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
