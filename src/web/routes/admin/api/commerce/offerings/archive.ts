import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offerings/archive")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOfferingsArchive.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
