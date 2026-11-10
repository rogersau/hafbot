/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { copyTextToClipboard } from "../src/admin/lib/clipboard";

type ClipboardWrite = (value: string) => Promise<void>;

function installClipboard(writeText: ClipboardWrite | null): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousNavigator = (globalThis as typeof globalThis & { navigator?: Navigator }).navigator;
  const nextNavigator = previousNavigator
    ? (Object.create(previousNavigator) as Navigator)
    : ({} as Navigator);

  if (writeText) {
    Object.defineProperty(nextNavigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  } else {
    Reflect.deleteProperty(nextNavigator, "clipboard");
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: nextNavigator,
  });

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "navigator", previousDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  };
}

test("copyTextToClipboard copies the exact supplied string", async () => {
  const supplied = "  exact value\nwith surrounding whitespace  ";
  let copied = "";
  const restore = installClipboard(async (value) => {
    copied = value;
  });

  try {
    await copyTextToClipboard(supplied);
    assert.equal(copied, supplied);
  } finally {
    restore();
  }
});

test("copyTextToClipboard resolves only after writeText succeeds", async () => {
  let resolveWrite: () => void = () => {
    throw new Error("write promise was not initialised");
  };
  const writePromise = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  let copyResolved = false;
  const restore = installClipboard(async () => writePromise);

  try {
    const copyPromise = copyTextToClipboard("deferred").then(() => {
      copyResolved = true;
    });

    await Promise.resolve();
    assert.equal(copyResolved, false);

    resolveWrite();
    await copyPromise;
    assert.equal(copyResolved, true);
  } finally {
    restore();
  }
});

test("copyTextToClipboard rejects when clipboard support is unavailable", async () => {
  const restore = installClipboard(null);

  try {
    await assert.rejects(
      copyTextToClipboard("unavailable"),
      new Error("Clipboard is unavailable in this environment."),
    );
  } finally {
    restore();
  }
});

test("copyTextToClipboard rejects when writeText rejects", async () => {
  const restore = installClipboard(async () => {
    throw new Error("browser permission details");
  });

  try {
    await assert.rejects(
      copyTextToClipboard("failed copy"),
      new Error("Failed to copy to clipboard."),
    );
  } finally {
    restore();
  }
});

test("copyTextToClipboard never places copied content in its error", async () => {
  const secret = "private copied content";
  const restore = installClipboard(async () => {
    throw new Error(`browser rejected ${secret}`);
  });

  try {
    await assert.rejects(copyTextToClipboard(secret), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Failed to copy to clipboard.");
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  } finally {
    restore();
  }
});
