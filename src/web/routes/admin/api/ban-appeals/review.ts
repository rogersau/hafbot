import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-appeals/review")({
  server: {
    handlers: {
      POST: handleAdminOperation("banAppealsReview.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
