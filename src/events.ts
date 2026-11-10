import type { EventRecord, EventSignup } from "./types";
import {
  DISCORD_ACTION_ROW_BUTTON_LIMIT,
  DISCORD_BUTTON_COMPONENT,
  DISCORD_MESSAGE_COMPONENT_ROW,
} from "./discord/constants";
import type { CreateChannelMessageInput } from "./discord/messages";
import { suppressMentions } from "./discord/messages";

const DISCORD_SELECT_COMPONENT = 3;

export type EventCustomId =
  | { action: "signup"; eventId: string; groupId: string }
  | { action: "select"; eventId: string }
  | { action: "leave"; eventId: string }
  | { action: "manage"; eventId: string }
  | { action: "team-create"; eventId: string; groupId: string }
  | { action: "team-list"; eventId: string }
  | { action: "team-join"; eventId: string; teamId: string }
  | { action: "team-withdraw"; eventId: string; proposalId: string }
  | { action: "team-accept"; eventId: string; proposalId: string }
  | { action: "team-decline"; eventId: string; proposalId: string }
  | { action: "team-leave"; eventId: string }
  | { action: "team-open" | "team-close"; eventId: string; teamId: string }
  | { action: "team-invite"; eventId: string; teamId: string; userId: string }
  | { action: "team-reject"; eventId: string; proposalId: string }
  | { action: "team-remove"; eventId: string; teamId: string; userId: string }
  | { action: "team-transfer"; eventId: string; teamId: string; userId: string }
  | { action: "team-disband"; eventId: string; teamId: string };

export function parseEventCustomId(customId: string): EventCustomId | null {
  const parts = customId.split(":");
  if (parts[0] !== "event") return null;
  if (parts[1] === "signup" && parts[2] && parts[3]) {
    return { action: "signup", eventId: parts[2], groupId: parts.slice(3).join(":") };
  }
  if (parts[1] === "select" && parts[2]) {
    return { action: "select", eventId: parts.slice(2).join(":") };
  }
  if (parts[1] === "leave" && parts[2]) {
    return { action: "leave", eventId: parts.slice(2).join(":") };
  }
  if (parts[1] === "manage" && parts[2])
    return { action: "manage", eventId: parts.slice(2).join(":") };
  if (parts[1] === "team-create" && parts[2] && parts[3])
    return { action: "team-create", eventId: parts[2], groupId: parts.slice(3).join(":") };
  if (parts[1] === "team-list" && parts[2])
    return { action: "team-list", eventId: parts.slice(2).join(":") };
  if (
    (parts[1] === "team-join" ||
      parts[1] === "team-withdraw" ||
      parts[1] === "team-accept" ||
      parts[1] === "team-decline" ||
      parts[1] === "team-reject" ||
      parts[1] === "team-disband") &&
    parts[2] &&
    parts[3]
  ) {
    const action = parts[1] as
      | "team-join"
      | "team-withdraw"
      | "team-accept"
      | "team-decline"
      | "team-reject"
      | "team-disband";
    if (action === "team-join" || action === "team-disband")
      return { action, eventId: parts[2], teamId: parts.slice(3).join(":") };
    return { action, eventId: parts[2], proposalId: parts.slice(3).join(":") };
  }
  if (parts[1] === "team-leave" && parts[2])
    return { action: "team-leave", eventId: parts.slice(2).join(":") };
  if ((parts[1] === "team-open" || parts[1] === "team-close") && parts[2] && parts[3])
    return { action: parts[1], eventId: parts[2], teamId: parts.slice(3).join(":") };
  if (
    (parts[1] === "team-invite" || parts[1] === "team-remove" || parts[1] === "team-transfer") &&
    parts[2] &&
    parts[3] &&
    parts[4]
  ) {
    return {
      action: parts[1],
      eventId: parts[2],
      teamId: parts[3],
      userId: parts.slice(4).join(":"),
    };
  }
  return null;
}

export interface EventTeamMessageAggregate {
  teamCount: number;
  readyTeamCount: number;
  incompleteTeamCount: number;
  unassignedCount: number;
  assignedCount: number;
  capacity: number;
}

export function buildEventMessage(
  event: EventRecord,
  signups: EventSignup[],
  teamAggregate?: EventTeamMessageAggregate,
): CreateChannelMessageInput {
  const controlsClosed =
    event.status === "ended" || event.status === "cancelled" || event.status === "archived";
  const fields = event.groups.map((group) => {
    const confirmed = signups.filter(
      (signup) => signup.groupId === group.id && signup.status === "confirmed",
    ).length;
    const waitlisted = signups.filter(
      (signup) => signup.groupId === group.id && signup.status === "waitlisted",
    ).length;
    const capacity = group.capacity === null ? "open" : `${confirmed}/${group.capacity}`;
    return {
      name: `${group.emoji ? `${group.emoji} ` : ""}${group.label}`,
      value:
        waitlisted > 0
          ? `${capacity} confirmed\n${waitlisted} waitlisted`
          : `${capacity} confirmed`,
      inline: true,
    };
  });

  const teamFields =
    event.participationMode === "team" && teamAggregate
      ? [
          {
            name: "Event Teams",
            value: `${teamAggregate.readyTeamCount} ready · ${teamAggregate.incompleteTeamCount} incomplete\n${teamAggregate.assignedCount} assigned · ${teamAggregate.unassignedCount} unassigned\nCapacity: ${teamAggregate.capacity}`,
            inline: false,
          },
        ]
      : [];
  return {
    allowed_mentions: suppressMentions(),
    embeds: [
      {
        title: event.title,
        description: [
          event.description,
          "",
          `Starts: <t:${Math.floor(event.startsAtMs / 1000)}:F>`,
          `Signup cutoff: <t:${Math.floor(event.signupCutoffAtMs / 1000)}:R>`,
          `Status: ${formatEventStatus(event.status)}`,
        ]
          .filter(Boolean)
          .join("\n"),
        color:
          event.status === "cancelled" ? 0xed4245 : event.status === "ended" ? 0x747f8d : 0x5865f2,
        fields: [...fields, ...teamFields],
        footer: { text: "hafbot.xyz" },
      },
    ],
    components: buildEventComponents(event, controlsClosed),
  };
}

function buildEventComponents(event: EventRecord, disabled: boolean): unknown[] {
  const groupControls =
    event.groups.length <= DISCORD_ACTION_ROW_BUTTON_LIMIT
      ? [
          {
            type: DISCORD_MESSAGE_COMPONENT_ROW,
            components: event.groups.map((group) => ({
              type: DISCORD_BUTTON_COMPONENT,
              custom_id: `event:signup:${event.id}:${group.id}`,
              label: group.label || "Unnamed group",
              emoji: group.emoji ? { name: group.emoji } : undefined,
              style: 2,
              disabled,
            })),
          },
        ]
      : [
          {
            type: DISCORD_MESSAGE_COMPONENT_ROW,
            components: [
              {
                type: DISCORD_SELECT_COMPONENT,
                custom_id: `event:select:${event.id}`,
                placeholder: "Choose a signup group",
                disabled,
                options: event.groups.slice(0, 25).map((group) => ({
                  label: group.label || "Unnamed group",
                  value: group.id,
                  emoji: group.emoji ? { name: group.emoji } : undefined,
                })),
              },
            ],
          },
        ];

  return [
    ...groupControls,
    {
      type: DISCORD_MESSAGE_COMPONENT_ROW,
      components: [
        {
          type: DISCORD_BUTTON_COMPONENT,
          custom_id: `event:leave:${event.id}`,
          label: "Leave event",
          style: 4,
          disabled,
        },
      ],
    },
    ...(event.participationMode === "team"
      ? [
          {
            type: DISCORD_MESSAGE_COMPONENT_ROW,
            components: [
              {
                type: DISCORD_BUTTON_COMPONENT,
                custom_id: `event:manage:${event.id}`,
                label: "Manage Event",
                style: 1,
                disabled,
              },
              {
                type: DISCORD_BUTTON_COMPONENT,
                custom_id: `event:team-list:${event.id}`,
                label: "List Teams",
                style: 2,
                disabled,
              },
              {
                type: DISCORD_BUTTON_COMPONENT,
                custom_id: `event:team-leave:${event.id}`,
                label: "Leave Team",
                style: 4,
                disabled,
              },
            ],
          },
          ...event.groups.slice(0, 2).map((group) => ({
            type: DISCORD_MESSAGE_COMPONENT_ROW,
            components: [
              {
                type: DISCORD_BUTTON_COMPONENT,
                custom_id: `event:team-create:${event.id}:${group.id}`,
                label: `Create Team · ${group.label || "Group"}`.slice(0, 80),
                style: 1,
                disabled,
              },
            ],
          })),
        ]
      : []),
  ];
}

function formatEventStatus(status: EventRecord["status"]): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "scheduled":
      return "Scheduled";
    case "live":
      return "Live";
    case "ended":
      return "Ended";
    case "cancelled":
      return "Cancelled";
    case "archived":
      return "Archived";
  }
}
