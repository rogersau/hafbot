import { isRecord } from "../unknown-parse";
import type { CreateChannelMessageInput } from "../discord/messages";
import type { ComponentIdPurpose, ComponentIdSigner } from "./component-id-signer";

// Ticket close confirmation controls were already issued as Guild-bound envelopes before
// actor binding was added. Keep their exact no-claim envelopes on the existing
// COMPONENT_ID_LEGACY_UNTIL migration path; remove this compatibility set once that
// deployment window has elapsed everywhere.
const LEGACY_GUILD_BOUND_PURPOSES = new Set<ComponentIdPurpose>([
  "ticket-close-confirm",
  "ticket-close-decline",
]);

// Bot Defense controls used to carry only Guild/member identity. Those signed envelopes remain
// verifiable during the component-ID migration window, but the Bot Defense handler rejects the
// payload shape instead of resolving whichever generation is currently open.
const LEGACY_GENERATION_BOUND_PURPOSES = new Set<ComponentIdPurpose>([
  "bot-defense-confirm",
  "bot-defense-dismiss",
]);

const ACTOR_BOUND_PURPOSES = new Set<ComponentIdPurpose>([
  "ban-case-enforcement",
  "member-verification-dm",
  "lfg-renew",
  "lfg-application-accept",
  "lfg-application-reject",
  "lfg-close-confirm",
  "lfg-close-cancel",
  "ticket-close-confirm",
  "ticket-close-decline",
  "ticket-template-reply",
]);

export interface SensitiveComponentIdContext {
  guildId?: string;
  actorUserId?: string;
  expiresAtMs?: number;
}

export function sensitiveComponentPurpose(customId: string): ComponentIdPurpose | null {
  if (customId.startsWith("bce:")) return "ban-case-enforcement";
  if (customId.startsWith("ban-case:actions:")) return "ban-case-actions";
  if (customId.startsWith("ban-case:complete:")) return "ban-case-complete";
  if (customId.startsWith("bot-defense:confirm:")) return "bot-defense-confirm";
  if (customId.startsWith("bot-defense:dismiss:")) return "bot-defense-dismiss";
  if (customId.startsWith("image-rules:approve:")) return "image-rules-approve";
  if (customId.startsWith("image-rules:restore:")) return "image-rules-restore";
  if (customId.startsWith("evidence-vault:see:")) return "evidence-vault-view";
  if (customId.startsWith("evidence-vault:details:")) return "evidence-vault-details";
  if (customId.startsWith("clan:review:")) {
    const decision = customId.split(":")[4];
    return decision === "approve"
      ? "clan-review-approve"
      : decision === "request-changes"
        ? "clan-review-request-changes"
        : decision === "reject"
          ? "clan-review-reject"
          : null;
  }
  if (customId.startsWith("clan:review-reason:")) return "clan-review-reason";
  if (customId.startsWith("suggestions:reply-resolution:")) {
    const action = customId.split(":")[2];
    return action === "keep"
      ? "suggestion-reply-keep"
      : action === "restore"
        ? "suggestion-reply-restore"
        : action === "delete"
          ? "suggestion-reply-delete"
          : null;
  }
  if (customId.startsWith("suggestions:reply-delete-submit:")) {
    return "suggestion-reply-delete-submit";
  }
  if (customId.startsWith("suggestions:author-status:")) return "suggestion-author-status";
  if (customId.startsWith("ticket:claim:")) return "ticket-claim";
  if (customId.startsWith("ticket:close:")) return "ticket-close";
  if (customId.startsWith("ticket:close-request:")) return "ticket-close-request";
  if (customId.startsWith("ticket:close-confirm:")) return "ticket-close-confirm";
  if (customId.startsWith("ticket:close-decline:")) return "ticket-close-decline";
  if (customId.startsWith("ticket:template-reply:")) return "ticket-template-reply";
  if (customId.startsWith("member_verification_verify:")) {
    return "member-verification-panel";
  }
  if (customId.startsWith("lfg:renew:")) return "lfg-renew";
  if (customId.startsWith("lfg:application-accept:")) return "lfg-application-accept";
  if (customId.startsWith("lfg:application-reject:")) return "lfg-application-reject";
  if (customId.startsWith("lfg:close-confirm:")) return "lfg-close-confirm";
  if (customId.startsWith("lfg:close-cancel:")) return "lfg-close-cancel";
  if (customId.startsWith("commerce-review:")) {
    const decision = customId.split(":")[2];
    return decision === "approve"
      ? "commerce-review-approve"
      : decision === "reject"
        ? "commerce-review-reject"
        : null;
  }
  return null;
}

export function isActorBoundSensitiveComponentId(purpose: ComponentIdPurpose): boolean {
  return ACTOR_BOUND_PURPOSES.has(purpose);
}

export async function signSensitiveComponentId(
  customId: string,
  signer: ComponentIdSigner | undefined,
  context: SensitiveComponentIdContext = {},
): Promise<string> {
  const detectedPurpose = sensitiveComponentPurpose(customId);
  const purpose =
    detectedPurpose === "member-verification-panel" && context.actorUserId
      ? "member-verification-dm"
      : detectedPurpose;
  if (!purpose || !signer) return customId;
  const guildId = context.guildId ?? guildIdFromComponentId(customId);
  if (!guildId) {
    throw new Error(`Sensitive ${purpose} component ID is missing a Guild claim.`);
  }
  const actorUserId = isActorBoundSensitiveComponentId(purpose) ? context.actorUserId : undefined;
  if (isActorBoundSensitiveComponentId(purpose) && !actorUserId) {
    throw new Error(`Sensitive ${purpose} component ID is missing an actor claim.`);
  }
  return signer.issue({
    purpose,
    customId: compactSignedPayload(customId, purpose),
    guildId,
    actorUserId,
    ...(context.expiresAtMs &&
    isActorBoundSensitiveComponentId(purpose) &&
    purpose !== "ticket-template-reply"
      ? { expiresAtMs: context.expiresAtMs }
      : {}),
  });
}

export async function signSensitiveMessageComponentIds(
  body: CreateChannelMessageInput,
  signer: ComponentIdSigner | undefined,
  context: SensitiveComponentIdContext = {},
): Promise<CreateChannelMessageInput> {
  if (!signer || !body.components) return body;
  return {
    ...body,
    components: await Promise.all(
      body.components.map((row) => signMessageComponentRow(row, signer, context)),
    ),
  };
}

export async function verifySensitiveComponentId(
  customId: string,
  signer: ComponentIdSigner,
  context: { interactionGuildId?: string; actorUserId?: string },
): Promise<
  | { kind: "not-sensitive" }
  | { kind: "legacy"; purpose: ComponentIdPurpose; customId?: string }
  | { kind: "valid"; purpose: ComponentIdPurpose; customId: string }
  | { kind: "invalid" }
> {
  const inspection = signer.inspect(customId);
  if (!inspection) {
    if (customId.startsWith("1")) return { kind: "invalid" };
    const purpose = sensitiveComponentPurpose(customId);
    return purpose ? { kind: "legacy", purpose } : { kind: "not-sensitive" };
  }
  const restoredCustomId = restoreSignedPayload(inspection.customId, inspection.purpose);
  const guildId = context.interactionGuildId ?? guildIdFromComponentId(restoredCustomId);
  if (!guildId) return { kind: "invalid" };

  // Before ticket-close-confirm and ticket-close-decline became actor-bound, their signed
  // envelopes had neither actor nor expiry claims. Re-verify that exact old envelope without
  // claims so changing the purpose policy does not turn already-posted prompts into opaque
  // signature failures. The interaction handler applies COMPONENT_ID_LEGACY_UNTIL to this
  // result; new envelopes always take the actor-bound path below.
  if (inspection.expiresAtSeconds === null && LEGACY_GUILD_BOUND_PURPOSES.has(inspection.purpose)) {
    const legacyVerified = await signer.verify(customId, { guildId });
    if (legacyVerified.ok) {
      return {
        kind: "legacy",
        purpose: legacyVerified.purpose,
        customId: restoredCustomId,
      };
    }
  }

  if (
    inspection.expiresAtSeconds === null &&
    LEGACY_GENERATION_BOUND_PURPOSES.has(inspection.purpose) &&
    isLegacyBotDefensePayload(restoredCustomId)
  ) {
    const legacyVerified = await signer.verify(customId, { guildId });
    if (legacyVerified.ok) {
      return {
        kind: "legacy",
        purpose: legacyVerified.purpose,
        customId: restoredCustomId,
      };
    }
  }

  const actorUserId = isActorBoundSensitiveComponentId(inspection.purpose)
    ? context.actorUserId
    : undefined;
  if (isActorBoundSensitiveComponentId(inspection.purpose) && !actorUserId)
    return { kind: "invalid" };
  const verified = await signer.verify(customId, { guildId, actorUserId });
  return verified.ok
    ? {
        kind: "valid",
        purpose: verified.purpose,
        customId: restoreSignedPayload(verified.customId, verified.purpose),
      }
    : { kind: "invalid" };
}

function guildIdFromComponentId(customId: string): string | undefined {
  if (
    customId.startsWith("ban-case:actions:") ||
    customId.startsWith("ban-case:complete:") ||
    customId.startsWith("bot-defense:") ||
    customId.startsWith("lfg:renew:") ||
    customId.startsWith("lfg:application-accept:") ||
    customId.startsWith("lfg:application-reject:")
  ) {
    return customId.split(":")[2] || undefined;
  }
  if (customId.startsWith("member_verification_verify:")) {
    return customId.slice("member_verification_verify:".length) || undefined;
  }
  return undefined;
}

function isLegacyBotDefensePayload(customId: string): boolean {
  const parts = customId.split(":");
  return parts[0] === "bot-defense" && parts.length === 4;
}

function compactSignedPayload(customId: string, purpose: ComponentIdPurpose): string {
  if (purpose === "lfg-application-accept" || purpose === "lfg-application-reject") {
    const prefix = `lfg:${purpose === "lfg-application-accept" ? "application-accept" : "application-reject"}:`;
    return customId.startsWith(prefix) ? `~${customId.slice(prefix.length)}` : customId;
  }
  if (purpose !== "ticket-template-reply") return customId;
  const prefix = "ticket:template-reply:";
  const [channelId, templateId, updatedAtMs] = customId.slice(prefix.length).split(":");
  const revision = Number(updatedAtMs);
  if (!channelId || !templateId || !Number.isSafeInteger(revision)) return customId;
  return `${prefix}${channelId}:${templateId}:~${revision.toString(36)}`;
}

function restoreSignedPayload(customId: string, purpose: ComponentIdPurpose): string {
  if (purpose === "lfg-application-accept" || purpose === "lfg-application-reject") {
    if (!customId.startsWith("~")) return customId;
    const action =
      purpose === "lfg-application-accept" ? "application-accept" : "application-reject";
    return `lfg:${action}:${customId.slice(1)}`;
  }
  if (purpose !== "ticket-template-reply") return customId;
  const prefix = "ticket:template-reply:";
  const [channelId, templateId, encodedRevision] = customId.slice(prefix.length).split(":");
  if (!channelId || !templateId || !encodedRevision?.startsWith("~")) return customId;
  const revision = Number.parseInt(encodedRevision.slice(1), 36);
  return Number.isSafeInteger(revision)
    ? `${prefix}${channelId}:${templateId}:${revision}`
    : customId;
}

async function signMessageComponentRow(
  row: unknown,
  signer: ComponentIdSigner,
  context: SensitiveComponentIdContext,
): Promise<unknown> {
  if (!isRecord(row) || !Array.isArray(row.components)) return row;
  return {
    ...row,
    components: await Promise.all(
      row.components.map(async (component) => {
        if (!isRecord(component) || typeof component.custom_id !== "string") return component;
        return {
          ...component,
          custom_id: await signSensitiveComponentId(component.custom_id, signer, context),
        };
      }),
    ),
  };
}
