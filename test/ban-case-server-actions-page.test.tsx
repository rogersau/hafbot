import assert from "node:assert/strict";
import test from "node:test";
import { withAdminDom } from "./support/admin-dom";

test("Ban Case server action UI keeps completion independent and does not offer unverified targets", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    globalThis.fetch = async () =>
      Response.json({
        cases: [
          {
            caseId: "case",
            username: "Reported",
            subject: { id: "76561198000000001" },
            status: "completed",
          },
        ],
        targets: [{ id: "target", name: "Prepared WARDOGS", ban: false, unban: false }],
        operations: [
          {
            id: "op",
            action: "ban",
            subject: "76561198000000001",
            targetLabel: "Prepared WARDOGS",
            state: "needs-attention",
            outcome: "prior command may still apply; do not resend",
            transmittedAtMs: 1,
          },
        ],
      });
    const { BanCaseServerActions } =
      await import("../src/admin/components/ban-case-server-actions");
    await render(<BanCaseServerActions guildId="guild-1" workspaceId="workspace" />);
    await click("Load cases and server actions");
    assert.match(container.textContent ?? "", /completed/);
    assert.match(container.textContent ?? "", /not ready/);
    assert.match(container.textContent ?? "", /needs-attention/);
    assert.match(container.textContent ?? "", /independent of Mark Completed/);
    assert.equal(
      Array.from(container.querySelectorAll("button")).some(
        (b) => b.textContent === "Cancel undispatched request",
      ),
      false,
    );
    const review = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Review server action",
    );
    assert.ok(review?.disabled);
  });
});
