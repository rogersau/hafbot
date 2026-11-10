import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemberVerificationReturnTo,
  consumeMemberVerificationPrerequisiteReturn,
  parseSafeMemberVerificationReturnTo,
  persistMemberVerificationDraft,
} from "../src/admin/lib/member-verification-prerequisite";
import type { MemberVerificationConfigSnapshot } from "../src/admin/components/admin-member-verification-page";

const draft: MemberVerificationConfigSnapshot = {
  enabled: true,
  verifiedRoleId: "role-1",
  title: "Welcome",
  description: "Please verify",
  color: 0x5865f2,
  imageUrl: "",
  thumbnailUrl: "",
  rulesUrl: "",
  verifyButtonEmoji: "",
  deliveryMode: "dm",
  verificationMethod: "steam-link",
  welcomeChannelId: "",
  panelMessageId: "",
};

test("Member Verification prerequisite return accepts only same-Guild internal destinations", () => {
  const returnTo = buildMemberVerificationReturnTo("guild/one", "workspace-1", "draft-1");
  assert.deepEqual(parseSafeMemberVerificationReturnTo(returnTo, "guild/one"), {
    href: "/admin/guild%2Fone/member-verification?workspaceId=workspace-1&mvDraftKey=draft-1",
    draftKey: "draft-1",
  });
  assert.equal(parseSafeMemberVerificationReturnTo(returnTo, "other-guild"), null);
  assert.equal(parseSafeMemberVerificationReturnTo(returnTo, "guild/one", "workspace-2"), null);
  assert.equal(
    parseSafeMemberVerificationReturnTo(
      "https://evil.example/admin/guild/member-verification?mvDraftKey=x&workspaceId=w",
      "guild",
    ),
    null,
  );
  assert.equal(
    parseSafeMemberVerificationReturnTo(
      "/admin/guild/player-link?mvDraftKey=x&workspaceId=w",
      "guild",
    ),
    null,
  );
});

test("Member Verification prerequisite return works without a workspace and keeps Guild isolation", () => {
  const returnTo = buildMemberVerificationReturnTo("guild-1", "", "draft-1");
  assert.equal(returnTo, "/admin/guild-1/member-verification?mvDraftKey=draft-1");
  assert.deepEqual(parseSafeMemberVerificationReturnTo(returnTo, "guild-1", ""), {
    href: returnTo,
    draftKey: "draft-1",
  });
  assert.equal(parseSafeMemberVerificationReturnTo(returnTo, "other-guild", ""), null);
  assert.equal(parseSafeMemberVerificationReturnTo(returnTo, "guild-1", "workspace-1"), null);
  assert.equal(
    parseSafeMemberVerificationReturnTo("/admin/guild-1/member-verification", "guild-1", ""),
    null,
  );
});

test("Member Verification prerequisite draft restores complete/cancel outcomes with optional workspace context", () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const values = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    sessionStorage: {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    },
  };
  try {
    for (const workspaceId of ["", "workspace-1"]) {
      for (const outcome of ["complete", "cancel"] as const) {
        const draftKey = `draft-${outcome}`;
        persistMemberVerificationDraft(draftKey, "guild-1", workspaceId, draft);
        const returnTo = buildMemberVerificationReturnTo("guild-1", workspaceId, draftKey);
        const safeReturn = parseSafeMemberVerificationReturnTo(returnTo, "guild-1", workspaceId);
        assert.ok(safeReturn);
        const search = `${new URL(safeReturn.href, "https://hafbot.invalid").search}&mvOutcome=${outcome}`;
        assert.deepEqual(
          consumeMemberVerificationPrerequisiteReturn("guild-1", search, workspaceId),
          { outcome, draft },
        );
        assert.equal(values.size, 0);
        assert.equal(
          consumeMemberVerificationPrerequisiteReturn("guild-1", search, workspaceId),
          null,
        );
      }
    }
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("Member Verification prerequisite draft rejects Guild/workspace mismatches and removes the token", () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const values = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    sessionStorage: {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    },
  };
  try {
    persistMemberVerificationDraft("draft-mismatch", "guild-1", "workspace-1", draft);
    assert.equal(
      consumeMemberVerificationPrerequisiteReturn(
        "guild-2",
        "?mvDraftKey=draft-mismatch&mvOutcome=complete",
        "workspace-1",
      ),
      null,
    );
    assert.equal(values.size, 0);
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});
