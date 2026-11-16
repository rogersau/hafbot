import assert from "node:assert/strict";
import test from "node:test";
import { handleMessageComponentInteraction } from "../src/runtime/ticket-interaction-handler";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { createTicketHandlerLifecycle } from "./support/ticket-handler-lifecycle";

test("deferred ticket responses handle a deleted original without retrying or logging an action failure", async (t) => {
  for (const scenario of ["success", "deleted", "other-404", "malformed-404", "server-error"]) {
    await t.test(scenario, async (t) => {
      const f = createProductionRuntimeStores();
      t.after(f.close);
      const originalFetch = globalThis.fetch;
      const originalError = console.error;
      const originalWarn = console.warn;
      t.after(() => {
        globalThis.fetch = originalFetch;
        console.error = originalError;
        console.warn = originalWarn;
      });
      const errors: unknown[][] = [];
      const warnings: unknown[][] = [];
      console.error = (...args) => {
        errors.push(args);
      };
      console.warn = (...args) => {
        warnings.push(args);
      };
      let edits = 0;
      globalThis.fetch = async (input, init) => {
        assert.match(
          String(input),
          /\/webhooks\/app-test\/test-interaction-token\/messages\/@original$/,
        );
        assert.equal(init?.method, "PATCH");
        edits++;
        if (scenario === "success") return Response.json({ id: "response" });
        if (scenario === "malformed-404") return new Response("not JSON", { status: 404 });
        return Response.json(
          {
            code: scenario === "deleted" ? 10008 : 10015,
            message: scenario === "deleted" ? "Unknown Message" : "Unexpected failure",
          },
          { status: scenario === "server-error" ? 500 : 404 },
        );
      };
      const pending: Promise<unknown>[] = [];
      const response = await handleMessageComponentInteraction(
        {
          type: 3,
          application_id: "app-test",
          token: "test-interaction-token",
          guild_id: "guild-test",
          channel_id: "ticket-test",
          member: { user: { id: "staff-test" }, roles: [] },
          data: { custom_id: "ticket:claim:ticket-test" },
        },
        {
          stores: f.stores,
          ticketLifecycle: createTicketHandlerLifecycle(f.stores),
          discordBotToken: "test-bot-token",
          requestOrigin: "https://runtime.example",
          waitUntil: (promise) => {
            pending.push(promise);
          },
        },
      );
      assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
      assert.equal(pending.length, 1);
      if (scenario === "success" || scenario === "deleted") {
        await Promise.all(pending);
        assert.equal(edits, 1);
        assert.deepEqual(errors, []);
        assert.deepEqual(
          warnings,
          scenario === "deleted"
            ? [
                [
                  "Deferred ticket response is no longer available",
                  { reasonCode: "unknown_message" },
                ],
              ]
            : [],
        );
      } else {
        await assert.rejects(() => Promise.all(pending));
        assert.ok(errors.length > 0);
        assert.deepEqual(warnings, []);
      }
    });
  }
});
