import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offerings/retire")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOfferingsRetire.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
