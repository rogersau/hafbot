import { EnforcementError } from "../ban-case-enforcement/model";
import type { DiscordInteraction } from "./app-types";
import type { BanCaseEnforcement } from "../ban-case-enforcement/service";
import type { WardogsService } from "../wardogs/service";
import type { ComponentIdSigner } from "../security/component-id-signer";
import { signSensitiveComponentId } from "../security/sensitive-component-ids";
import {
  getInteractionCustomId,
  getInteractionUserId,
  parseInteractionModalFieldValues,
} from "./discord-interaction-parsers";
import { buildEphemeralMessage } from "../discord-interactions";
import { isRecord } from "../unknown-parse";

export async function handleBanEnforcementInteraction(
  interaction: DiscordInteraction,
  service: BanCaseEnforcement | undefined,
  wardogs: WardogsService | undefined,
  signer?: ComponentIdSigner,
) {
  const guildId = interaction.guild_id;
  const actorId = getInteractionUserId(interaction);
  const customId = getInteractionCustomId(interaction) ?? "";
  const respond = (content: string) => Response.json(buildEphemeralMessage(content));
  if (!guildId || !actorId || !service || !wardogs)
    return respond("Ban Case server actions are unavailable.");
  const signed = (id: string) =>
    signSensitiveComponentId(id, signer, {
      guildId,
      actorUserId: actorId,
      expiresAtMs: Date.now() + 5 * 60_000,
    });
  try {
    if (customId.startsWith("ban-case:actions:")) {
      const [, , boundGuild, caseId] = customId.split(":");
      if (boundGuild !== guildId || !caseId)
        return respond("This action belongs to another Guild.");
      const operations = await service.list(guildId, actorId);
      const targets = (await wardogs.list(guildId)).filter((t) => t.banCasesEnabled);
      const choices = [];
      for (const target of targets)
        for (const action of ["ban", "unban"] as const) {
          if ((await wardogs.banReadiness(guildId, target.id, action)).ready)
            choices.push({
              label: `${action}: ${target.name}`.slice(0, 100),
              value: `${action}:${target.id}`,
            });
        }
      const history = operations
        .filter((op) => op.caseId === caseId)
        .slice(0, 5)
        .map((op) => `${op.action} · ${op.targetLabel}: ${op.state} — ${op.outcome}`)
        .join("\n");
      if (!choices.length)
        return respond(
          `${history}\nNo enabled, approved Ban Case targets are ready. Ask a Guild Admin to configure WARDOGS access.`,
        );
      return Response.json({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content: `${history}\nChoose exactly one target and action. Case completion is independent.`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 3,
                  custom_id: await signed(`bce:select:${caseId}`),
                  options: choices,
                  min_values: 1,
                  max_values: 1,
                },
              ],
            },
          ],
        },
      });
    }
    const [, stage, id] = customId.split(":");
    if (!id) return respond("Invalid server action.");
    if (stage === "select") {
      const values = isRecord(interaction.data) ? interaction.data.values : null;
      const value =
        Array.isArray(values) && values.length === 1 && typeof values[0] === "string"
          ? values[0]
          : "";
      const [action, targetId] = value.split(":");
      if ((action !== "ban" && action !== "unban") || !targetId)
        return respond("Select one target and action.");
      const draft = await service.select({ guildId, actorId, caseId: id, targetId, action });
      return Response.json({
        type: 9,
        data: {
          title: `${action === "ban" ? "Ban" : "Unban"}: required reason`,
          custom_id: await signed(`bce:reason:${draft.id}`),
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "reason",
                  label: "Staff reason (maximum 500 characters)",
                  style: 2,
                  required: true,
                  min_length: 1,
                  max_length: 500,
                },
              ],
            },
          ],
        },
      });
    }
    if (stage === "reason") {
      const reason = parseInteractionModalFieldValues(interaction).reason ?? "";
      const intent = await service.submitReason(id, guildId, actorId, reason);
      return Response.json({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content: `Confirm ${intent.action}\nCase: ${intent.caseId}\nTarget: ${intent.targetLabel}\nExact SteamID64: ${intent.subject}\nReason: ${intent.reason}\nSubject came from an external report. Ownership is not verified. Expires in five minutes.`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 4,
                  label: `Confirm ${intent.action}`,
                  custom_id: await signed(`bce:confirm:${intent.id}`),
                },
              ],
            },
          ],
        },
      });
    }
    if (stage === "confirm") {
      const op = await service.confirm(id, guildId, actorId);
      return respond(
        `Request ${op.id} persisted: ${op.state}. Acknowledgement is not verified server delivery.`,
      );
    }
    return respond("Unsupported server action.");
  } catch (error) {
    // Only feature-authored validation messages are exposed; provider errors use safe codes.
    return respond(
      error instanceof EnforcementError
        ? error.message
        : "Server action unavailable. No new request was acknowledged.",
    );
  }
}
