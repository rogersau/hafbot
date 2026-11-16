import type { EventRecord, EventSignup, EventTeam, EventTeamMembership } from "../types";
import { isRecord } from "../unknown-parse";

export type EventTeamBulkStrategy = "signup_order" | "shuffle";

export interface EventTeamBulkPreviewInput {
  guildId: string;
  eventId: string;
  /** Deliberately required: bulk formation never operates across Signup Groups. */
  groupId: string;
  strategy?: EventTeamBulkStrategy;
  seed?: string | number;
  fillPartialTeams?: boolean;
  includeIncomplete?: boolean;
  namePrefix?: string;
}

export interface EventTeamBulkFormationProposal {
  /** Existing active Team being filled; null means a new Team is proposed. */
  existingTeamId: string | null;
  groupId: string;
  name: string;
  captainUserId: string;
  /** Complete roster after this proposal is applied. */
  memberUserIds: string[];
  /** Only the newly allocated members; existing Teams are never rewritten. */
  addUserIds: string[];
  incomplete: boolean;
}

export interface EventTeamBulkPreview {
  version: 1;
  guildId: string;
  eventId: string;
  groupId: string;
  strategy: EventTeamBulkStrategy;
  seed: string;
  fillPartialTeams: boolean;
  includeIncomplete: boolean;
  namePrefix: string;
  /** Stable current-state revision used to reject stale commits. */
  revision: string;
  proposals: EventTeamBulkFormationProposal[];
  unassignedUserIds: string[];
  consideredSignupUserIds: string[];
}

export interface EventTeamBulkCommitInput {
  preview: EventTeamBulkPreview;
  expectedRevision: string;
  actorUserId: string;
}

/** The existing EventStore can implement these methods without adopting this service's policy code. */
export interface EventTeamBulkStore {
  readEvent(guildId: string, eventId: string): Promise<EventRecord | null>;
  listSignups(guildId: string, eventId: string): Promise<EventSignup[]>;
  listEventTeams(guildId: string, eventId: string): Promise<EventTeam[]>;
  listActiveEventTeamMemberships(guildId: string, eventId: string): Promise<EventTeamMembership[]>;
  /** Must atomically create new Teams/add memberships and update any metadata. */
  commitEventTeamBulkFormation(input: EventTeamBulkCommitInput): Promise<unknown>;
}

export class EventTeamBulkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EventTeamBulkError";
  }
}

export class EventTeamBulkStalePreviewError extends EventTeamBulkError {
  constructor(message = "The Event Team bulk preview is stale; refresh it before committing.") {
    super("stale_preview", message);
    this.name = "EventTeamBulkStalePreviewError";
  }
}

interface BulkState {
  event: EventRecord;
  signups: EventSignup[];
  teams: EventTeam[];
  memberships: EventTeamMembership[];
}

export interface EventTeamBulkServiceOptions {
  /** Called once to create the service's default shuffle seed, keeping previews stable. */
  random?: () => number;
}

export class EventTeamBulkService {
  private readonly defaultSeed: string;

  constructor(
    private readonly store: EventTeamBulkStore,
    options: EventTeamBulkServiceOptions = {},
  ) {
    const randomValue = options.random?.();
    this.defaultSeed = randomValue === undefined ? "event-team-bulk-v1" : String(randomValue);
  }

  async preview(input: EventTeamBulkPreviewInput): Promise<EventTeamBulkPreview> {
    const state = await this.readState(input);
    return this.buildPreview(input, state);
  }

  async commit(preview: EventTeamBulkPreview, actorUserId = "admin"): Promise<unknown> {
    const state = await this.readState(preview);
    const refreshed = this.buildPreview(
      {
        guildId: preview.guildId,
        eventId: preview.eventId,
        groupId: preview.groupId,
        strategy: preview.strategy,
        seed: preview.seed,
        fillPartialTeams: preview.fillPartialTeams,
        includeIncomplete: preview.includeIncomplete,
        namePrefix: preview.namePrefix,
      },
      state,
    );
    if (
      refreshed.revision !== preview.revision ||
      stableSerialize(allocationShape(refreshed.proposals)) !==
        stableSerialize(allocationShape(preview.proposals)) ||
      stableSerialize(refreshed.unassignedUserIds) !== stableSerialize(preview.unassignedUserIds)
    ) {
      throw new EventTeamBulkStalePreviewError();
    }
    for (let index = 0; index < preview.proposals.length; index += 1) {
      validateEditedProposal(preview.proposals[index]!, refreshed.proposals[index]!);
    }

    // This is intentionally the sole write call. The dependency owns its transaction and
    // must not expose partially-applied Teams if the operation fails.
    return this.store.commitEventTeamBulkFormation({
      preview,
      expectedRevision: preview.revision,
      actorUserId,
    });
  }

  private async readState(
    input: Pick<EventTeamBulkPreviewInput, "guildId" | "eventId">,
  ): Promise<BulkState> {
    const [event, signups, teams, memberships] = await Promise.all([
      this.store.readEvent(input.guildId, input.eventId),
      this.store.listSignups(input.guildId, input.eventId),
      this.store.listEventTeams(input.guildId, input.eventId),
      this.store.listActiveEventTeamMemberships(input.guildId, input.eventId),
    ]);
    if (!event) throw new EventTeamBulkError("event_not_found", "Event not found.");
    return { event, signups, teams, memberships };
  }

  private buildPreview(input: EventTeamBulkPreviewInput, state: BulkState): EventTeamBulkPreview {
    validateInput(input, state.event);
    const requiredTeamSize = state.event.requiredTeamSize as number;
    const strategy = input.strategy ?? "signup_order";
    const seed = input.seed === undefined ? this.defaultSeed : String(input.seed);
    const fillPartialTeams = input.fillPartialTeams ?? false;
    const includeIncomplete = input.includeIncomplete ?? false;
    const namePrefix = safeNamePrefix(input.namePrefix);
    const activeTeams = state.teams
      .filter((team) => team.groupId === input.groupId && team.status === "active")
      .sort(byCreatedThenId);
    const activeMemberships = state.memberships.filter(
      (membership) => membership.leftAtMs === null,
    );
    const membershipByTeam = new Map<string, string[]>();
    const activeMemberIds = new Set<string>();
    for (const membership of activeMemberships.sort(byJoinedThenId)) {
      activeMemberIds.add(membership.userId);
      if (membership.groupId === input.groupId) {
        const members = membershipByTeam.get(membership.teamId) ?? [];
        if (!members.includes(membership.userId)) members.push(membership.userId);
        membershipByTeam.set(membership.teamId, members);
      }
    }

    const candidates = orderedCandidates(
      state.signups
        .filter((signup) => signup.groupId === input.groupId)
        .sort(bySignupQueue)
        .filter((signup) => !activeMemberIds.has(signup.userId)),
      strategy,
      seed,
    );
    const consideredSignupUserIds = candidates.map((signup) => signup.userId);
    const remaining = [...candidates];
    const proposals: EventTeamBulkFormationProposal[] = [];

    if (fillPartialTeams) {
      for (const team of activeTeams) {
        const members = membershipByTeam.get(team.id) ?? [];
        const places = Math.max(0, requiredTeamSize - members.length);
        if (places === 0) continue;
        const additions = remaining.splice(0, places);
        if (additions.length === 0) continue;
        proposals.push({
          existingTeamId: team.id,
          groupId: input.groupId,
          name: team.name,
          captainUserId: team.captainUserId,
          memberUserIds: [...members, ...additions.map((signup) => signup.userId)],
          addUserIds: additions.map((signup) => signup.userId),
          incomplete: members.length + additions.length < requiredTeamSize,
        });
      }
    }

    const usedNames = new Set(state.teams.map((team) => normalizeName(team.name)));
    let sequence = 1;
    while (remaining.length >= requiredTeamSize || (includeIncomplete && remaining.length > 0)) {
      const chunk = remaining.splice(0, requiredTeamSize);
      if (chunk.length === 0) break;
      let name = generatedName(namePrefix, sequence);
      while (usedNames.has(normalizeName(name))) name = generatedName(namePrefix, ++sequence);
      usedNames.add(normalizeName(name));
      sequence += 1;
      const captain = [...chunk].sort(byCaptainPriority)[0] ?? chunk[0]!;
      proposals.push({
        existingTeamId: null,
        groupId: input.groupId,
        name,
        captainUserId: captain.userId,
        memberUserIds: chunk.map((signup) => signup.userId),
        addUserIds: chunk.map((signup) => signup.userId),
        incomplete: chunk.length < requiredTeamSize,
      });
    }

    const unassignedUserIds = remaining.map((signup) => signup.userId);
    const fingerprint = fingerprintState(state, input.groupId);
    return {
      version: 1,
      guildId: input.guildId,
      eventId: input.eventId,
      groupId: input.groupId,
      strategy,
      seed,
      fillPartialTeams,
      includeIncomplete,
      namePrefix,
      revision: fingerprint,
      proposals,
      unassignedUserIds,
      consideredSignupUserIds,
    };
  }
}

function validateInput(input: EventTeamBulkPreviewInput, event: EventRecord): void {
  if (event.guildId !== input.guildId || event.id !== input.eventId) {
    throw new EventTeamBulkError(
      "event_mismatch",
      "Event state does not match the requested scope.",
    );
  }
  const requiredTeamSize = event.requiredTeamSize;
  if (
    event.participationMode !== "team" ||
    !Number.isInteger(requiredTeamSize) ||
    requiredTeamSize === null ||
    requiredTeamSize < 2
  ) {
    throw new EventTeamBulkError(
      "not_team_event",
      "Bulk formation requires a Team Event with a valid roster size.",
    );
  }
  if (!input.groupId || !event.groups.some((group) => group.id === input.groupId)) {
    throw new EventTeamBulkError("signup_group_required", "Choose exactly one valid Signup Group.");
  }
  if (input.strategy && input.strategy !== "signup_order" && input.strategy !== "shuffle") {
    throw new EventTeamBulkError("invalid_strategy", "Unknown bulk formation strategy.");
  }
}

function orderedCandidates(
  signups: EventSignup[],
  strategy: EventTeamBulkStrategy,
  seed: string,
): EventSignup[] {
  const confirmed = signups.filter((signup) => signup.status === "confirmed");
  const waitlisted = signups.filter((signup) => signup.status === "waitlisted");
  if (strategy === "signup_order") return [...confirmed, ...waitlisted];
  return [
    ...deterministicShuffle(confirmed, seed + ":confirmed"),
    ...deterministicShuffle(waitlisted, seed + ":waitlisted"),
  ];
}

function deterministicShuffle<T>(items: T[], seed: string): T[] {
  const result = [...items];
  let state = hash32(seed) || 0x9e3779b9;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x1b873593) | 0;
    const swap = Math.abs(state) % (index + 1);
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function fingerprintState(state: BulkState, groupId: string): string {
  return hashHex(
    stableSerialize({
      event: {
        guildId: state.event.guildId,
        id: state.event.id,
        participationMode: state.event.participationMode,
        requiredTeamSize: state.event.requiredTeamSize,
        groups: state.event.groups,
      },
      groupId,
      signups: [...state.signups].sort(bySignupQueue),
      teams: [...state.teams].sort(byCreatedThenId),
      memberships: [...state.memberships].sort(byJoinedThenId),
    }),
  );
}

function bySignupQueue(a: EventSignup, b: EventSignup): number {
  return (
    a.createdAtMs - b.createdAtMs ||
    a.updatedAtMs - b.updatedAtMs ||
    a.userId.localeCompare(b.userId) ||
    a.groupId.localeCompare(b.groupId)
  );
}

function byCreatedThenId(a: EventTeam, b: EventTeam): number {
  return a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id);
}

function byJoinedThenId(a: EventTeamMembership, b: EventTeamMembership): number {
  return a.joinedAtMs - b.joinedAtMs || a.id.localeCompare(b.id);
}

function byCaptainPriority(a: EventSignup, b: EventSignup): number {
  return (
    (a.status === "confirmed" ? 0 : 1) - (b.status === "confirmed" ? 0 : 1) || bySignupQueue(a, b)
  );
}

function safeNamePrefix(value: string | undefined): string {
  const cleaned = (value ?? "Team")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
  return cleaned || "Team";
}

function generatedName(prefix: string, sequence: number): string {
  const suffix = ` ${sequence}`;
  return `${prefix.slice(0, Math.max(2, 40 - suffix.length))}${suffix}`;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function allocationShape(proposals: EventTeamBulkFormationProposal[]) {
  return proposals.map(({ name: _name, captainUserId: _captainUserId, ...proposal }) => proposal);
}

function validateEditedProposal(
  proposal: EventTeamBulkFormationProposal,
  refreshed: EventTeamBulkFormationProposal,
): void {
  if (proposal.existingTeamId !== null) {
    if (proposal.name !== refreshed.name || proposal.captainUserId !== refreshed.captainUserId) {
      throw new EventTeamBulkError(
        "existing_team_edit",
        "Existing Event Team names and captains are not changed by bulk formation.",
      );
    }
    return;
  }
  const name = proposal.name.trim().replace(/\s+/g, " ");
  if (
    name.length < 2 ||
    name.length > 40 ||
    /[@\r\n]/u.test(name) ||
    normalizeName(name).length === 0
  ) {
    throw new EventTeamBulkError("unsafe_team_name", "Choose a safe Event Team name.");
  }
  if (!proposal.memberUserIds.includes(proposal.captainUserId)) {
    throw new EventTeamBulkError(
      "invalid_captain",
      "The proposed captain must be a member of the Event Team.",
    );
  }
}

function stableSerialize(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function hashHex(value: string): string {
  let hash = 0xcbf29ce4;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1)
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return hash | 0;
}
