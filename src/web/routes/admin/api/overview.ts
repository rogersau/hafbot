import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/overview")({
  server: {
    handlers: {
      GET: handleAdminOperation("adminOverview.get"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
