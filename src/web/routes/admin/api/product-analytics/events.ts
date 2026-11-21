import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/product-analytics/events")({
  server: {
    handlers: {
      POST: handleAdminOperation("productAnalyticsEvent.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
