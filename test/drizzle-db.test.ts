import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createHafDatabaseCapability } from "./support/sqlite/runtime/haf-database-capability";
import { createTestDatabase } from "./support/sqlite-d1-database";

for (const failRead of [false, true]) {
  test(`database reads ${failRead ? "propagate failures" : "preserve empty results"} without retrying`, async () => {
    const database = await createTestDatabase();
    const unavailable = new Error("database unavailable");
    let reads = 0;
    const binding = new Proxy(database.d1, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (query: string) => {
          const statement = target.prepare(query);
          const bind = statement.bind.bind(statement);
          statement.bind = (...values: unknown[]) => {
            const bound = bind(...values);
            const all = bound.all.bind(bound);
            const first = bound.first.bind(bound);
            bound.all = async () => {
              reads += 1;
              if (failRead) throw unavailable;
              return all();
            };
            bound.first = async () => {
              reads += 1;
              return first();
            };
            return bound;
          };
          return statement;
        };
      },
    });
    try {
      const databaseCapability = createHafDatabaseCapability(binding);
      const read = () => databaseCapability.drizzle.all(sql`SELECT * FROM app_config WHERE 1 = 0`);
      if (failRead) {
        await assert.rejects(
          read(),
          (error: unknown) =>
            error instanceof Error && (error.cause === unavailable || error === unavailable),
        );
      } else {
        assert.deepEqual(await read(), []);
      }
      assert.equal(reads, 1);
    } finally {
      database.close();
    }
  });
}
