import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc, memberAc } from "better-auth/plugins/organization/access";

const statement = {
  ...defaultStatements,
  guild: ["read", "update"],
  workspaceGuild: ["create", "delete", "read"],
  entitlement: ["read", "update"],
} as const;

export const workspaceAccessControl = createAccessControl(statement);

export const ownerRole = workspaceAccessControl.newRole({
  ...adminAc.statements,
  guild: ["read", "update"],
  workspaceGuild: ["create", "delete", "read"],
  entitlement: ["read", "update"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

export const adminRole = workspaceAccessControl.newRole({
  ...adminAc.statements,
  guild: ["read", "update"],
  workspaceGuild: ["read"],
  entitlement: ["read"],
});

export const viewerRole = workspaceAccessControl.newRole({
  ...memberAc.statements,
  guild: ["read"],
  workspaceGuild: ["read"],
  entitlement: ["read"],
});
