import { createMiddleware } from "@tanstack/react-start";

import { getAdminLoginLocation, redirect } from "../../runtime/admin-redirects";
import { isAdminDashboardPath } from "../dashboard-routes";

export function adminDocumentMiddleware(page: "dashboard" | "login") {
  return createMiddleware().server(async ({ context, request, next }) => {
    const url = new URL(request.url);
    const login = page === "login";
    let admin = context?.admin;
    if (
      admin?.enabled === false ||
      (login ? url.pathname !== "/admin/login" : !isAdminDashboardPath(url.pathname))
    ) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }

    const readAdminDocument = context?.haf?.readAdminDocument;
    if (admin && readAdminDocument) {
      const userProfile = await readAdminDocument(request);
      admin = { ...admin, userProfile, authenticated: userProfile !== null };
    }

    if (login && admin?.authenticated) {
      return redirect("/admin");
    }
    if (!login && !admin?.authenticated) {
      return redirect(getAdminLoginLocation(`${url.pathname}${url.search}`));
    }

    return next({ context: { admin } });
  });
}
