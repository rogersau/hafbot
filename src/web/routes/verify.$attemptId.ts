import { createFileRoute } from "@tanstack/react-router";
import { onServicePath } from "../service-route-path";

const path = /^\/verify\/[^/]+$/;

export const Route = createFileRoute("/verify/$attemptId")({
  server: {
    handlers: {
      GET: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.memberVerificationGet(request, params.attemptId),
        ),
      HEAD: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.memberVerificationMethodNotAllowed(request, params.attemptId),
        ),
      POST: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.memberVerificationPost(request, params.attemptId),
        ),
      ANY: ({ context, params, request }) =>
        onServicePath(request, path, () =>
          context.haf.memberVerificationMethodNotAllowed(request, params.attemptId),
        ),
    },
  },
});
