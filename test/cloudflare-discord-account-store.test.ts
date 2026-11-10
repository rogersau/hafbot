/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareDiscordAccountStore } from "../src/runtime/cloudflare-discord-account-store";

test("createCloudflareDiscordAccountStore returns null when no Discord account exists", async () => {
  const database = new FakeD1Database();
  const store = createCloudflareDiscordAccountStore(database as unknown as D1Database);

  assert.equal(await store.readDiscordAccessToken("user-1"), null);
});

test("createCloudflareDiscordAccountStore returns the stored Discord access token", async () => {
  const database = new FakeD1Database();
  database.seedAccount({
    userId: "user-1",
    providerId: "google",
    accessToken: "google-token",
    updatedAt: "2026-05-25T10:00:00.000Z",
  });
  database.seedAccount({
    userId: "user-1",
    providerId: "discord",
    accessToken: "discord-token",
    updatedAt: "2026-05-25T12:00:00.000Z",
  });
  const store = createCloudflareDiscordAccountStore(database as unknown as D1Database);

  assert.equal(await store.readDiscordAccessToken("user-1"), "discord-token");
});

interface AccountRow {
  userId: string;
  providerId: string;
  accessToken: string | null;
  updatedAt: string;
}

class FakeD1Database {
  private readonly accounts: AccountRow[] = [];

  prepare(query: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this, normalizeSql(query));
  }

  seedAccount(account: AccountRow): void {
    this.accounts.push(account);
  }

  selectFirst<T>(query: string, values: readonly unknown[]): T | null {
    if (
      query ===
      'SELECT "accessToken" FROM "Account" WHERE "userId" = ? AND "providerId" = ? ORDER BY "updatedAt" DESC LIMIT 1'
    ) {
      const [userId, providerId] = values;
      const row = [...this.accounts]
        .filter((account) => account.userId === userId && account.providerId === providerId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

      return row ? ({ accessToken: row.accessToken } as T) : null;
    }

    throw new Error(`Unsupported first query: ${query}`);
  }
}

class FakeD1PreparedStatement {
  constructor(
    private readonly database: FakeD1Database,
    private readonly query: string,
    private readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.database, this.query, values);
  }

  async first<T>(): Promise<T | null> {
    return this.database.selectFirst<T>(this.query, this.values);
  }
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}
