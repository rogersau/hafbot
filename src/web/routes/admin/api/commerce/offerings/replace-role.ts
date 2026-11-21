import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/commerce/offerings/replace-role")({
  server: {
    handlers: {
      POST: handleAdminOperation("commerceOfferingsReplaceRole.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
