import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/node/discord-command-sync-main.ts"],
    outfile: "dist-node/discord-command-sync.mjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/runtime/postgres/postgres-capability.ts"],
    outfile: "dist-node/postgres-capability.mjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/runtime/postgres/postgres-migrations.ts"],
    outfile: "dist-node/postgres-migrations.mjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/node/object-migration-main.ts"],
    outfile: "dist-node/object-migration.mjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/node/postgres-jobs-main.ts"],
    outfile: "dist-node/postgres-jobs.mjs",
  }),
]);
