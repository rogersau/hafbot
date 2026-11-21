import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offerings/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOfferingsPublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
