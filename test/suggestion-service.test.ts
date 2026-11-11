/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  SuggestionDomainError,
  SuggestionService,
  type SuggestionProjection,
} from "../src/services/suggestion-service";
import { defaultSuggestionsConfig, type ConsideredReply } from "../src/suggestions";
import {
  buildSuggestionCategoryPicker,
  buildSuggestionPanel,
  buildSuggestionStarter,
} from "../src/discord/suggestions";
import { createSqliteSuggestionStore } from "./support/sqlite/runtime/sqlite-suggestion-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

async function harness(projection: SuggestionProjection = {}) {
  const store = createSqliteSuggestionStore(new SqliteD1Database().d1);
  await store.upsertConfig({
    ...defaultSuggestionsConfig("guild-1", 1),
    enabled: true,
    forumChannelId: "forum-1",
    categories: ["Bot Features"],
    submissionCooldownSeconds: 0,
  });
  let now = 10 * 86_400_000;
  let sequence = 0;
  const service = new SuggestionService(
    store,
    projection,
    () => now,
    () => `id-${++sequence}`,
  );
  const submit = (authorId = "author-1", title = "Improve onboarding") =>
    service.submit({
      guildId: "guild-1",
      authorId,
      title,
      category: "Bot Features",
      answers: [
        { promptId: "change", promptLabel: "", answer: "Add a clearer onboarding flow" },
        { promptId: "benefit", promptLabel: "", answer: "New members find channels quickly" },
        { promptId: "tradeoffs", promptLabel: "", answer: "More setup for staff" },
      ],
    });
  return { store, service, submit, setNow: (value: number) => (now = value) };
}

test("SuggestionService persists structured submissions and warns on likely duplicates", async () => {
  const h = await harness();
  const first = await h.submit();
  assert.equal(first.kind, "created");
  const duplicate = await h.submit("author-2");
  assert.equal(duplicate.kind, "duplicate-warning");
  if (duplicate.kind !== "duplicate-warning") return;
  const confirmed = await h.service.confirmDuplicateSubmission(
    "guild-1",
    duplicate.pending.id,
    "author-2",
  );
  assert.equal(confirmed.status, "gathering_feedback");
  assert.equal(confirmed.answers[0]?.promptLabel, "What should change?");
});

test("SuggestionService denies cross-guild duplicate confirmation without mutation", async () => {
  const h = await harness();
  await h.submit();
  const duplicate = await h.submit("author-2");
  assert.equal(duplicate.kind, "duplicate-warning");
  if (duplicate.kind !== "duplicate-warning") return;

  await assert.rejects(
    h.service.confirmDuplicateSubmission("guild-2", duplicate.pending.id, "author-2"),
    (error: unknown) =>
      error instanceof SuggestionDomainError && error.code === "duplicate-confirmation-expired",
  );
  assert.equal((await h.store.readPendingSubmission(duplicate.pending.id))?.guildId, "guild-1");
});

test("SuggestionService binds reply moderation before config, rate limits, or mutation", async () => {
  let configReads = 0;
  let rateLimitWrites = 0;
  let updates = 0;
  const reply = {
    id: "reply-1",
    guildId: "guild-1",
    state: "collapsed",
  } as ConsideredReply;
  const service = new SuggestionService({
    readConsideredReplyById: async () => reply,
    readConfig: async () => {
      configReads += 1;
      return defaultSuggestionsConfig("guild-2");
    },
    consumeActionRateLimit: async () => {
      rateLimitWrites += 1;
      return true;
    },
    updateConsideredReply: async () => {
      updates += 1;
      return true;
    },
  } as never);

  await assert.rejects(
    service.resolveCollapsedReply({
      guildId: "guild-2",
      replyId: reply.id,
      actorUserId: "admin-2",
      actorRoleIds: [],
      isGuildAdmin: true,
      action: "restore",
    }),
    (error: unknown) => error instanceof SuggestionDomainError && error.code === "not-found",
  );
  assert.equal(configReads, 0);
  assert.equal(rateLimitWrites, 0);
  assert.equal(updates, 0);
});

test("SuggestionService enforces author and staff lifecycle authority and outcomes", async () => {
  const h = await harness();
  const result = await h.submit();
  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  const needsWork = await h.service.transition({
    guildId: "guild-1",
    suggestionId: result.suggestion.id,
    actorUserId: "author-1",
    actorRoleIds: [],
    isGuildAdmin: false,
    isAuthor: true,
    expectedRevision: 1,
    toStatus: "needs_work",
  });
  await assert.rejects(
    h.service.transition({
      guildId: "guild-1",
      suggestionId: needsWork.id,
      actorUserId: "author-1",
      actorRoleIds: [],
      isGuildAdmin: false,
      isAuthor: true,
      expectedRevision: 2,
      toStatus: "planned",
      outcome: { summary: "Ship it" },
    }),
    (error: unknown) => error instanceof SuggestionDomainError && error.code === "authority",
  );
  await assert.rejects(
    h.service.transition({
      guildId: "guild-1",
      suggestionId: needsWork.id,
      actorUserId: "admin-1",
      actorRoleIds: [],
      isGuildAdmin: true,
      isAuthor: false,
      expectedRevision: 2,
      toStatus: "planned",
    }),
    (error: unknown) =>
      error instanceof SuggestionDomainError && error.code === "invalid-transition",
  );
  const planned = await h.service.transition({
    guildId: "guild-1",
    suggestionId: needsWork.id,
    actorUserId: "admin-1",
    actorRoleIds: [],
    isGuildAdmin: true,
    isAuthor: false,
    expectedRevision: 2,
    toStatus: "planned",
    outcome: { summary: "Accepted for the next release" },
  });
  assert.equal(planned.outcome?.summary, "Accepted for the next release");
  const history = await h.store.listStatusEvents("guild-1", planned.id);
  assert.equal(history[0]?.outcome?.summary, "Accepted for the next release");
  await assert.rejects(
    h.service.transition({
      guildId: "guild-1",
      suggestionId: planned.id,
      actorUserId: "admin-1",
      actorRoleIds: [],
      isGuildAdmin: true,
      isAuthor: false,
      expectedRevision: 3,
      toStatus: "under_review",
    }),
    (error: unknown) =>
      error instanceof SuggestionDomainError && error.code === "invalid-transition",
  );
});

test("SuggestionService changes votes and collapses a Considered Reply exactly once", async () => {
  const h = await harness();
  const result = await h.submit();
  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  const member = {
    isBot: false,
    isGuildMember: true,
    roleIds: [],
    joinedAtMs: 0,
  };
  let suggestion = await h.service.setVote({
    guildId: "guild-1",
    suggestionId: result.suggestion.id,
    memberId: "member-1",
    value: "support",
    member,
  });
  assert.deepEqual([suggestion.supportCount, suggestion.opposeCount], [1, 0]);
  suggestion = await h.service.setVote({
    guildId: "guild-1",
    suggestionId: suggestion.id,
    memberId: "member-1",
    value: "oppose",
    member,
  });
  assert.deepEqual([suggestion.supportCount, suggestion.opposeCount], [0, 1]);
  const reply = await h.service.addConsideredReply({
    guildId: "guild-1",
    suggestionId: suggestion.id,
    authorId: "reply-author",
    perspective: "mixed",
    reasoning: "Useful, but the permissions need more thought.",
  });
  await h.service.setReplyFlag({
    guildId: "guild-1",
    replyId: reply.id,
    memberId: "member-1",
    active: true,
    member,
  });
  await h.service.setReplyFlag({
    guildId: "guild-1",
    replyId: reply.id,
    memberId: "member-2",
    active: true,
    member,
  });
  const collapsed = await h.service.setReplyFlag({
    guildId: "guild-1",
    replyId: reply.id,
    memberId: "member-3",
    active: true,
    member,
  });
  assert.equal(collapsed.state, "collapsed");
  const afterRemoval = await h.service.setReplyFlag({
    guildId: "guild-1",
    replyId: reply.id,
    memberId: "member-1",
    active: false,
    member,
  });
  assert.equal(afterRemoval.state, "collapsed");
  assert.equal(afterRemoval.flagCount, 2);
});

test("SuggestionService rejects incomplete activation and enforces durable per-action limits", async () => {
  const h = await harness();
  await assert.rejects(
    h.service.updateConfig(
      {
        ...defaultSuggestionsConfig("guild-incomplete"),
        enabled: true,
        forumChannelId: "forum",
      },
      "admin",
    ),
    (error: unknown) =>
      error instanceof SuggestionDomainError && error.code === "degraded-projection",
  );

  const result = await h.submit();
  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  const member = {
    isBot: false,
    isGuildMember: true,
    roleIds: [],
    joinedAtMs: 0,
  };
  for (let index = 0; index < 30; index++) {
    await h.service.setVote({
      guildId: "guild-1",
      suggestionId: result.suggestion.id,
      memberId: "rapid-voter",
      value: index % 2 === 0 ? "support" : "oppose",
      member,
    });
  }
  await assert.rejects(
    h.service.setVote({
      guildId: "guild-1",
      suggestionId: result.suggestion.id,
      memberId: "rapid-voter",
      value: "support",
      member,
    }),
    (error: unknown) => error instanceof SuggestionDomainError && error.code === "rate-limit",
  );
});

test("Suggestion projections preserve thread linkage and close Mod Queue controls terminally", async () => {
  const resolved: string[] = [];
  const h = await harness({
    createSuggestion: async () => ({ threadId: "thread-1", starterMessageId: "starter-1" }),
    publishConsideredReply: async () => ({ messageId: "reply-message-1" }),
    collapseConsideredReply: async () => ({ queueMessageId: "queue-message-1" }),
    resolveConsideredReplyQueue: async (reply) => {
      resolved.push(reply.state);
    },
  });
  await h.store.upsertConfig({
    ...(await h.store.readConfig("guild-1"))!,
    modRoleIds: ["suggestion-mod"],
    modQueueChannelId: "queue-1",
  });
  const result = await h.submit();
  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  const reply = await h.service.addConsideredReply({
    guildId: "guild-1",
    suggestionId: result.suggestion.id,
    authorId: "reply-author",
    perspective: "question",
    reasoning: "How would this behave for new members?",
  });
  assert.equal(reply.threadId, "thread-1");
  const member = { isBot: false, isGuildMember: true, roleIds: [], joinedAtMs: 0 };
  for (const memberId of ["flag-1", "flag-2", "flag-3"]) {
    await h.service.setReplyFlag({
      guildId: "guild-1",
      replyId: reply.id,
      memberId,
      active: true,
      member,
    });
  }
  const decision = await h.service.resolveCollapsedReply({
    guildId: "guild-1",
    replyId: reply.id,
    actorUserId: "mod-1",
    actorRoleIds: ["suggestion-mod"],
    isGuildAdmin: false,
    action: "restore",
  });
  assert.equal(decision.queueMessageId, "queue-message-1");
  assert.deepEqual(resolved, ["restored"]);
});

test("Suggestion Discord surfaces expose balanced controls without public voter identity", () => {
  const config = {
    ...defaultSuggestionsConfig("guild-1", 1),
    categories: ["Events", "Moderation"],
  };
  const panel = JSON.stringify(buildSuggestionPanel(config));
  const picker = JSON.stringify(buildSuggestionCategoryPicker(config));
  const starter = JSON.stringify(
    buildSuggestionStarter({
      id: "suggestion-1",
      guildId: "guild-1",
      authorId: "author-1",
      title: "Improve event reminders",
      normalizedSearchText: "improve event reminders",
      answers: [
        { promptId: "change", promptLabel: "What should change?", answer: "More reminders" },
      ],
      category: "Events",
      status: "gathering_feedback",
      revision: 1,
      threadId: "thread-1",
      starterMessageId: "starter-1",
      projectionError: null,
      supportCount: 4,
      opposeCount: 2,
      outcome: null,
      createdAtMs: 1,
      editedAtMs: null,
      updatedAtMs: 1,
    }),
  );
  assert.match(panel, /Create Suggestion/);
  assert.match(picker, /Events/);
  assert.match(starter, /Support/);
  assert.match(starter, /Oppose/);
  assert.doesNotMatch(starter, /voter|flagger/i);
});
