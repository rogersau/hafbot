import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = "/.well-known/microsoft-identity-association.json";

export const Route = createFileRoute("/.well-known/microsoft-identity-association.json")({
  server: {
    handlers: {
      ANY: ({ context, request }) =>
        onServicePath(request, path, () => context.haf.microsoftIdentityAssociation()),
    },
  },
});
