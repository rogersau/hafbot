import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/lfg/post/close")({
  server: {
    handlers: {
      POST: handleAdminOperation("lfgPostClose.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
