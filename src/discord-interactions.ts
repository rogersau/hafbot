export const ADMINISTRATOR_PERMISSION = 1n << 3n;
export const MANAGE_GUILD_PERMISSION = 1n << 5n;

import { DISCORD_CHANNEL_MESSAGE_RESPONSE, DISCORD_EPHEMERAL_FLAG } from "./discord/constants";

export function hasGuildAdminPermission(permissions: string): boolean {
  try {
    const perms = BigInt(permissions);
    return (perms & (ADMINISTRATOR_PERMISSION | MANAGE_GUILD_PERMISSION)) !== 0n;
  } catch {
    return false;
  }
}

import { ALL_SLASH_COMMAND_DEFINITIONS } from "./discord-commands";
import { resolveResolvedDisplayName } from "./runtime/discord-user";
import type { EvidenceVaultSourceMessage } from "./evidence-vault";

export type CommandInvocation =
  | { commandName: "help" }
  | {
      commandName: "hide-evidence";
      targetId: string;
      sourceMessage: EvidenceVaultSourceMessage;
    }
  | { commandName: "blocklist"; subcommandName: "list" }
  | { commandName: "blocklist"; subcommandName: "add" | "remove"; emoji: string }
  | { commandName: "timedrole"; subcommandName: "list" }
  | {
      commandName: "timedrole";
      subcommandName: "add";
      userId: string;
      roleId: string;
      duration: string;
      targetDisplayName?: string | null;
    }
  | {
      commandName: "timedrole";
      subcommandName: "remove";
      userId: string;
      roleId: string;
      targetDisplayName?: string | null;
    }
  | {
      commandName: "ticket";
      subcommandName: "close" | "request-close" | "claim";
    }
  | { commandName: "ticket"; subcommandName: "history"; userId: string | null }
  | { commandName: "ticket"; subcommandName: "reply"; templateId: string }
  | { commandName: "ticket"; subcommandName: "add-user" | "remove-user"; userId: string }
  | { commandName: "clan"; subcommandName: "manage" }
  | {
      commandName: "clan";
      subcommandName: "request";
      name: string;
      tag: string;
      description: string;
      focus: string;
      recruitmentState: "applications-open" | "invite-only" | "closed";
    }
  | {
      commandName: "event";
      subcommandName:
        | "manage"
        | "list-teams"
        | "view-team"
        | "leave"
        | "leave-team"
        | "create-team"
        | "rename-team"
        | "join-team"
        | "withdraw-request"
        | "accept"
        | "decline"
        | "open-requests"
        | "close-requests"
        | "reject-request"
        | "disband"
        | "invite"
        | "remove-member"
        | "transfer-captain";
      eventId: string;
      teamId?: string;
      groupId?: string;
      name?: string;
      proposalId?: string;
      userId?: string;
    }
  | {
      commandName: "playercount";
      subcommandName: "add";
      provider: "steam-web";
      name: string;
      steamHost: string;
      steamPort: number | undefined;
      channelId: string | undefined;
      alertChannelId: string | undefined;
      refreshIntervalMinutes: number | undefined;
      failureThreshold: number | undefined;
    }
  | { commandName: "playercount"; subcommandName: "remove"; name: string }
  | { commandName: "playercount"; subcommandName: "list" | "show" }
  | {
      commandName: "steamlink";
      subcommandName: "whois";
      userId: string | null;
      steamId64: string | null;
    }
  | {
      commandName: "steamlink";
      subcommandName: "manual-link";
      userId: string;
      steamId64: string;
    }
  | { commandName: "steamlink"; subcommandName: "unlink"; userId: string | null }
  | { commandName: "steamlink"; subcommandName: "linkedcount" }
  | { commandName: "steamlink"; subcommandName: "request" }
  | {
      commandName: "xboxlink";
      subcommandName: "whois";
      userId: string | null;
      xuid: string | null;
    }
  | {
      commandName: "xboxlink";
      subcommandName: "manual-link";
      userId: string;
      xuid: string;
    }
  | { commandName: "xboxlink"; subcommandName: "unlink"; userId: string | null }
  | { commandName: "xboxlink"; subcommandName: "linkedcount" }
  | { commandName: "xboxlink"; subcommandName: "request" }
  | { commandName: "playstationlink"; subcommandName: "setup" | "panel" | "request" | "syncroles" }
  | {
      commandName: "playstationlink";
      subcommandName: "whois";
      userId: string | null;
      psnId: string | null;
    }
  | {
      commandName: "playstationlink";
      subcommandName: "manual-link";
      userId: string;
      psnId: string;
    }
  | { commandName: "playstationlink"; subcommandName: "unlink"; userId: string | null }
  | { commandName: "playstationlink"; subcommandName: "linkedcount" }
  | { commandName: "serverlevel"; subcommandName: "profile"; userId: string | null }
  | { commandName: "serverlevel"; subcommandName: "leaderboard" }
  | {
      commandName: "evidence-vault";
      subcommandName: "search";
      userInput: string | null;
      sourceText: string | null;
      fieldInputs: string[];
    }
  | {
      commandName: "evidence-vault";
      subcommandName: "amend";
      recordId: string;
      action: "add" | "remove";
      userInput: string;
    }
  | {
      commandName: "haf-admin";
      subcommandName: "identity-patterns";
      action: "list" | "add" | "disable";
      platform: string | null;
      pattern: string | null;
      captureGroup: number | null;
    }
  | { commandName: "haf-admin"; subcommandName: "list-guilds" }
  | {
      commandName: "haf-admin";
      subcommandName: "suspend-guild";
      guildId: string;
      reason: string;
    }
  | {
      commandName: "haf-admin";
      subcommandName: "leave-guild";
      guildId: string;
      reason: string;
      confirmedGuildId: string;
    }
  | { commandName: "haf-admin"; subcommandName: "restore-guild"; guildId: string }
  | { commandName: "haf-admin"; subcommandName: "list-suspensions" }
  | { commandName: "haf-admin"; subcommandName: "gateway-status" }
  | { commandName: "haf-admin"; subcommandName: "start-gateway" }
  | { commandName: "haf-admin"; subcommandName: "show-plan"; guildId: string }
  | {
      commandName: "haf-admin";
      subcommandName: "repair-verification-panel";
      guildId: string;
    }
  | {
      commandName: "haf-admin";
      subcommandName: "adjust-server-xp";
      guildId: string;
      userId: string;
      amountXp: number;
      reason: string;
    }
  | {
      commandName: "haf-admin";
      subcommandName: "erase-server-level-data" | "erase-reputation-data";
      guildId: string;
      userId: string;
      reason: string;
    };

function getStringOptionValue(options: any[], name: string): string | null {
  const value = options.find((option: any) => option.name === name)?.value;
  return typeof value === "string" ? value : null;
}

function getIntegerOptionValue(options: any[], name: string): number | null {
  const value = options.find((option: any) => option.name === name)?.value;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function extractCommandInvocation(invocation: any): CommandInvocation | null {
  const data = invocation?.data;
  if (!data || typeof data.name !== "string") return null;

  const cmdDef = ALL_SLASH_COMMAND_DEFINITIONS.find((d) => d.name === data.name);
  if (!cmdDef) return null;

  if (data.name === "help") return { commandName: "help" };

  if (data.name === "Hide Evidence" && data.type === 3) {
    const targetId = typeof data.target_id === "string" ? data.target_id : null;
    const sourceMessage = targetId && data.resolved?.messages?.[targetId];
    return targetId && sourceMessage
      ? { commandName: "hide-evidence", targetId, sourceMessage }
      : null;
  }

  const options = Array.isArray(data.options) ? data.options : [];
  const sub = options[0];
  if (!sub || sub.type !== 1) return null;

  const subDef = (cmdDef.options || []).find(
    (o: any) => o.name === sub.name && o.type === sub.type,
  );
  if (!subDef) return null;

  if (data.name === "serverlevel") {
    if (sub.name === "leaderboard") {
      return { commandName: "serverlevel", subcommandName: "leaderboard" };
    }
    if (sub.name === "profile") {
      return {
        commandName: "serverlevel",
        subcommandName: "profile",
        userId: getStringOptionValue(Array.isArray(sub.options) ? sub.options : [], "user"),
      };
    }
    return null;
  }

  if (sub.name === "list" && (data.name === "blocklist" || data.name === "timedrole")) {
    if (data.name === "blocklist") {
      return { commandName: "blocklist", subcommandName: "list" };
    }

    if (data.name === "timedrole") {
      return { commandName: "timedrole", subcommandName: "list" } as CommandInvocation;
    }
  }

  if (data.name === "ticket") {
    if (sub.name === "reply") {
      const templateId = getStringOptionValue(sub.options ?? [], "template");
      return templateId ? { commandName: "ticket", subcommandName: "reply", templateId } : null;
    }
    if (sub.name === "history") {
      return {
        commandName: "ticket",
        subcommandName: "history",
        userId: getStringOptionValue(sub.options ?? [], "user"),
      };
    }
    if (sub.name === "add-user" || sub.name === "remove-user") {
      const userId = getStringOptionValue(sub.options ?? [], "user");
      return userId ? { commandName: "ticket", subcommandName: sub.name, userId } : null;
    }
    if (sub.name === "close" || sub.name === "request-close" || sub.name === "claim") {
      return {
        commandName: "ticket",
        subcommandName: sub.name,
      };
    }

    return null;
  }

  if (data.name === "clan") {
    if (sub.name === "manage") return { commandName: "clan", subcommandName: "manage" };
    if (sub.name !== "request") return null;
    const subOptions = Array.isArray(sub.options) ? sub.options : [];
    const name = getStringOptionValue(subOptions, "name");
    const tag = getStringOptionValue(subOptions, "tag");
    const description = getStringOptionValue(subOptions, "description");
    const focus = getStringOptionValue(subOptions, "focus");
    const recruitmentState = getStringOptionValue(subOptions, "recruitment");
    return name &&
      tag &&
      description &&
      focus &&
      (recruitmentState === "applications-open" ||
        recruitmentState === "invite-only" ||
        recruitmentState === "closed")
      ? {
          commandName: "clan",
          subcommandName: "request",
          name,
          tag,
          description,
          focus,
          recruitmentState,
        }
      : null;
  }

  if (data.name === "event") {
    const subOptions = Array.isArray(sub.options) ? sub.options : [];
    const eventId = getStringOptionValue(subOptions, "event_id");
    if (!eventId) return null;
    const subcommandName = sub.name;
    const allowed = [
      "manage",
      "list-teams",
      "view-team",
      "leave",
      "leave-team",
      "create-team",
      "rename-team",
      "join-team",
      "withdraw-request",
      "accept",
      "decline",
      "open-requests",
      "close-requests",
      "reject-request",
      "disband",
      "invite",
      "remove-member",
      "transfer-captain",
    ];
    if (!allowed.includes(sub.name)) return null;
    const teamId = getStringOptionValue(subOptions, "team_id") ?? undefined;
    const groupId = getStringOptionValue(subOptions, "group_id") ?? undefined;
    const name = getStringOptionValue(subOptions, "name") ?? undefined;
    const proposalId = getStringOptionValue(subOptions, "proposal_id") ?? undefined;
    const userId = getStringOptionValue(subOptions, "user") ?? undefined;
    if (["create-team"].includes(sub.name) && (!groupId || !name)) return null;
    if (sub.name === "rename-team" && (!teamId || !name)) return null;
    if (
      ["join-team", "view-team", "open-requests", "close-requests", "disband"].includes(sub.name) &&
      !teamId
    )
      return null;
    if (
      ["withdraw-request", "accept", "decline", "reject-request"].includes(sub.name) &&
      !proposalId
    )
      return null;
    if (["invite", "remove-member", "transfer-captain"].includes(sub.name) && (!teamId || !userId))
      return null;
    return {
      commandName: "event",
      subcommandName: subcommandName as any,
      eventId,
      teamId,
      groupId,
      name,
      proposalId,
      userId,
    };
  }

  if (data.name === "playercount") {
    const subOptions = Array.isArray(sub.options) ? sub.options : [];
    if (sub.name === "list") {
      return { commandName: "playercount", subcommandName: "list" };
    }
    if (sub.name === "show") {
      return { commandName: "playercount", subcommandName: "show" };
    }
    if (sub.name === "add") {
      const name = getStringOptionValue(subOptions, "name");
      const steamHost = getStringOptionValue(subOptions, "steam_host");
      if (!name || !steamHost) return null;
      return {
        commandName: "playercount",
        subcommandName: "add",
        provider: "steam-web",
        name,
        steamHost,
        steamPort: getIntegerOptionValue(subOptions, "steam_port") ?? undefined,
        channelId: getStringOptionValue(subOptions, "channel") ?? undefined,
        alertChannelId: getStringOptionValue(subOptions, "alert_channel") ?? undefined,
        refreshIntervalMinutes:
          getIntegerOptionValue(subOptions, "refresh_interval_minutes") ?? undefined,
        failureThreshold: getIntegerOptionValue(subOptions, "failure_threshold") ?? undefined,
      };
    }

    if (sub.name === "remove") {
      const name = getStringOptionValue(subOptions, "name");
      if (!name) return null;
      return {
        commandName: "playercount",
        subcommandName: "remove",
        name,
      };
    }

    return null;
  }

  if (data.name === "steamlink") {
    const subOptions = Array.isArray(sub.options) ? sub.options : [];
    if (sub.name === "whois") {
      return {
        commandName: "steamlink",
        subcommandName: "whois",
        userId: getStringOptionValue(subOptions, "user"),
        steamId64: getStringOptionValue(subOptions, "steamid"),
      };
    }
    if (sub.name === "manual-link") {
      const userId = getStringOptionValue(subOptions, "user");
      const steamId64 = getStringOptionValue(subOptions, "steamid");
      if (!userId || !steamId64) return null;
      return {
        commandName: "steamlink",
        subcommandName: "manual-link",
        userId,
        steamId64,
      };
    }
    if (sub.name === "unlink") {
      return {
        commandName: "steamlink",
        subcommandName: "unlink",
        userId: getStringOptionValue(subOptions, "user"),
      };
    }
    if (sub.name === "linkedcount") {
      return { commandName: "steamlink", subcommandName: "linkedcount" };
    }
    if (sub.name === "request") {
      return { commandName: "steamlink", subcommandName: "request" };
    }
    return null;
  }

  if (data.name === "xboxlink") {
    const subOptions = Array.isArray(sub.options) ? sub.options : [];
    if (sub.name === "whois") {
      return {
        commandName: "xboxlink",
        subcommandName: "whois",
        userId: getStringOptionValue(subOptions, "user"),
        xuid: getStringOptionValue(subOptions, "xuid"),
      };
    }
    if (sub.name === "manual-link") {
      const userId = getStringOptionValue(subOptions, "user");
      const xuid = getStringOptionValue(subOptions, "xuid");
      if (!userId || !xuid) return null;
      return {
        commandName: "xboxlink",
        subcommandName: "manual-link",
        userId,
        xuid,
      };
    }
    if (sub.name === "unlink") {
      return {
        commandName: "xboxlink",
        subcommandName: "unlink",
        userId: getStringOptionValue(subOptions, "user"),
      };
    }
    if (sub.name === "linkedcount") {
      return { commandName: "xboxlink", subcommandName: "linkedcount" };
    }
    if (sub.name === "request") {
      return { commandName: "xboxlink", subcommandName: "request" };
    }
    return null;
  }

  if (data.name === "playstationlink") {
    const subOptions = Array.isArray(sub.options) ? sub.options : [];
    if (
      sub.name === "setup" ||
      sub.name === "panel" ||
      sub.name === "request" ||
      sub.name === "syncroles"
    ) {
      return { commandName: "playstationlink", subcommandName: sub.name } as CommandInvocation;
    }
    if (sub.name === "whois") {
      return {
        commandName: "playstationlink",
        subcommandName: "whois",
        userId: getStringOptionValue(subOptions, "user"),
        psnId: getStringOptionValue(subOptions, "psn_id"),
      };
    }
    if (sub.name === "manual-link") {
      const userId = getStringOptionValue(subOptions, "user");
      const psnId = getStringOptionValue(subOptions, "psn_id");
      if (!userId || !psnId) return null;
      return {
        commandName: "playstationlink",
        subcommandName: "manual-link",
        userId,
        psnId,
      };
    }
    if (sub.name === "unlink") {
      return {
        commandName: "playstationlink",
        subcommandName: "unlink",
        userId: getStringOptionValue(subOptions, "user"),
      };
    }
    if (sub.name === "linkedcount") {
      return { commandName: "playstationlink", subcommandName: "linkedcount" };
    }
    return null;
  }

  if (data.name === "evidence-vault") {
    const subOptions = Array.isArray(sub.options) ? sub.options : [];
    if (sub.name === "search") {
      const userInput = getStringOptionValue(subOptions, "user");
      const sourceText = getStringOptionValue(subOptions, "source_text");
      const fieldInputs = [1, 2, 3, 4, 5].map(
        (position) => getStringOptionValue(subOptions, `field_${position}`) ?? "",
      );
      return {
        commandName: "evidence-vault",
        subcommandName: "search",
        userInput,
        sourceText,
        fieldInputs,
      };
    }
    if (sub.name === "amend") {
      const recordId = getStringOptionValue(subOptions, "record_id");
      const action = getStringOptionValue(subOptions, "action");
      const userInput = getStringOptionValue(subOptions, "identifier");
      if (!recordId || !userInput || (action !== "add" && action !== "remove")) return null;
      return {
        commandName: "evidence-vault",
        subcommandName: "amend",
        recordId,
        action,
        userInput,
      };
    }
    return null;
  }

  if (data.name === "haf-admin") {
    const subOptions = Array.isArray(sub.options) ? sub.options : [];

    if (sub.name === "list-guilds") {
      return { commandName: "haf-admin", subcommandName: "list-guilds" };
    }

    if (sub.name === "list-suspensions") {
      return { commandName: "haf-admin", subcommandName: "list-suspensions" };
    }

    if (sub.name === "gateway-status" || sub.name === "start-gateway") {
      return { commandName: "haf-admin", subcommandName: sub.name };
    }

    if (sub.name === "identity-patterns") {
      const action = getStringOptionValue(subOptions, "action");
      if (action !== "list" && action !== "add" && action !== "disable") return null;
      return {
        commandName: "haf-admin",
        subcommandName: "identity-patterns",
        action,
        platform: getStringOptionValue(subOptions, "platform"),
        pattern: getStringOptionValue(subOptions, "pattern"),
        captureGroup: getIntegerOptionValue(subOptions, "capture_group"),
      };
    }

    const guildId = getStringOptionValue(subOptions, "guild_id");
    if (!guildId) return null;

    if (sub.name === "show-plan") {
      return { commandName: "haf-admin", subcommandName: "show-plan", guildId };
    }

    if (sub.name === "repair-verification-panel") {
      return {
        commandName: "haf-admin",
        subcommandName: "repair-verification-panel",
        guildId,
      };
    }

    if (sub.name === "adjust-server-xp") {
      const userId = getStringOptionValue(subOptions, "user_id");
      const amountXp = getIntegerOptionValue(subOptions, "amount_xp");
      const reason = getStringOptionValue(subOptions, "reason")?.trim();
      return userId && amountXp !== null && amountXp !== 0 && reason
        ? {
            commandName: "haf-admin",
            subcommandName: "adjust-server-xp",
            guildId,
            userId,
            amountXp,
            reason,
          }
        : null;
    }

    if (sub.name === "erase-server-level-data" || sub.name === "erase-reputation-data") {
      const userId = getStringOptionValue(subOptions, "user_id");
      const reason = getStringOptionValue(subOptions, "reason")?.trim();
      return userId && reason
        ? {
            commandName: "haf-admin",
            subcommandName: sub.name,
            guildId,
            userId,
            reason,
          }
        : null;
    }

    if (sub.name === "suspend-guild") {
      const reason = getStringOptionValue(subOptions, "reason")?.trim();
      if (!reason) return null;
      return { commandName: "haf-admin", subcommandName: "suspend-guild", guildId, reason };
    }

    if (sub.name === "leave-guild") {
      const reason = getStringOptionValue(subOptions, "reason")?.trim();
      const confirmedGuildId = getStringOptionValue(subOptions, "confirm_guild_id")?.trim();
      if (!reason || !confirmedGuildId) return null;
      return {
        commandName: "haf-admin",
        subcommandName: "leave-guild",
        guildId,
        reason,
        confirmedGuildId,
      };
    }

    if (sub.name === "restore-guild") {
      return { commandName: "haf-admin", subcommandName: "restore-guild", guildId };
    }

    return null;
  }

  const subOptions = Array.isArray(sub.options) ? sub.options : [];

  if (data.name === "blocklist") {
    const emojiDef = (subDef.options || []).find((o: any) => o.name === "emoji" && o.type === 3);
    if (!emojiDef) return null;

    const emoji = getStringOptionValue(subOptions, "emoji");
    if (!emoji || (sub.name !== "add" && sub.name !== "remove")) return null;

    return { commandName: "blocklist", subcommandName: sub.name, emoji };
  }

  if (data.name !== "timedrole") return null;

  const userDef = (subDef.options || []).find((o: any) => o.name === "user" && o.type === 6);
  const roleDef = (subDef.options || []).find((o: any) => o.name === "role" && o.type === 8);
  if (!userDef || !roleDef) return null;

  const userId = getStringOptionValue(subOptions, "user");
  const roleId = getStringOptionValue(subOptions, "role");
  if (!userId || !roleId) return null;

  if (sub.name === "remove") {
    const targetDisplayName = resolveResolvedDisplayName(data?.resolved, userId);
    return {
      commandName: "timedrole",
      subcommandName: "remove",
      userId,
      roleId,
      ...(targetDisplayName ? { targetDisplayName } : {}),
    } as CommandInvocation;
  }

  const durationDef = (subDef.options || []).find(
    (o: any) => o.name === "duration" && o.type === 3,
  );
  if (!durationDef) return null;

  const duration = getStringOptionValue(subOptions, "duration");
  if (!duration) return null;

  const targetDisplayName = resolveResolvedDisplayName(data?.resolved, userId);
  return {
    commandName: "timedrole",
    subcommandName: "add",
    userId,
    roleId,
    duration,
    ...(targetDisplayName ? { targetDisplayName } : {}),
  } as CommandInvocation;
}

export function buildEphemeralMessage(content: string) {
  return {
    type: DISCORD_CHANNEL_MESSAGE_RESPONSE,
    data: { content, flags: DISCORD_EPHEMERAL_FLAG },
  };
}
