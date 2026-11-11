import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBotDefenseComponentId,
  parseBotDefenseComponentId,
} from "../src/bot-defense-component-id";
import { createComponentIdSigner } from "../src/security/component-id-signer";
import {
  signSensitiveComponentId,
  signSensitiveMessageComponentIds,
  verifySensitiveComponentId,
} from "../src/security/sensitive-component-ids";

const CURRENT_SECRET = "current-component-id-signing-secret-32";
const PREVIOUS_SECRET = "previous-component-id-signing-secret-32";
const TICKET_CLOSE_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

test("Ban Case and LFG controls retain distinct signed purposes", async () => {
  const signer = createComponentIdSigner({ currentSecret: CURRENT_SECRET });
  const controls = [
    { customId: "ban-case:actions:guild:case", purpose: "ban-case-actions", code: "E" },
    { customId: "bce:confirm:request", purpose: "ban-case-enforcement", code: "F" },
    { customId: "lfg:close-confirm:post", purpose: "lfg-close-confirm", code: "G" },
    { customId: "lfg:close-cancel:post", purpose: "lfg-close-cancel", code: "H" },
  ] as const;
  for (const { customId, purpose, code } of controls) {
    const signed = await signSensitiveComponentId(customId, signer, {
      guildId: "guild",
      actorUserId: "owner",
      expiresAtMs: Date.now() + 60_000,
    });
    assert.equal(signed.startsWith(`1${code}.`), true);
    assert.deepEqual(
      await verifySensitiveComponentId(signed, signer, {
        interactionGuildId: "guild",
        actorUserId: "owner",
      }),
      { kind: "valid", purpose, customId },
    );
  }
});

test("Bot Defense component IDs bind the flag generation and reject legacy shapes", async () => {
  const signer = createComponentIdSigner({ currentSecret: CURRENT_SECRET });
  const raw = buildBotDefenseComponentId("confirm", "guild", "member", 1_760_000_000_000);
  const signed = await signSensitiveComponentId(raw, signer, { guildId: "guild" });

  assert.equal(signed.length <= 100, true);
  assert.deepEqual(
    await verifySensitiveComponentId(signed, signer, { interactionGuildId: "guild" }),
    { kind: "valid", purpose: "bot-defense-confirm", customId: raw },
  );
  assert.deepEqual(parseBotDefenseComponentId(raw), {
    action: "confirm",
    guildId: "guild",
    userId: "member",
    createdAtMs: 1_760_000_000_000,
  });
  assert.equal(parseBotDefenseComponentId("bot-defense:confirm:guild:member"), null);
  const legacySigned = await signSensitiveComponentId("bot-defense:confirm:guild:member", signer, {
    guildId: "guild",
  });
  assert.deepEqual(
    await verifySensitiveComponentId(legacySigned, signer, { interactionGuildId: "guild" }),
    { kind: "invalid" },
  );
});

test("component IDs are purpose, Guild, actor, and expiry bound", async () => {
  const signer = createComponentIdSigner(
    { currentSecret: CURRENT_SECRET },
    { now: () => 1_000_000 },
  );
  const id = await signer.issue({
    purpose: "lfg-renew",
    customId: "lfg:renew:guild:post",
    guildId: "guild",
    actorUserId: "owner",
    expiresAtMs: 1_600_000,
  });

  assert.equal(id.length <= 100, true);
  assert.deepEqual(await signer.verify(id, { guildId: "guild", actorUserId: "owner" }), {
    ok: true,
    purpose: "lfg-renew",
    customId: "lfg:renew:guild:post",
    expiresAtSeconds: 1600,
  });
  assert.equal((await signer.verify(id, { guildId: "other", actorUserId: "owner" })).ok, false);
  assert.equal((await signer.verify(id, { guildId: "guild", actorUserId: "other" })).ok, false);
  assert.equal(
    (
      await signer.verify(id.replace("lfg:renew", "lfg:close"), {
        guildId: "guild",
        actorUserId: "owner",
      })
    ).ok,
    false,
  );
  assert.equal(
    (await signer.verify(id.replace(/^1y/, "1q"), { guildId: "guild", actorUserId: "owner" })).ok,
    false,
  );
  assert.equal((await signer.verify(id, { guildId: "guild", actorUserId: "owner" })).ok, true);
});

test("component IDs reject expiry misuse and accept a previous rotation key", async () => {
  const oldSigner = createComponentIdSigner(
    { currentSecret: PREVIOUS_SECRET },
    { now: () => 1_000_000 },
  );
  const oldId = await oldSigner.issue({
    purpose: "ticket-claim",
    customId: "ticket:claim:123456789012345678",
    guildId: "guild",
  });
  const signer = createComponentIdSigner(
    { currentSecret: CURRENT_SECRET, previousSecret: PREVIOUS_SECRET },
    { now: () => 1_000_000 },
  );
  assert.equal((await signer.verify(oldId, { guildId: "guild" })).ok, true);

  const expiringId = await signer.issue({
    purpose: "member-verification-dm",
    customId: "member_verification_verify:guild",
    guildId: "guild",
    actorUserId: "member",
    expiresAtMs: 1_010_000,
  });
  const expiredSigner = createComponentIdSigner(
    { currentSecret: CURRENT_SECRET },
    { now: () => 1_050_000 },
  );
  assert.deepEqual(
    await expiredSigner.verify(expiringId, { guildId: "guild", actorUserId: "member" }),
    {
      ok: false,
      reason: "expired",
    },
  );
  await assert.rejects(
    () =>
      signer.issue({
        purpose: "ticket-claim",
        customId: "ticket:claim:123456789012345678",
        guildId: "guild",
        expiresAtMs: 90_000_000,
      }),
    /within 24 hours/,
  );
});

test("component ID signer rejects malformed envelopes and overlong IDs", async () => {
  const signer = createComponentIdSigner({ currentSecret: CURRENT_SECRET });
  assert.deepEqual(await signer.verify("2q.payload.tag", { guildId: "guild" }), {
    ok: false,
    reason: "unsupported_version",
  });
  assert.deepEqual(await signer.verify("1q.invalid.payload.tag", { guildId: "guild" }), {
    ok: false,
    reason: "malformed",
  });
  await assert.rejects(
    () =>
      signer.issue({
        purpose: "ticket-template-reply",
        customId: `ticket:template-reply:${"a".repeat(100)}`,
        guildId: "guild",
      }),
    /100-character limit/,
  );
});

test("ticket close confirmation controls bind the opener and expire after 24 hours", async () => {
  let nowMs = 1_700_000_000_000;
  const signer = createComponentIdSigner({ currentSecret: CURRENT_SECRET }, { now: () => nowMs });
  const rawIds = [
    "ticket:close-confirm:123456789012345678",
    "ticket:close-decline:123456789012345678",
  ];
  const expiresAtMs = nowMs + TICKET_CLOSE_CONFIRMATION_TTL_MS;
  const signedBody = await signSensitiveMessageComponentIds(
    {
      components: [
        {
          type: 1,
          components: rawIds.map((custom_id) => ({ type: 2, custom_id })),
        },
      ],
    },
    signer,
    { guildId: "guild", actorUserId: "opener", expiresAtMs },
  );
  const signedIds = (
    (signedBody.components?.[0] as { components?: Array<{ custom_id?: string }> })?.components ?? []
  ).map((component) => component.custom_id);

  assert.equal(signedIds.length, rawIds.length);
  for (const [index, signed] of signedIds.entries()) {
    assert.ok(signed);
    assert.equal(signed.length <= 100, true);
    assert.deepEqual(signer.inspect(signed), {
      purpose: index === 0 ? "ticket-close-confirm" : "ticket-close-decline",
      customId: rawIds[index],
      expiresAtSeconds: Math.floor(expiresAtMs / 1000),
    });
    assert.deepEqual(
      await verifySensitiveComponentId(signed, signer, {
        interactionGuildId: "guild",
        actorUserId: "opener",
      }),
      {
        kind: "valid",
        purpose: index === 0 ? "ticket-close-confirm" : "ticket-close-decline",
        customId: rawIds[index],
      },
    );
    assert.equal(
      (
        await verifySensitiveComponentId(signed, signer, {
          interactionGuildId: "guild",
          actorUserId: "different-user",
        })
      ).kind,
      "invalid",
    );
  }

  nowMs = expiresAtMs + 31_000;
  for (const signed of signedIds) {
    assert.equal(
      (
        await verifySensitiveComponentId(signed ?? "", signer, {
          interactionGuildId: "guild",
          actorUserId: "opener",
        })
      ).kind,
      "invalid",
    );
  }
});

test("ticket close confirmation rejects old guild-only envelopes", async () => {
  const signer = createComponentIdSigner({ currentSecret: CURRENT_SECRET });
  const legacyCases = [
    {
      purpose: "ticket-close-confirm" as const,
      customId: "ticket:close-confirm:123456789012345678",
    },
    {
      purpose: "ticket-close-decline" as const,
      customId: "ticket:close-decline:123456789012345678",
    },
  ];

  for (const legacyCase of legacyCases) {
    const existingEnvelope = await signer.issue({
      purpose: legacyCase.purpose,
      customId: legacyCase.customId,
      guildId: "guild",
    });
    assert.equal(signer.inspect(existingEnvelope)?.expiresAtSeconds, null);
    assert.deepEqual(
      await verifySensitiveComponentId(existingEnvelope, signer, {
        interactionGuildId: "guild",
        actorUserId: "opener",
      }),
      { kind: "invalid" },
    );
  }
});

test("ticket template reply IDs remain within Discord's limit", async () => {
  const signer = createComponentIdSigner({ currentSecret: CURRENT_SECRET });
  const raw =
    "ticket:template-reply:123456789012345678:12345678-1234-1234-1234-123456789012:1760000000000";
  const signed = await signSensitiveComponentId(raw, signer, {
    guildId: "guild",
    actorUserId: "staff",
    expiresAtMs: Date.now() + 60_000,
  });
  assert.equal(signed.length <= 100, true);
  assert.deepEqual(
    await verifySensitiveComponentId(signed, signer, {
      interactionGuildId: "guild",
      actorUserId: "staff",
    }),
    {
      kind: "valid",
      purpose: "ticket-template-reply",
      customId: raw,
    },
  );
});

test("LFG application review IDs remain within Discord's limit", async () => {
  const signer = createComponentIdSigner({ currentSecret: CURRENT_SECRET });
  const raw =
    "lfg:application-accept:1234567890123456789:1760000000000-1234567890123456789:9876543210987654321";
  const signed = await signSensitiveComponentId(raw, signer, {
    actorUserId: "1234567890123456789",
    expiresAtMs: Date.now() + 60_000,
  });
  assert.equal(signed.length <= 100, true);
  assert.deepEqual(
    await verifySensitiveComponentId(signed, signer, {
      actorUserId: "1234567890123456789",
    }),
    {
      kind: "valid",
      purpose: "lfg-application-accept",
      customId: raw,
    },
  );
});

test("Ban Case server action confirmations bind actor, Guild and expiry within Discord's ID limit", async () => {
  const now = Date.now();
  const signer = createComponentIdSigner({ currentSecret: CURRENT_SECRET }, { now: () => now });
  const raw = `bce:confirm:${crypto.randomUUID()}`;
  const signed = await signSensitiveComponentId(raw, signer, {
    guildId: "1234567890123456789",
    actorUserId: "staff",
    expiresAtMs: now + 300000,
  });
  assert.ok(signed.length <= 100);
  assert.equal(
    (
      await verifySensitiveComponentId(signed, signer, {
        interactionGuildId: "1234567890123456789",
        actorUserId: "staff",
      })
    ).kind,
    "valid",
  );
  assert.equal(
    (
      await verifySensitiveComponentId(signed, signer, {
        interactionGuildId: "other",
        actorUserId: "staff",
      })
    ).kind,
    "invalid",
  );
  assert.equal(
    (
      await verifySensitiveComponentId(signed, signer, {
        interactionGuildId: "1234567890123456789",
        actorUserId: "other",
      })
    ).kind,
    "invalid",
  );
  const start = await signSensitiveComponentId(
    `ban-case:actions:1234567890123456789:${crypto.randomUUID()}`,
    signer,
  );
  assert.ok(start.length <= 100);
});
