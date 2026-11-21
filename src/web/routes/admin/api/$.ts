import { createFileRoute } from "@tanstack/react-router";
import { handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/$")({
  server: {
    handlers: {
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
