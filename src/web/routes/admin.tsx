import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";

import adminStylesHref from "../../admin/styles.css?url";
import { ADMIN_THEME_FOUC_SCRIPT } from "../../runtime/admin-theme-fouc";

export const Route = createFileRoute("/admin")({
  beforeLoad: ({ serverContext }) => {
    const session = serverContext?.admin;
    if (!session?.authenticated) return;
    const { authenticated, playstationLinkEnabled, workerVersion } = session;
    const profile = session.userProfile;
    const userProfile = profile && {
      name: profile.name,
      email: profile.email,
      image: profile.image,
    };
    return { admin: { authenticated, userProfile, playstationLinkEnabled, workerVersion } };
  },
  head: () => ({
    meta: [{ title: "Admin" }],
    links: [{ rel: "stylesheet", href: adminStylesHref }],
    scripts: [{ children: ADMIN_THEME_FOUC_SCRIPT }],
  }),
  component: AdminDocument,
});

function AdminDocument() {
  const nonce = useRouter().options.ssr?.nonce;
  return (
    <div id="admin-root" data-csp-style-nonce={nonce}>
      <Outlet />
    </div>
  );
}
