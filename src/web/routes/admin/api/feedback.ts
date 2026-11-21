import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/feedback")({
  server: {
    handlers: {
      POST: handleAdminOperation("feedback.create.v1"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
