import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/wardogs/validate-contract")({
  server: {
    handlers: {
      POST: handleAdminOperation("wardogsValidateContract.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
