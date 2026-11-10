import { commonResponses } from "../admin-docs/fixtures.mjs";
import { scenarios as documentationScenarios } from "../admin-docs/scenarios.mjs";

const root = "/admin/api";
const paths = {
  blocklist: `${root}/blocklist`,
  limits: `${root}/reaction-limits`,
  profile: `${root}/profile/preferences`,
  lfg: `${root}/lfg`,
  analytics: `${root}/product-analytics/events`,
};

// These are intentionally explicit contracts, not a generic successful POST stub.
const mutations = new Map([
  [
    `POST ${root}/reaction-roles`,
    (state, body) => {
      requireGuild(body);
      requireValue(
        Boolean(body.settings?.channelId && body.settings?.options?.length),
        "Expected reaction-role settings",
      );
      const current = state[`${root}/reaction-roles`]?.panel;
      const panel = {
        ...body.settings,
        guildId: body.guildId,
        id: current?.id ?? "fictional-panel",
        botUserId: "900",
        messageId: current?.messageId ?? null,
        publishedOptions: current?.publishedOptions ?? [],
        activatedAtMs: current?.activatedAtMs ?? null,
        enabled: false,
        updatedAtMs: 1,
      };
      state[`${root}/reaction-roles`] = { panel };
      return { panel };
    },
  ],
  [
    `POST ${root}/reaction-roles/publish`,
    (state, body) => {
      requireGuild(body);
      const panel = state[`${root}/reaction-roles`]?.panel;
      requireValue(Boolean(panel), "Save a panel before publishing");
      panel.messageId = "500";
      panel.enabled = true;
      panel.publishedOptions = panel.options;
      panel.activatedAtMs = 1;
      return { panel };
    },
  ],
  [
    `POST ${root}/reaction-roles/enabled`,
    (state, body) => {
      requireGuild(body);
      const panel = state[`${root}/reaction-roles`]?.panel;
      requireValue(Boolean(panel), "Expected an existing panel");
      panel.enabled = body.enabled;
      return { panel };
    },
  ],
  [
    `POST ${root}/guild-rbac/admin-role`,
    (state, body) => {
      requireGuild(body);
      requireValue(typeof body.manageServerAdminEnabled === "boolean", "Expected manager policy");
      const current = state[`${root}/guild-rbac/admin-role`];
      requireValue(current.canManageServerPolicy, "Owner capability required by fixture");
      current.manageServerAdminEnabled = body.manageServerAdminEnabled;
      return {
        guildId: body.guildId,
        adminRoleId: current.adminRoleId,
        manageServerAdminEnabled: current.manageServerAdminEnabled,
      };
    },
  ],
  [`POST ${paths.blocklist}`, updateBlocklist],
  [`POST ${root}/blocklist-channel`, updateBlocklistChannel],
  [`POST ${root}/blocklist-channel-filter`, updateBlocklistFilter],
  [`POST ${paths.limits}/config`, updateReactionLimits],
  [`POST ${paths.limits}/counter/clear`, clearReactionCounters],
  [`PATCH ${paths.profile}`, updatePreferences],
  [`POST ${paths.lfg}/config`, updateLfg],
  [`POST ${paths.analytics}`, acceptAnalytics],
]);

/**
 * Fictional, single-Guild API model for compiled-SPA QA, not a backend emulator.
 * `responses` replaces individual GET fixtures. Workspace role does not imply
 * Guild Admin or billing authority. Use explicit failures for denied requests.
 * `failures` entries: { method, path, status, json?, times? }.
 * `faults.dropWrites` is a negative control: acknowledge selected mutations but
 * discard their state changes, so readback assertions must detect the lost save.
 */
export function createApi({
  tier = "premium",
  role = "owner",
  responses = {},
  failures = [],
  faults = {},
} = {}) {
  if (!["free", "premium"].includes(tier)) throw new Error(`Unsupported QA tier: ${tier}`);
  if (!["owner", "member"].includes(role)) throw new Error(`Unsupported QA role: ${role}`);

  const seed = cloneFixtures({
    ...commonResponses,
    [`${root}/guild-overview`]: documentationScenarios[0].responses[`${root}/guild-overview`],
    [`${root}/operations/incidents/capabilities`]: { canWrite: true },
    [`${root}/product-analytics/preference`]: { guildId: "docs-guild", enabled: false },
    ...responses,
  });
  // The docs capture has this acknowledgement in its path-only response map.
  // Analytics is POST-only and must never become a permissive GET fixture.
  delete seed[paths.analytics];
  const droppedPaths = new Set(faults.dropWrites ?? []);
  for (const path of droppedPaths) {
    if (![...mutations.keys()].some((key) => key.endsWith(` ${path}`))) {
      throw new Error(`Unknown dropped-write route: ${path}`);
    }
  }
  const configuredFailures = failures.map((failure) => {
    const entry = { times: 1, ...structuredClone(failure) };
    entry.method = entry.method.toUpperCase();
    if (!Number.isInteger(entry.times) || entry.times < 1) {
      throw new Error("A controlled failure must have a positive integer times count");
    }
    if (!Number.isInteger(entry.status) || entry.status < 400 || entry.status > 599) {
      throw new Error("A controlled failure must have a 400–599 status");
    }
    return entry;
  });
  const requests = [];
  const unhandled = [];
  let state;
  let pendingFailures;

  function reset() {
    state = cloneFixtures(seed);
    const entitlement = state[`${root}/entitlement`];
    entitlement.tier = tier;
    entitlement.limits = {
      ...entitlement.limits,
      clansMax: tier === "free" ? 5 : 25,
      clanMembersMax: tier === "free" ? 25 : null,
      clanOfficersMax: 5,
      r2MaxBytes: 1024 * 1024 * 1024,
      ...(tier === "free" ? freeLimits : {}),
    };
    entitlement.r2Usage.maxBytes = entitlement.limits.r2MaxBytes;
    state[`${root}/guild-overview`].tier = tier;
    state[`${root}/workspaces`].workspaces = state[`${root}/workspaces`].workspaces.map(
      (workspace) => ({ ...workspace, role: role === "member" ? "viewer" : "owner" }),
    );
    for (const path of [paths.blocklist, paths.limits, paths.lfg]) {
      state[path].guildId ??= "docs-guild";
    }
    state[paths.blocklist].enabled ??= true;
    requests.length = 0;
    unhandled.length = 0;
    pendingFailures = configuredFailures.map((entry) => ({ ...entry, remaining: entry.times }));
  }

  function snapshot(path) {
    if (path !== undefined) {
      const url = new URL(path, "http://qa.invalid");
      const value = state[url.pathname];
      return structuredClone(typeof value === "function" ? value(url) : value);
    }
    return Object.fromEntries(Object.keys(state).map((key) => [key, snapshot(key)]));
  }

  async function handle({ method = "GET", url, body } = {}) {
    const parsedUrl = new URL(url, "http://qa.invalid");
    const path = parsedUrl.pathname;
    method = method.toUpperCase();
    const entry = { method, path, url: parsedUrl.href, body: structuredClone(body) };
    requests.push(entry);
    const finish = (status, json, kind, expectedFailure = false) => {
      Object.assign(entry, { status, kind, expectedFailure });
      return { status, json: structuredClone(json) };
    };
    const mutation = mutations.get(`${method} ${path}`);
    const isRead = method === "GET" && Object.hasOwn(state, path);
    if (!mutation && !isRead) {
      const knownPath =
        Object.hasOwn(state, path) || [...mutations.keys()].some((key) => key.endsWith(` ${path}`));
      const status = knownPath ? 405 : 501;
      const result = finish(
        status,
        { error: `Unhandled QA API request: ${method} ${path}` },
        "unhandled",
      );
      unhandled.push(entry);
      return result;
    }
    const failure = pendingFailures.find(
      (candidate) =>
        candidate.remaining > 0 && candidate.method === method && candidate.path === path,
    );
    if (failure) {
      failure.remaining -= 1;
      return finish(
        failure.status,
        failure.json ?? { error: `Controlled QA failure: ${method} ${path}` },
        "controlled-failure",
        true,
      );
    }
    if (isRead) return finish(200, snapshot(parsedUrl.href), "snapshot");

    try {
      const input = typeof body === "string" ? JSON.parse(body) : body;
      requireValue(
        // eslint-disable-next-line custom/no-is-record -- Standalone Node fixture tests do not load TypeScript product modules.
        input && typeof input === "object" && !Array.isArray(input),
        "Expected JSON object",
      );
      const next = cloneFixtures(state);
      const result = mutation(next, input);
      if (!droppedPaths.has(path)) state = next;
      entry.droppedWrite = droppedPaths.has(path);
      return finish(path === paths.analytics ? 202 : 200, result, "mutation");
    } catch (error) {
      if (!(error instanceof FixtureInputError) && !(error instanceof SyntaxError)) throw error;
      return finish(400, { error: error.message }, "invalid-request");
    }
  }

  function assertNoUnhandled() {
    if (unhandled.length) {
      throw new Error(
        unhandled
          .map(({ method, path }) => `Unhandled QA API request: ${method} ${path}`)
          .join("\n"),
      );
    }
  }

  function assertExpectedFailuresConsumed() {
    const unused = pendingFailures.filter(({ remaining }) => remaining > 0);
    if (unused.length) {
      throw new Error(
        unused
          .map(
            ({ method, path, remaining }) =>
              `Unused controlled failure: ${method} ${path} (${remaining})`,
          )
          .join("\n"),
      );
    }
  }

  reset();
  return {
    handle,
    reset,
    snapshot,
    requests,
    unhandled,
    assertNoUnhandled,
    assertExpectedFailuresConsumed,
  };
}

// Keep this small fixture matrix aligned with getGuildEntitlementLimits in src/types.ts.
const freeLimits = {
  blocklistMaxEmojis: 10,
  reactionLimitsEnabled: true,
  ticketsMaxPanels: 1,
  ticketsMaxTypesPerPanel: 1,
  platformLinkMaxLinks: 100,
  managedMessagesMax: 3,
  messageTemplatesMax: 3,
  evidenceVaultMaxRecords: 30,
  r2MaxBytes: 100 * 1024 * 1024,
  paidFeatures: false,
};

function cloneFixtures(fixtures) {
  return Object.fromEntries(
    Object.entries(fixtures).map(([key, value]) => [
      key,
      typeof value === "function" ? value : structuredClone(value),
    ]),
  );
}

class FixtureInputError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new FixtureInputError(message);
}

function requireGuild(body) {
  requireValue(body.guildId === "docs-guild", "Expected fictional guildId docs-guild");
}

function requireStrings(value, field) {
  requireValue(
    Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()),
    `Invalid ${field}`,
  );
}

function requireNullableString(value, field) {
  requireValue(value === null || typeof value === "string", `Invalid ${field}`);
}

function channelFilter(body) {
  const channelMode = body.channelMode ?? "include";
  const channelIds = body.channelIds ?? [];
  requireValue(["include", "exclude"].includes(channelMode), "Invalid channelMode");
  requireStrings(channelIds, "channelIds");
  return { channelMode, channelIds: [...channelIds] };
}

function updateBlocklist(state, body) {
  requireGuild(body);
  requireValue(
    Object.keys(body).every((key) =>
      ["guildId", "workspaceId", "action", "emoji", "emojis"].includes(key),
    ),
    "Unknown blocklist mutation field",
  );
  requireValue(["add", "remove"].includes(body.action), "Invalid blocklist action");
  requireValue(
    (body.emojis !== undefined) !== (body.emoji !== undefined),
    "Provide either emoji or emojis, not both",
  );
  const batch = body.emojis !== undefined;
  requireValue(!batch || body.action === "add", "Batch emoji mutations only support add");
  const values = batch ? body.emojis : [body.emoji];
  requireStrings(values, "emojis");
  requireValue(values.length > 0 && values.length <= 50, "A batch must contain 1–50 emojis");
  requireValue(
    values.every((value) => value.length <= 100),
    "Emoji is too long",
  );
  const emojis = normalizeEmojis(values);
  requireValue(emojis.length > 0 && emojis.length <= 50, "A batch must contain 1–50 emojis");
  const blocklist = state[paths.blocklist];
  const alreadyBlocked = emojis.filter((emoji) => blocklist.emojis.includes(emoji));
  const added = emojis.filter((emoji) => !blocklist.emojis.includes(emoji));
  if (body.action === "add") {
    const maximum = state[`${root}/entitlement`].limits.blocklistMaxEmojis;
    requireValue(
      added.length === 0 || maximum === null || blocklist.emojis.length + added.length <= maximum,
      "Blocklist plan quantity limit exceeded",
    );
    blocklist.emojis.push(...added);
    blocklist.enabled = true;
  } else {
    blocklist.emojis = blocklist.emojis.filter((emoji) => !emojis.includes(emoji));
  }
  return batch ? { ok: true, added, alreadyBlocked, blocklist } : { ok: true };
}

function normalizeEmojis(values) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const candidates = values
    .flatMap((value) => value.trim().split(/\s+/))
    .flatMap((value) => {
      const custom = value.match(/<a?:[^:>]+:\d+>/g);
      if (custom?.join("") === value) return custom;
      const graphemes = Array.from(segmenter.segment(value), ({ segment }) => segment);
      return graphemes.every((part) =>
        /\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji}\uFE0F/u.test(
          part,
        ),
      )
        ? graphemes
        : [value];
    });
  return [
    ...new Set(
      candidates
        .map((value) => {
          const custom = /^(?:<a?:|:a?:)([^:>]+):(\d+)>?$/.exec(value);
          return custom ? `${custom[1]}:${custom[2]}` : value.replace(/^:/, "").replace(/:$/, "");
        })
        .filter(Boolean),
    ),
  ];
}

function updateBlocklistChannel(state, body) {
  requireGuild(body);
  requireNullableString(body.notificationChannelId, "notificationChannelId");
  state[paths.blocklist].notificationChannelId = body.notificationChannelId;
  return { guildId: body.guildId, notificationChannelId: body.notificationChannelId };
}

function updateBlocklistFilter(state, body) {
  requireGuild(body);
  Object.assign(state[paths.blocklist], channelFilter(body));
  return { ok: true };
}

function updateReactionLimits(state, body) {
  requireGuild(body);
  requireValue(typeof body.limitsEnabled === "boolean", "Missing limitsEnabled");
  const config = {
    ...state[paths.limits].config,
    guildId: body.guildId,
    limitsEnabled: body.limitsEnabled,
  };
  for (const field of [
    "maxReactionsPerMessage",
    "maxReactionsPerUserPerMessage",
    "breachThreshold",
    "breachRoleDurationMs",
  ]) {
    const value = body[field] ?? null;
    requireValue(value === null || (Number.isInteger(value) && value > 0), `Invalid ${field}`);
    config[field] = value;
  }
  for (const field of ["breachRoleId", "breachDmText"]) {
    const value = body[field] ?? null;
    requireNullableString(value, field);
    config[field] = value;
  }
  Object.assign(config, channelFilter(body));
  state[paths.limits].config = config;
  return { ok: true };
}

function clearReactionCounters(state, body) {
  requireGuild(body);
  requireNullableString(body.userId ?? null, "userId");
  state[paths.limits].counters = body.userId
    ? state[paths.limits].counters.filter((counter) => counter.userId !== body.userId)
    : [];
  return { ok: true };
}

function updatePreferences(state, body) {
  const current = state[paths.profile];
  for (const [field, value] of Object.entries(body)) {
    requireValue(Object.hasOwn(current, field), `Unknown profile preference: ${field}`);
    if (field === "hiddenGuildIds") {
      requireStrings(value, field);
      requireValue(value.length <= 500, "Too many hidden Guilds");
      current[field] = [...new Set(value)];
    } else if (field === "defaultGuildId") {
      requireNullableString(value, field);
      requireValue(value === null || value.length > 0, "Invalid defaultGuildId");
      current[field] = value;
    } else if (field === "theme" || field === "language") {
      const allowed = field === "theme" ? ["system", "light", "dark"] : ["en", "es", "de", "fr"];
      requireValue(allowed.includes(value), `Invalid ${field}`);
      current[field] = value;
    } else {
      requireValue(typeof value === "boolean", `Invalid ${field}`);
      current[field] = value;
    }
  }
  return current;
}

function updateLfg(state, body) {
  requireGuild(body);
  const config = { ...state[paths.lfg].config };
  for (const field of [
    "noticeChannelId",
    "noticeMessageId",
    "notificationRoleId",
    "noticeColor",
    "counterVoiceChannelId",
    "counterDisplayFormat",
    "approvalFlowEnabled",
    "approvalAuditChannelId",
    "approvalVoiceCategoryId",
    "expiryAction",
    "expiryDurationHours",
    "serverOptions",
  ]) {
    if (Object.hasOwn(body, field)) config[field] = structuredClone(body[field]);
  }
  for (const field of [
    "noticeChannelId",
    "noticeMessageId",
    "notificationRoleId",
    "counterVoiceChannelId",
    "approvalAuditChannelId",
    "approvalVoiceCategoryId",
  ]) {
    const value = body[field] ?? null;
    requireNullableString(value, field);
    config[field] = value?.trim() || null;
  }
  if (config.noticeColor !== undefined) {
    requireValue(
      Number.isInteger(config.noticeColor) &&
        config.noticeColor >= 0 &&
        config.noticeColor <= 0xffffff,
      "Invalid noticeColor",
    );
  }
  state[paths.lfg].config = config;
  return { ok: true };
}

function acceptAnalytics(_state, body) {
  requireGuild(body);
  requireValue(["page_viewed", "milestone"].includes(body.event), "Invalid analytics event");
  return { accepted: true };
}
