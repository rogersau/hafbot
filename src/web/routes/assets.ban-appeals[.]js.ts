import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/assets/ban-appeals.js";

export const Route = createFileRoute("/assets/ban-appeals.js")({
  server: {
    handlers: {
      GET: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.banAppealScript()),
      HEAD: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.banAppealScriptMethodNotAllowed()),
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.banAppealScriptMethodNotAllowed()),
    },
  },
});
