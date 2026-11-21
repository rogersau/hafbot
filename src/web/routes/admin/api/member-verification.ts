import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/member-verification")({
  server: {
    handlers: {
      GET: handleAdminOperation("memberVerification.get"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
