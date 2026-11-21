import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin_/logout")({
  server: { handlers: { POST: ({ request, context }) => context.haf.logout(request) } },
});
