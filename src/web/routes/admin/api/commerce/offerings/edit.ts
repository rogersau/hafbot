import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offerings/edit")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOfferingsEdit.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
