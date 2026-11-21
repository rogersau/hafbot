import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$")({
  server: { handlers: { ANY: () => new Response("Not found", { status: 404 }) } },
});
