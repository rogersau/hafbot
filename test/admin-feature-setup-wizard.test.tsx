/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import { FeatureSetupWizard } from "../src/admin/components/feature-setup-wizard";

const steps = [
  {
    id: "first",
    label: "First choice",
    purpose: "Make the first choice for a clear reason.",
    changes: "Updates the first setting.",
    outcome: "The first part is ready.",
    content: <p>First content</p>,
  },
  {
    id: "second",
    label: "Second choice",
    purpose: "Finish the setup deliberately.",
    changes: "Updates the second setting.",
    outcome: "The setup can be verified.",
    content: <p>Second content</p>,
  },
];

test("FeatureSetupWizard exposes semantic progress for the active step", () => {
  const html = renderToString(
    <FeatureSetupWizard
      title="Example setup"
      description="Configure the example."
      steps={steps}
      defaultStep={1}
    />,
  );
  const document = new JSDOM(html).window.document;
  const currentStep = document.querySelector('[aria-current="step"]');

  assert.match(html, /Example setup/);
  assert.match(html, /aria-label="Example setup progress"/);
  assert.equal(currentStep?.textContent, "2. Second choice");
  assert.match(html, /Second content/);
  assert.doesNotMatch(html, /First content/);
  assert.match(document.body.textContent ?? "", /Step 2 of 2/);
});

test("FeatureSetupWizard explains the journey and the active step", () => {
  const html = renderToString(
    <FeatureSetupWizard
      title="Example setup"
      description="Configure the example."
      steps={[
        {
          ...steps[0]!,
          purpose: "Choose the member-facing starting point.",
          outcome: "Members know where to begin.",
          changes: "Creates one public Discord message.",
        },
        {
          ...steps[1]!,
          purpose: "Confirm that the complete flow works.",
          outcome: "A controlled test succeeds.",
        },
      ]}
    />,
  );

  assert.match(html, /Your setup journey/);
  assert.match(html, /Why this step/);
  assert.match(html, /Choose the member-facing starting point/);
  assert.match(html, /What this changes/);
  assert.match(html, /Creates one public Discord message/);
  assert.match(html, /What success looks like/);
  assert.match(html, /Members know where to begin/);
});

test("FeatureSetupWizard gates Continue and supports Back navigation", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.com/admin",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <FeatureSetupWizard
          title="Example setup"
          steps={[
            { ...steps[0]!, canContinue: false, continueHint: "Make a choice first." },
            steps[1]!,
          ]}
        />,
      );
    });

    const disabledContinue = findButton(container, "Continue");
    assert.equal(disabledContinue.disabled, true);
    assert.match(container.textContent ?? "", /Make a choice first\./);

    await act(async () => {
      root.render(<FeatureSetupWizard title="Example setup" steps={steps} />);
    });
    await act(async () => findButton(container, "Continue").click());
    assert.match(container.textContent ?? "", /Second content/);

    await act(async () => findButton(container, "Back").click());
    assert.match(container.textContent ?? "", /First content/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

function findButton(container: Element, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(button, `Expected ${label} button`);
  return button as HTMLButtonElement;
}
