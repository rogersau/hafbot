/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";

import {
  AdminSuggestionsPage,
  suggestionExcerpt,
  validateSuggestionCategoryRename,
  validateTransitionDraft,
} from "../src/admin/components/admin-suggestions-page";
import {
  defaultSuggestionsConfig,
  type ConsideredReply,
  type Suggestion,
} from "../src/suggestions";

const suggestion: Suggestion = {
  id: "suggestion-1",
  guildId: "guild-1",
  authorId: "author-1",
  title: "Improve onboarding",
  normalizedSearchText: "improve onboarding",
  answers: [{ promptId: "change", promptLabel: "What should change?", answer: "Add a checklist." }],
  category: "Community",
  status: "under_review",
  revision: 2,
  threadId: "thread-1",
  starterMessageId: "message-1",
  projectionError: null,
  supportCount: 12,
  opposeCount: 3,
  outcome: null,
  createdAtMs: Date.now() - 3_600_000,
  editedAtMs: null,
  updatedAtMs: Date.now() - 3_600_000,
};

const collapsedReply: ConsideredReply = {
  id: "reply-1",
  suggestionId: suggestion.id,
  threadId: "thread-1",
  guildId: "guild-1",
  authorId: "reply-author-1",
  perspective: "mixed",
  reasoning: "The proposal is useful but needs an owner.",
  improvement: "Name the onboarding lead.",
  state: "collapsed",
  flagCount: 2,
  webhookMessageId: null,
  queueMessageId: "queue-1",
  collapsedAtMs: Date.now(),
  resolvedAtMs: null,
  resolvedByUserId: null,
  resolutionReason: null,
  createdAtMs: Date.now() - 120_000,
  updatedAtMs: Date.now(),
};

function renderPage(replies: ConsideredReply[] = [collapsedReply]) {
  return renderToString(
    <AdminSuggestionsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{
        guildId: "guild-1",
        config: defaultSuggestionsConfig("guild-1"),
        suggestions: [suggestion],
        collapsedReplies: replies,
        readiness: { state: "ready", checks: {} },
      }}
    />,
  );
}

test("Suggestions cards are decision-ready and expose one contextual transition action", () => {
  const html = renderPage([]);

  assert.match(html, /Improve onboarding/);
  assert.match(html, /Community/);
  assert.match(html, /Add a checklist/);
  assert.match(html, /Support:/);
  assert.match(html, />12</);
  assert.match(html, /Discord user ID:/);
  assert.match(html, /author-1/);
  assert.match(html, />Change status</);
  assert.match(html, />View details</);
  assert.doesNotMatch(html, /Public outcome summary/);
});

test("collapsed replies render as a linked read-only moderation queue", () => {
  const html = renderPage();

  assert.match(html, /1 unresolved reply/);
  assert.match(html, /Improve onboarding/);
  assert.match(html, /Mixed.*perspective/);
  assert.match(html, /2.*flags/);
  assert.match(html, /Show collapsed reply/);
  assert.match(html, /The proposal is useful but needs an owner/);
  assert.match(html, /Name the onboarding lead/);
  assert.match(html, /Review Suggestion/);
  assert.match(html, /Reply actions remain in the existing Discord moderation workflow/);
  assert.doesNotMatch(html, />Restore</);
  assert.doesNotMatch(html, />Delete</);
});

test("transition validation requires outcomes and reopening reasons within contract limits", () => {
  assert.equal(
    validateTransitionDraft(suggestion, {
      toStatus: "planned",
      reason: "",
      outcomeSummary: "",
      nextStepOrLink: "",
    }),
    "Enter the public outcome before reviewing this transition.",
  );
  assert.equal(
    validateTransitionDraft(
      { status: "implemented" },
      {
        toStatus: "under_review",
        reason: "",
        outcomeSummary: "",
        nextStepOrLink: "",
      },
    ),
    "Enter a reason for reopening this Suggestion.",
  );
  assert.equal(
    validateTransitionDraft(suggestion, {
      toStatus: "planned",
      reason: "",
      outcomeSummary: "We will build this.",
      nextStepOrLink: "",
    }),
    null,
  );
});

test("Suggestion excerpts keep long structured answers scannable", () => {
  const excerpt = suggestionExcerpt({
    answers: [{ promptId: "one", promptLabel: "One", answer: "x".repeat(300) }],
  });
  assert.equal(excerpt.length, 238);
  assert.match(excerpt, /…$/);
});

test("invalid category renames preserve the previous category", () => {
  assert.deepEqual(
    validateSuggestionCategoryRename("   ", "Community", ["Community", "Events"], 0),
    { value: "Community", error: "Category name cannot be empty." },
  );
  assert.deepEqual(
    validateSuggestionCategoryRename(" events ", "Community", ["Community", "Events"], 0),
    { value: "Community", error: "Category names must be unique." },
  );
  assert.deepEqual(
    validateSuggestionCategoryRename(" Product ", "Community", ["Community", "Events"], 0),
    { value: "Product", error: null },
  );
});
