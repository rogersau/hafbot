/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  ChannelPermissionCopyError,
  createPreviewTokenManager,
  diffPermissionOverwrites,
  evaluatePermissionCopySafety,
  evaluatePreviewFreshness,
  fingerprintChannelPermissionState,
  mergePermissionOverwrites,
  normalizePermissionOverwrites,
  preserveBotRecoveryAccess,
  validateChannelPermissionCopySelection,
} from "../src/services/channel-permission-copy-service";

const role = (id: string, allow = "0", deny = "0") => ({ id, type: 0 as const, allow, deny });
const member = (id: string, allow = "0", deny = "0") => ({
  id,
  type: 1 as const,
  allow,
  deny,
});

test("normalizes decimal bitsets and sorts roles before members by numeric snowflake", () => {
  assert.deepEqual(
    normalizePermissionOverwrites([member("20", "00"), role("10", "01"), role("2")]),
    [role("2"), role("10", "1"), member("20")],
  );
});

test("rejects malformed, overlapping, and duplicate overwrites", () => {
  for (const values of [
    [role("not-an-id")],
    [role("1", "-1")],
    [role("1", "1", "1")],
    [role("1"), role("1")],
    [{ ...role("1"), type: 2 }],
  ]) {
    assert.throws(() => normalizePermissionOverwrites(values), ChannelPermissionCopyError);
  }
});

test("roles_only replaces roles including everyone and retains target members", () => {
  assert.deepEqual(
    mergePermissionOverwrites(
      [role("100", "1"), role("200", "2"), member("300", "4")],
      [role("100", "8"), role("400"), member("500", "16")],
      "roles_only",
    ),
    [role("100", "1"), role("200", "2"), member("500", "16")],
  );
});

test("exact returns the complete source set", () => {
  assert.deepEqual(
    mergePermissionOverwrites([member("3", "4"), role("1", "2")], [role("9")], "exact"),
    [role("1", "2"), member("3", "4")],
  );
});

test("preserves minimal HAF Bot recovery access as an explicit member overwrite", () => {
  const manageChannels = 1n << 4n;
  const recovery = preserveBotRecoveryAccess([role("1")], "99", String(manageChannels));

  assert.deepEqual(recovery, {
    overwrites: [role("1"), member("99", String((1n << 10n) | (1n << 28n)))],
    preservedPermissions: ["View Channel", "Manage Roles"],
  });
});

test("repairs an existing HAF Bot overwrite without changing unrelated bits", () => {
  const required = (1n << 4n) | (1n << 10n) | (1n << 28n);
  const recovery = preserveBotRecoveryAccess(
    [member("99", String(1n << 6n), String(required))],
    "99",
    "0",
  );

  assert.deepEqual(recovery.overwrites, [member("99", String(required | (1n << 6n)), "0")]);
  assert.deepEqual(recovery.preservedPermissions, [
    "Manage Channels",
    "View Channel",
    "Manage Roles",
  ]);
  assert.deepEqual(preserveBotRecoveryAccess(recovery.overwrites, "99", String(required)), {
    overwrites: recovery.overwrites,
    preservedPermissions: [],
  });
  assert.deepEqual(preserveBotRecoveryAccess([role("1")], "99", String(1n << 3n)), {
    overwrites: [role("1")],
    preservedPermissions: [],
  });
});

test("diff reports add, remove, change, unchanged and allow/deny/inherit transitions", () => {
  const changes = diffPermissionOverwrites(
    [role("1", "1", "2"), role("2", "4"), member("3", "8")],
    [role("1", "2", "1"), role("2", "4"), member("4", "16")],
    { mode: "roles_only" },
  );
  assert.deepEqual(
    changes.map((item) => item.status),
    ["changed", "unchanged", "removed", "added"],
  );
  assert.deepEqual(
    changes[0]?.transitions.map(({ from, to }) => `${from}->${to}`),
    ["allow->deny", "deny->allow"],
  );
  assert.deepEqual(changes[2]?.toInherit, ["Administrator"]);
  assert.deepEqual(changes[3]?.toAllow, ["Manage Channels"]);
});

test("diff uses sparse Discord permission names through current bit 52", () => {
  const bits = [47, 48, 49, 50, 51, 52];
  const allow = String(bits.reduce((value, bit) => value | (1n << BigInt(bit)), 0n));
  assert.deepEqual(diffPermissionOverwrites([], [role("1", allow)])[0]?.toAllow, [
    "Permission 47",
    "Set Voice Channel Status",
    "Send Polls",
    "Use External Apps",
    "Pin Messages",
    "Bypass Slowmode",
  ]);
});

test("fingerprints are deterministic and include channel movement and type", async () => {
  const base = {
    id: "10",
    guildId: "1",
    type: 0,
    parentId: "2",
    permissionOverwrites: [member("4"), role("3", "1")],
  };
  const reordered = { ...base, permissionOverwrites: [role("3", "01"), member("4", "00")] };
  assert.equal(
    await fingerprintChannelPermissionState(base),
    await fingerprintChannelPermissionState(reordered),
  );
  assert.notEqual(
    await fingerprintChannelPermissionState(base),
    await fingerprintChannelPermissionState({ ...base, parentId: "9" }),
  );
  assert.notEqual(
    await fingerprintChannelPermissionState(base),
    await fingerprintChannelPermissionState({ ...base, type: 5 }),
  );
});

test("selection rejects unsupported, same-channel, and cross-Guild resources", () => {
  const source = { id: "10", guildId: "1", type: 0, parentId: null, permissionOverwrites: [] };
  assert.throws(
    () => validateChannelPermissionCopySelection("1", source, source),
    /Source and target/,
  );
  assert.throws(
    () =>
      validateChannelPermissionCopySelection("1", source, { ...source, id: "11", guildId: "2" }),
    /selected Guild/,
  );
  assert.throws(
    () => validateChannelPermissionCopySelection("1", source, { ...source, id: "11", type: 11 }),
    /cannot own/,
  );
});

test("freshness identifies stale source and target fingerprints", () => {
  const expected = { sourceFingerprint: "source", targetFingerprint: "target" };
  assert.deepEqual(evaluatePreviewFreshness(expected, expected), { ok: true });
  assert.deepEqual(
    evaluatePreviewFreshness(expected, { ...expected, sourceFingerprint: "changed" }),
    { ok: false, code: "stale_source" },
  );
  assert.deepEqual(
    evaluatePreviewFreshness(expected, {
      sourceFingerprint: "changed",
      targetFingerprint: "changed",
    }),
    { ok: false, code: "stale_source_and_target" },
  );
});

test("safety evaluation returns reusable permission, reference, hierarchy, lockout and sync findings", () => {
  const result = evaluatePermissionCopySafety({
    guildId: "1",
    actorIsOwner: false,
    actorPermissions: "0",
    botPermissionsBefore: String(1n << 4n),
    botPermissionsAfter: "0",
    botHighestRolePosition: 5,
    roles: [
      { id: "2", position: 6 },
      { id: "3", position: 1, managed: true },
    ],
    validMemberIds: new Set(),
    resultingOverwrites: [role("2"), role("3"), role("4"), member("5")],
    targetIsCategory: true,
    targetWasCategorySynced: true,
    resultMatchesCategory: false,
  });
  assert.deepEqual(
    result.blockers.map((item) => item.code),
    [
      "actor_permission_missing",
      "bot_manage_roles_missing",
      "role_hierarchy",
      "managed_role",
      "missing_role",
      "missing_member",
      "bot_self_lockout",
    ],
  );
  assert.deepEqual(
    result.warnings.map((item) => item.code),
    ["category_sync_lost", "category_children_unchanged"],
  );
});

test("owner and administrator bypass actor and bot permission blockers", () => {
  const result = evaluatePermissionCopySafety({
    guildId: "1",
    actorIsOwner: true,
    actorPermissions: "0",
    botPermissionsBefore: "8",
    botPermissionsAfter: "0",
    botHighestRolePosition: null,
    roles: [],
    validMemberIds: new Set(),
    resultingOverwrites: [],
  });
  assert.deepEqual(result.blockers, []);
});

test("safety blocks allow and deny bits outside HAF Bot's settable permission mask", () => {
  const manageable = (1n << 4n) | (1n << 10n) | (1n << 28n);
  const unsupported = (1n << 11n) | (1n << 52n);
  const result = evaluatePermissionCopySafety({
    guildId: "1",
    actorIsOwner: true,
    actorPermissions: "0",
    botPermissionsBefore: String(manageable),
    botPermissionsAfter: String(manageable),
    botSettablePermissions: String(manageable),
    botHighestRolePosition: null,
    roles: [],
    validMemberIds: new Set(),
    resultingOverwrites: [role("1", String(1n << 11n), String(1n << 52n))],
  });
  assert.deepEqual(result.blockers, [
    {
      code: "bot_permission_bits_unsettable",
      message:
        "HAF Bot cannot set these permissions on the target: Send Messages, Bypass Slowmode.",
    },
  ]);

  assert.deepEqual(
    evaluatePermissionCopySafety({
      guildId: "1",
      actorIsOwner: true,
      actorPermissions: "0",
      botPermissionsBefore: String(manageable),
      botPermissionsAfter: String(manageable),
      botSettablePermissions: String(manageable | unsupported),
      botHighestRolePosition: null,
      roles: [],
      validMemberIds: new Set(),
      resultingOverwrites: [role("1", String(unsupported))],
    }).blockers,
    [],
  );
});

test("safety treats loss of effective Manage Roles as bot self-lockout", () => {
  const before = (1n << 4n) | (1n << 10n) | (1n << 28n);
  const after = (1n << 4n) | (1n << 10n);
  const result = evaluatePermissionCopySafety({
    guildId: "1",
    actorIsOwner: true,
    actorPermissions: "0",
    botPermissionsBefore: String(before),
    botPermissionsAfter: String(after),
    botHighestRolePosition: null,
    roles: [],
    validMemberIds: new Set(),
    resultingOverwrites: [],
  });
  assert.deepEqual(
    result.blockers.map((item) => item.code),
    ["bot_self_lockout"],
  );
});

test("safety reports visible HAF Bot access preservation", () => {
  const required = (1n << 4n) | (1n << 10n) | (1n << 28n);
  const result = evaluatePermissionCopySafety({
    guildId: "1",
    actorIsOwner: true,
    actorPermissions: "0",
    botPermissionsBefore: String(required),
    botPermissionsAfter: String(required),
    botSettablePermissions: String(required),
    botHighestRolePosition: null,
    roles: [],
    validMemberIds: new Set(["99"]),
    resultingOverwrites: [member("99", String(required))],
    botRecoveryPermissions: ["View Channel", "Manage Roles"],
  });

  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, [
    {
      code: "bot_access_preserved",
      message: "HAF Bot safety access will be added for: View Channel, Manage Roles.",
    },
  ]);
});

test("preview tokens verify statelessly with signed nonces and reject expiry and tampering", async () => {
  const manager = createPreviewTokenManager("a sufficiently long test secret");
  const claims = {
    guildId: "1",
    actorUserId: "2",
    sourceChannelId: "3",
    targetChannelId: "4",
    mode: "exact" as const,
    sourceFingerprint: "source",
    targetFingerprint: "target",
    expiresAtMs: 2_000,
  };
  const token = await manager.sign(claims);
  const verified = await manager.verify(token, 1_000);
  assert.deepEqual(verified, { ...claims, nonce: verified.nonce });
  assert.match(verified.nonce, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await manager.verify(token, 1_000), verified);
  const expired = await manager.sign({ ...claims, expiresAtMs: 999 });
  await assert.rejects(() => manager.verify(expired, 1_000), /preview token expired/);
  await assert.rejects(
    () => manager.verify(`${token.slice(0, -1)}x`, 1_000),
    /preview token invalid/,
  );
});
