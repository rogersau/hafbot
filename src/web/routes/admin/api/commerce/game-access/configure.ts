import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/game-access/configure")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceGameAccessConfigure.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
