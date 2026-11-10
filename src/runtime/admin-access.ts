import type { CustomerSession } from "./auth/customer-session";

export interface AdminAccessRequirement {
  mode: "read" | "write" | "owner";
  guildCapability?: "manage-delegation" | "manage-server-policy";
  guildId?: string | null;
  workspaceId?: string | null;
  allowGuildAdminDirectory?: boolean;
  workspaceOnly?: boolean;
  customerSessionOnly?: boolean;
}

export type AdminAccessDenied =
  | { _tag: "BadRequest"; message: string }
  | { _tag: "Unauthorized"; message: string }
  | { _tag: "Forbidden"; message: string }
  | { _tag: "NotFound"; message: string };

export type AdminAccessResult = { ok: true } | { ok: false; error: AdminAccessDenied };

export interface AdminAccess {
  authorize(request: Request, requirement: AdminAccessRequirement): Promise<AdminAccessResult>;
}

export interface RuntimeAdminAccessOptions {
  readCustomerSession: (request: Request) => Promise<CustomerSession | null>;
  authorizeWorkspaceAccess?: (
    request: Request,
    requirement: AdminAccessRequirement,
  ) => Promise<AdminAccessResult>;
  authorizeGuildAccess?: (
    request: Request,
    requirement: AdminAccessRequirement,
  ) => Promise<boolean>;
}

export function createRuntimeAdminAccess(options: RuntimeAdminAccessOptions): AdminAccess {
  return {
    async authorize(request, requirement) {
      const session = await options.readCustomerSession(request);
      if (!session) {
        return { ok: false, error: { _tag: "Unauthorized", message: "Unauthorized" } };
      }
      if (requirement.guildCapability) {
        return options.authorizeGuildAccess &&
          (await options.authorizeGuildAccess(request, requirement))
          ? { ok: true }
          : {
              ok: false,
              error: {
                _tag: "Forbidden",
                message:
                  requirement.guildCapability === "manage-server-policy"
                    ? "Only the Discord server owner can change automatic Manage Server access."
                    : "Only the Discord server owner or an Administrator can change delegated access.",
              },
            };
      }
      if (requirement.customerSessionOnly || requirement.allowGuildAdminDirectory) {
        return { ok: true };
      }

      let workspaceDenied: AdminAccessDenied | null = null;
      if (options.authorizeWorkspaceAccess) {
        const result = await options.authorizeWorkspaceAccess(request, requirement);
        if (result.ok) return result;
        workspaceDenied = result.error;
      }
      if (
        options.authorizeGuildAccess &&
        (await options.authorizeGuildAccess(request, requirement))
      ) {
        return { ok: true };
      }
      return {
        ok: false,
        error:
          workspaceDenied && workspaceDenied._tag !== "BadRequest"
            ? workspaceDenied
            : { _tag: "Forbidden", message: "Forbidden" },
      };
    },
  };
}

export function createAdminAccessDeniedResponse(error: AdminAccessDenied): Response {
  return Response.json({ error: error.message }, { status: statusForAdminAccessDenied(error) });
}

export async function readAdminAccessDeniedResponse(
  response: Response,
): Promise<AdminAccessDenied> {
  const message = await readErrorMessage(response.clone());

  switch (response.status) {
    case 400:
      return { _tag: "BadRequest", message };
    case 401:
      return { _tag: "Unauthorized", message };
    case 403:
      return { _tag: "Forbidden", message };
    case 404:
      return { _tag: "NotFound", message };
    default:
      return { _tag: "Forbidden", message };
  }
}

function statusForAdminAccessDenied(error: AdminAccessDenied): number {
  switch (error._tag) {
    case "BadRequest":
      return 400;
    case "Unauthorized":
      return 401;
    case "Forbidden":
      return 403;
    case "NotFound":
      return 404;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // Fall back to response text below when no JSON error body is present.
  }

  try {
    const text = await response.text();
    if (text.length > 0) {
      return text;
    }
  } catch {
    // Ignore unreadable bodies and use the default message below.
  }

  return response.status === 401
    ? "Unauthorized"
    : response.status === 404
      ? "Not found"
      : response.status === 400
        ? "Bad request"
        : "Forbidden";
}
