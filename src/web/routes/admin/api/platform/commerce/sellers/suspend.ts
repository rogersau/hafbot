import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/platform/commerce/sellers/suspend")({
  server: {
    handlers: {
      POST: handleAdminOperation("platformCommerceSellersSuspend.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
