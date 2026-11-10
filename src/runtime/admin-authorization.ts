import type { CustomerSession } from "./auth/customer-session";
import type { WorkspaceStore } from "./workspace-store";
import type { WorkspaceRole } from "./workspace-types";

export type { CustomerSession };

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface WorkspaceMembershipResolver {
  (input: { workspaceId: string; userId: string }): Promise<WorkspaceMembership | null>;
}

export type WorkspaceAccessMode = "read" | "write" | "owner";

export type AuthorizationResult =
  | {
      ok: true;
      session: CustomerSession;
      membership: WorkspaceMembership;
    }
  | {
      ok: false;
      response: Response;
    };

export interface AuthorizeWorkspaceRequestInput {
  session: CustomerSession | null;
  workspaceId: string | null;
  guildId?: string | null;
  mode?: WorkspaceAccessMode;
  workspaceStore: WorkspaceStore | undefined;
  membershipResolver: WorkspaceMembershipResolver;
}

export async function authorizeWorkspaceRequest(
  input: AuthorizeWorkspaceRequestInput,
): Promise<AuthorizationResult> {
  if (!input.session) {
    return unauthorized();
  }
  if (!input.workspaceId) {
    return badRequest("workspaceId is required");
  }
  if (!input.workspaceStore) {
    return notFound("Workspace administration is not configured.");
  }

  const membership = await input.membershipResolver({
    workspaceId: input.workspaceId,
    userId: input.session.user.id,
  });
  if (!membership) {
    return forbidden("Workspace access is required.");
  }

  const roleResponse = requireWorkspaceRole(membership.role, input.mode ?? "read");
  if (roleResponse) {
    return { ok: false, response: roleResponse };
  }

  if (input.guildId) {
    const linked = await input.workspaceStore.isGuildLinkedToWorkspace(
      input.workspaceId,
      input.guildId,
    );
    if (!linked) {
      return forbidden("Guild is not linked to this workspace.");
    }
  }

  return {
    ok: true,
    session: input.session,
    membership,
  };
}

export function requireWorkspaceRole(
  role: WorkspaceRole,
  mode: WorkspaceAccessMode,
): Response | null {
  if (mode === "read") {
    return null;
  }
  if (mode === "write" && (role === "owner" || role === "admin")) {
    return null;
  }
  if (mode === "owner" && role === "owner") {
    return null;
  }
  return Response.json({ error: "Forbidden" }, { status: 403 });
}

function unauthorized(): AuthorizationResult {
  return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
}

function forbidden(message: string): AuthorizationResult {
  return { ok: false, response: Response.json({ error: message }, { status: 403 }) };
}

function notFound(message: string): AuthorizationResult {
  return { ok: false, response: Response.json({ error: message }, { status: 404 }) };
}

function badRequest(message: string): AuthorizationResult {
  return { ok: false, response: Response.json({ error: message }, { status: 400 }) };
}
