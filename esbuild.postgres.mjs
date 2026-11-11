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
    entryPoints: ["src/runtime/postgres/postgres-schema.ts"],
    outfile: "dist-node/postgres-schema.mjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/node/postgres-jobs-main.ts"],
    outfile: "dist-node/postgres-jobs.mjs",
  }),
]);
