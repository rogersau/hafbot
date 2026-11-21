import { createFileRoute } from "@tanstack/react-router";
import llmsText from "../../../docs-site/public/llms.txt?raw";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      ANY: () => new Response("Not found", { status: 404 }),
      GET: () =>
        new Response(llmsText, { headers: { "content-type": "text/plain; charset=utf-8" } }),
    },
  },
});
