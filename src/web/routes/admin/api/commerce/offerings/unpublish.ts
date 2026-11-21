import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offerings/unpublish")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOfferingsUnpublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
