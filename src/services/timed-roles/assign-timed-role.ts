import type { TimedRoleAssignment } from "../../types";
import type { TimedRoleStore } from "../../runtime/contracts/timed-role-store";

export async function assignTimedRole(
  store: Pick<TimedRoleStore, "upsertTimedRole" | "deleteTimedRole">,
  addRoleToMember: (guildId: string, userId: string, roleId: string) => Promise<void>,
  assignment: TimedRoleAssignment,
): Promise<void> {
  await store.upsertTimedRole(assignment);

  try {
    await addRoleToMember(assignment.guildId, assignment.userId, assignment.roleId);
  } catch (error) {
    try {
      await store.deleteTimedRole({
        guildId: assignment.guildId,
        userId: assignment.userId,
        roleId: assignment.roleId,
      });
    } catch {
      throw new Error("Failed to assign the timed role, and rollback failed.");
    }
    throw error;
  }
}
