/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";

import { areTicketPanelConfigsEqual } from "../src/admin/components/admin-tickets-page";
import { TicketPanelEditor } from "../src/admin/components/ticket-panel-editor";
import type { TicketPanelConfig, TicketTypeConfig } from "../src/types";

test("Ticket Type move controls preserve configuration and follow expanded editor state", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.com/admin/guild-1/tickets?tab=types",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });

  const initialValue = createPanel();
  const changedValues: TicketPanelConfig[] = [];
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  function Harness() {
    const [value, setValue] = useState(initialValue);
    return (
      <TicketPanelEditor
        guildResources={guildResources}
        value={value}
        onChange={(next) => {
          changedValues.push(next);
          setValue(next);
        }}
        tab="types"
      />
    );
  }

  try {
    await act(async () => {
      root.render(<Harness />);
    });

    await clickTicketTypeSummaryAt(container, 1);
    await clickButtonByLabel(container, "Move Billing up");

    const reorderedValue = changedValues.at(-1);
    assert.ok(reorderedValue);
    assert.deepEqual(
      reorderedValue.ticketTypes.map((ticketType) => ticketType.id),
      ["billing", "appeal", "other"],
    );
    assert.deepEqual(reorderedValue.ticketTypes[0], initialValue.ticketTypes[1]);
    assert.deepEqual(reorderedValue.ticketTypes[1], initialValue.ticketTypes[0]);
    assert.equal(
      [...container.querySelectorAll<HTMLDetailsElement>("details.bg-background")][1]?.open,
      true,
      "the expanded Ticket Type must follow its stable UI key after moving",
    );
    assert.equal(areTicketPanelConfigsEqual(initialValue, reorderedValue), false);

    await clickButtonByLabel(container, "Move Billing down");
    await clickButtonByLabel(container, "Move Billing down");
    const repeatedlyMovedValue = changedValues.at(-1);
    assert.ok(repeatedlyMovedValue);
    assert.deepEqual(
      repeatedlyMovedValue.ticketTypes.map((ticketType) => ticketType.id),
      ["appeal", "other", "billing"],
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      getComputedStyle: previousGetComputedStyle,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

test("Ticket Type and modal question move controls disable at their list boundaries", () => {
  const value = createPanel();
  value.ticketTypes[0]!.questions = [
    createQuestion("appeal-reason", "Reason", "Why are you opening this ticket?"),
    createQuestion("appeal-platform", "Platform", "Which platform is affected?"),
    createQuestion("appeal-context", "Context", "What else should staff know?"),
  ];
  const html = renderToString(
    <TicketPanelEditor
      guildResources={guildResources}
      value={value}
      onChange={() => {}}
      tab="types"
    />,
  );
  const document = new JSDOM(html).window.document;

  assert.equal(findButton(document, "Move Appeal up").disabled, true);
  assert.equal(findButton(document, "Move Appeal down").disabled, false);
  assert.equal(findButton(document, "Move Billing up").disabled, false);
  assert.equal(findButton(document, "Move Billing down").disabled, false);
  assert.equal(findButton(document, "Move Other up").disabled, false);
  assert.equal(findButton(document, "Move Other down").disabled, true);
  assert.equal(findButton(document, "Move Reason up").disabled, true);
  assert.equal(findButton(document, "Move Reason down").disabled, false);
  assert.equal(findButton(document, "Move Platform up").disabled, false);
  assert.equal(findButton(document, "Move Platform down").disabled, false);
  assert.equal(findButton(document, "Move Context up").disabled, false);
  assert.equal(findButton(document, "Move Context down").disabled, true);
});

test("modal question move controls preserve configuration and follow expanded editor state", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.com/admin/guild-1/tickets?tab=types",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });

  const initialValue = createPanel();
  const appeal = initialValue.ticketTypes[0]!;
  appeal.questions = [
    createQuestion("appeal-reason", "Reason", "Why are you opening this ticket?"),
    createQuestion("appeal-platform", "Platform", "Which platform is affected?"),
    createQuestion("appeal-context", "Context", "What else should staff know?"),
  ];
  const changedValues: TicketPanelConfig[] = [];
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  function Harness() {
    const [value, setValue] = useState(initialValue);
    return (
      <TicketPanelEditor
        guildResources={guildResources}
        value={value}
        onChange={(next) => {
          changedValues.push(next);
          setValue(next);
        }}
        tab="types"
      />
    );
  }

  try {
    await act(async () => {
      root.render(<Harness />);
    });

    await clickSummaryAt(container, 1);
    await clickButtonByLabel(container, "Move Platform down");

    const reorderedValue = changedValues.at(-1);
    assert.ok(reorderedValue);
    assert.deepEqual(
      reorderedValue.ticketTypes[0]?.questions.map((question) => question.id),
      ["appeal-reason", "appeal-context", "appeal-platform"],
    );
    assert.deepEqual(
      reorderedValue.ticketTypes[0]?.questions[2],
      initialValue.ticketTypes[0]!.questions[1],
    );
    assert.equal(questionDetails(container)[2]?.open, true);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      getComputedStyle: previousGetComputedStyle,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

const guildResources = {
  guildId: "guild-1",
  roles: [{ id: "support-role", name: "Support" }],
  categories: [{ id: "category-1", name: "Open Tickets" }],
  textChannels: [{ id: "transcript-1", name: "ticket-transcripts" }],
};

function createPanel(): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelChannelId: "panel-channel-1",
    categoryChannelId: "category-1",
    transcriptChannelId: "transcript-1",
    panelEmoji: null,
    panelTitle: "Support tickets",
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [
      createTicketType("appeal", "Appeal", "appeal-prefix"),
      createTicketType("billing", "Billing", "billing-prefix"),
      createTicketType("other", "Other", "other-prefix"),
    ],
  };
}

function createTicketType(id: string, label: string, channelNamePrefix: string): TicketTypeConfig {
  return {
    id,
    label,
    emoji: null,
    buttonStyle: "primary",
    supportRoleId: "support-role",
    allowedCreatorRoleIds: ["member-role"],
    channelNamePrefix,
    questions: [createQuestion(`${id}-details`, `${label} details`, `Tell us about ${id}`)],
    responseRules: [],
    defaultTicketLinkPlatform: null,
    anonymousSupportEnabled: false,
    staffDiscussionThreadEnabled: false,
    ticketHistoryPromptVisibility: "off",
    participantManagementEnabled: false,
    limitExclusion: false,
    mentionSupportRole: false,
  };
}

function createQuestion(id: string, label: string, placeholder: string) {
  return {
    id,
    label,
    style: "paragraph" as const,
    placeholder,
    required: true,
    validation: "none" as const,
  };
}

async function clickButtonByLabel(container: Element, label: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(button, `Expected button ${label}`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function clickSummaryAt(container: Element, index: number): Promise<void> {
  const summary = questionDetails(container)[index]?.querySelector("summary");
  assert.ok(summary, `Expected modal question summary ${index + 1}`);
  await act(async () => {
    summary.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function clickTicketTypeSummaryAt(container: Element, index: number): Promise<void> {
  const summary = ticketTypeDetails(container)[index]?.querySelector("summary");
  assert.ok(summary, `Expected Ticket Type summary ${index + 1}`);
  await act(async () => {
    summary.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function ticketTypeDetails(container: Element): HTMLDetailsElement[] {
  return [...container.querySelectorAll<HTMLDetailsElement>("details")].filter((details) =>
    details.classList.contains("bg-background"),
  );
}

function questionDetails(container: Element): HTMLDetailsElement[] {
  return [...container.querySelectorAll<HTMLDetailsElement>("details")].filter((details) =>
    details.classList.contains("bg-muted/20"),
  );
}

function findButton(container: ParentNode, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(button, `Expected button ${label}`);
  return button;
}
