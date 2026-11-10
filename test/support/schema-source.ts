import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TestMigration {
  name: string;
  sql: string;
}
export interface TestSchemaSource {
  id: string;
  migrations(): readonly TestMigration[];
}

export function currentSchemaSource(): TestSchemaSource {
  return {
    id: "current-unified",
    migrations() {
      return readdirSync(join("migrations", "unified"))
        .filter((name) => name.endsWith(".sql"))
        .sort((left, right) => left.localeCompare(right))
        .map((name) => ({
          name: `unified/${name}`,
          sql: readFileSync(join("migrations", "unified", name), "utf8"),
        }));
    },
  };
}

export function orderedTestMigrationNames(): readonly string[] {
  return currentSchemaSource()
    .migrations()
    .map(({ name }) => name);
}
