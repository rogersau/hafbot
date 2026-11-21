import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/product-analytics/preference")({
  server: {
    handlers: {
      GET: handleAdminOperation("productAnalyticsPreference.get"),
      POST: handleAdminOperation("productAnalyticsPreference.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
