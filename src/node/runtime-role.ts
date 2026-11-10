export const HAF_ROLES = ["all", "api", "gateway", "jobs"] as const;

export type HafRole = (typeof HAF_ROLES)[number];
export type NodeComponentName = "gateway" | "jobs" | "scheduler";

export interface RoleCapabilities {
  readonly servesApi: boolean;
  readonly components: readonly NodeComponentName[];
}

const ROLE_CAPABILITIES: Record<HafRole, RoleCapabilities> = {
  all: {
    servesApi: true,
    components: ["gateway", "jobs", "scheduler"],
  },
  api: {
    servesApi: true,
    components: [],
  },
  gateway: {
    servesApi: false,
    components: ["gateway"],
  },
  jobs: {
    servesApi: false,
    components: ["jobs", "scheduler"],
  },
};

export function parseHafRole(value: string | undefined): HafRole {
  if (value === undefined) return "all";
  const normalized = value.trim().toLowerCase();
  if ((HAF_ROLES as readonly string[]).includes(normalized)) return normalized as HafRole;
  throw new Error(`HAF_ROLE must be one of: ${HAF_ROLES.join(", ")}.`);
}

export function getRoleCapabilities(role: HafRole): RoleCapabilities {
  return ROLE_CAPABILITIES[role];
}
