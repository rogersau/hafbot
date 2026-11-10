import assert from "node:assert/strict";
import test from "node:test";
import { createAdminApiHandler } from "./helpers/admin-api";
import type { CommunityToolsService } from "../src/community-tools/service";
import { automationConfigSchema } from "../src/community-tools/config";

test("community configuration enforces Guild/workspace read and write authorization before service calls", async () => {
  const calls: string[] = [];
  const requirements: Array<{
    guildId?: string | null;
    workspaceId?: string | null;
    mode: string;
  }> = [];
  const config = automationConfigSchema.parse({});
  const service = {
    dashboard: async (guildId: string) => {
      calls.push(`read:${guildId}`);
      return { config, revision: 0 };
    },
    save: async (guildId: string, _feature: string, next: unknown, revision: number) => {
      calls.push(`write:${guildId}:${revision}`);
      return { config: next, revision: revision + 1 };
    },
  } as unknown as CommunityToolsService;
  const handler = createAdminApiHandler({
    stores: {} as never,
    discordBotToken: "test-token",
    communityTools: service,
    adminAccess: {
      authorize: async (_request, requirement) => {
        requirements.push(requirement);
        return requirement.guildId === "100"
          ? { ok: true }
          : { ok: false, error: { _tag: "Forbidden", message: "Forbidden" } };
      },
    },
  });
  const denied = await handler(
    new Request(
      "https://haf.example/admin/api/community-automation?guildId=200&workspaceId=workspace-a",
    ),
    new URL(
      "https://haf.example/admin/api/community-automation?guildId=200&workspaceId=workspace-a",
    ),
  );
  assert.equal(denied?.status, 403);
  assert.deepEqual(calls, []);
  const writeUrl = new URL("https://haf.example/admin/api/community-automation");
  const saved = await handler(
    new Request(writeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "100", workspaceId: "workspace-a", config, revision: 0 }),
    }),
    writeUrl,
  );
  assert.equal(saved?.status, 200);
  assert.deepEqual(calls, ["write:100:0"]);
  assert.deepEqual(requirements[1], { mode: "write", guildId: "100", workspaceId: "workspace-a" });
  const bad = await handler(
    new Request(writeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "100", config, revision: -1 }),
    }),
    writeUrl,
  );
  assert.equal(bad?.status, 400);
  assert.equal(calls.length, 1);
});
