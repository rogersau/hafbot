import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/panel/revision/restore-preview")({
  server: {
    handlers: {
      POST: handleAdminOperation("ticketsPanelRevisionRestorePreview.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
