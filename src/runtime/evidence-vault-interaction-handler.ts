import { buildEphemeralMessage } from "../discord-interactions";
import {
  parseEvidenceVaultSearchCustomId,
  parseEvidenceVaultViewCustomId,
  parseEvidenceVaultDetailsCustomId,
  isEvidenceVaultFieldSearchCustomId,
} from "../evidence-vault";
import {
  DISCORD_CHANNEL_MESSAGE_RESPONSE,
  DISCORD_EPHEMERAL_FLAG,
  DISCORD_MODAL_RESPONSE,
  DISCORD_UPDATE_MESSAGE_RESPONSE,
} from "../discord/constants";
import type { DiscordInteraction } from "./app-types";
import {
  getInteractionCustomId,
  parseInteractionModalFieldValues,
} from "./discord-interaction-parsers";
import type { EvidenceVaultService } from "../evidence-vault";
import type { ComponentIdSigner } from "../security/component-id-signer";
import {
  signSensitiveComponentId,
  signSensitiveMessageComponentIds,
} from "../security/sensitive-component-ids";

export function isEvidenceVaultComponentInteraction(interaction: DiscordInteraction): boolean {
  const customId = getInteractionCustomId(interaction);
  return Boolean(
    customId &&
    (parseEvidenceVaultViewCustomId(customId) ||
      parseEvidenceVaultSearchCustomId(customId) ||
      parseEvidenceVaultDetailsCustomId(customId)),
  );
}

export function isEvidenceVaultModalSubmitInteraction(interaction: DiscordInteraction): boolean {
  const customId = getInteractionCustomId(interaction);
  return Boolean(
    customId &&
    (parseEvidenceVaultDetailsCustomId(customId) || isEvidenceVaultFieldSearchCustomId(customId)),
  );
}

export async function handleEvidenceVaultComponentInteraction(
  interaction: DiscordInteraction,
  service: EvidenceVaultService,
  requestOrigin: string,
  componentIdSigner?: ComponentIdSigner,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  const recordId = customId ? parseEvidenceVaultViewCustomId(customId) : null;
  const detailsRecordId = customId ? parseEvidenceVaultDetailsCustomId(customId) : null;
  const searchPage = customId ? parseEvidenceVaultSearchCustomId(customId) : null;
  if (searchPage) {
    const message = await service.renderEvidenceSearchPage({
      interaction,
      subject: searchPage.subject,
      page: searchPage.page,
    });
    return Response.json(
      message
        ? {
            type: DISCORD_UPDATE_MESSAGE_RESPONSE,
            data: await signSensitiveMessageComponentIds(message, componentIdSigner, {
              guildId: interaction.guild_id,
            }),
          }
        : buildEphemeralMessage("Evidence Vault search is not available."),
    );
  }
  if (detailsRecordId) {
    const result = await service.buildAddDetailsModal({ interaction, recordId: detailsRecordId });
    return Response.json(
      result.ok
        ? {
            type: DISCORD_MODAL_RESPONSE,
            data: {
              ...result.modal,
              custom_id: await signSensitiveComponentId(result.modal.custom_id, componentIdSigner, {
                guildId: interaction.guild_id,
              }),
            },
          }
        : buildEphemeralMessage(result.message),
    );
  }
  if (!recordId) {
    return Response.json(buildEphemeralMessage("Evidence is not available."));
  }
  const result = await service.viewEvidence({ interaction, recordId, requestOrigin });
  return Response.json(buildEphemeralMessage(result.content));
}

export async function handleEvidenceVaultModalSubmitInteraction(
  interaction: DiscordInteraction,
  service: EvidenceVaultService,
): Promise<Response> {
  const customId = getInteractionCustomId(interaction);
  if (customId && isEvidenceVaultFieldSearchCustomId(customId)) {
    const result = await service.searchEvidenceFields({
      interaction,
      values: parseInteractionModalFieldValues(interaction),
    });
    return result.message
      ? Response.json({
          type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
          data: { ...result.message, flags: DISCORD_EPHEMERAL_FLAG },
        })
      : Response.json(buildEphemeralMessage(result.content));
  }
  const recordId = customId ? parseEvidenceVaultDetailsCustomId(customId) : null;
  if (!recordId) return Response.json(buildEphemeralMessage("Evidence is not available."));
  const result = await service.submitEvidenceDetails({
    interaction,
    recordId,
    values: parseInteractionModalFieldValues(interaction),
  });
  return Response.json(buildEphemeralMessage(result.message));
}
