import type { CustomerAuth } from "./auth";

export interface CustomerSessionUser {
  id: string;
  discordUserId: string;
  name: string;
  email?: string | null;
  image?: string | null;
}

export interface CustomerSession {
  activeOrganizationId?: string | null;
  user: CustomerSessionUser;
}

export async function readCustomerSession(
  request: Request,
  auth: CustomerAuth | undefined,
): Promise<CustomerSession | null> {
  if (!auth) {
    return null;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return null;
  }

  // Better Auth does not expose additionalFields on the inferred session user type,
  // so validate the custom field at runtime before treating the session as usable.
  const user = session.user as typeof session.user & {
    discordUserId?: unknown;
    email?: unknown;
    image?: unknown;
  };
  if (typeof user.discordUserId !== "string" || user.discordUserId.length === 0) {
    return null;
  }

  const authSession = (session as unknown as { session?: { activeOrganizationId?: unknown } })
    .session;

  return {
    activeOrganizationId:
      typeof authSession?.activeOrganizationId === "string"
        ? authSession.activeOrganizationId
        : null,
    user: {
      id: user.id,
      discordUserId: user.discordUserId,
      name: user.name,
      email: typeof user.email === "string" ? user.email : null,
      image: typeof user.image === "string" ? user.image : null,
    },
  };
}
