import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compressedSizes,
  findInlineDataUrls,
  logicalId,
  packageName,
  staticClosure,
} from "./report-lib.mjs";

const outputDirectory = "dist-admin";
const artifactDirectory = "artifacts";
const metadata = JSON.parse(
  await readFile(join(outputDirectory, ".vite/admin-bundle-metadata.json"), "utf8"),
);

const diskAssets = {};
for (const directory of ["admin/assets"]) {
  for (const name of (await readdir(join(outputDirectory, directory))).sort()) {
    const file = `${directory}/${name}`;
    const source = await readFile(join(outputDirectory, file));
    diskAssets[file] = { file, ...compressedSizes(source) };
  }
}

function closureReport(entryFile, excluded = new Set()) {
  const files = staticClosure(entryFile, metadata.chunks).filter((file) => !excluded.has(file));
  const modules = new Map();
  for (const file of files) {
    for (const [id, renderedBytes] of Object.entries(metadata.chunks[file]?.modules ?? {})) {
      modules.set(id, (modules.get(id) ?? 0) + renderedBytes);
    }
  }
  const javascript = files.map((file) => diskAssets[file]).filter(Boolean);
  return {
    entryFile,
    files,
    rawBytes: javascript.reduce((sum, asset) => sum + asset.rawBytes, 0),
    gzipBytes: javascript.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    brotliBytes: javascript.reduce((sum, asset) => sum + asset.brotliBytes, 0),
    modules: [...modules.entries()]
      .map(([id, renderedBytes]) => ({ id, renderedBytes, package: packageName(id) }))
      .sort(
        (left, right) =>
          right.renderedBytes - left.renderedBytes || left.id.localeCompare(right.id),
      )
      .slice(0, 30),
  };
}

const logicalEntries = Object.entries(metadata.chunks)
  .map(([file, chunk]) => {
    let id = logicalId(chunk.facadeModuleId);
    if (
      !id &&
      Object.hasOwn(chunk.modules, "src/admin/components/emoji-picker-implementation.tsx")
    ) {
      id = "interaction.unicodeEmojiPicker";
    }
    if (
      !id &&
      Object.hasOwn(
        chunk.modules,
        "src/admin/components/discord-message-preview-implementation.tsx",
      )
    ) {
      id = "interaction.discordPreview";
    }
    return [id, file];
  })
  .filter(([id]) => id)
  .sort(([left], [right]) => left.localeCompare(right));
const entryFile = logicalEntries.find(([id]) => id === "admin-entry")?.[1];
if (!entryFile) throw new Error("Admin bundle report could not identify src/admin/main.tsx.");
const entry = closureReport(entryFile);
const initialFiles = new Set(entry.files);
const initialModules = new Set(
  entry.files.flatMap((file) => Object.keys(metadata.chunks[file]?.modules ?? {})),
);
const initialDynamicImports = new Set(
  entry.files.flatMap((file) => metadata.chunks[file]?.dynamicImports ?? []),
);
const routes = {};
const routePageModules = {};
const interactionModules = {};
for (const [id, file] of logicalEntries) {
  if (id.startsWith("route.")) {
    routes[id] = closureReport(file, initialFiles);
    const moduleId = metadata.chunks[file].facadeModuleId;
    routePageModules[id] = {
      moduleId,
      file,
      dynamicallyImported: initialDynamicImports.has(file),
      inInitialGraph: initialModules.has(moduleId),
    };
  }
  if (id.startsWith("interaction.")) interactionModules[id] = closureReport(file, initialFiles);
}

const assets = Object.values(diskAssets).sort((left, right) => left.file.localeCompare(right.file));
const chunkImporters = new Map();
const moduleChunks = new Map();
for (const [file, chunk] of Object.entries(metadata.chunks)) {
  for (const imported of chunk.imports) {
    const importers = chunkImporters.get(imported) ?? [];
    importers.push(file);
    chunkImporters.set(imported, importers);
  }
  for (const moduleId of Object.keys(chunk.modules)) {
    const files = moduleChunks.get(moduleId) ?? [];
    files.push(file);
    moduleChunks.set(moduleId, files);
  }
}
const sharedChunks = [...chunkImporters.entries()]
  .filter(([, importers]) => importers.length > 1)
  .map(([file, importers]) => ({ file, importers: importers.sort(), ...diskAssets[file] }))
  .sort((left, right) => left.file.localeCompare(right.file));
const duplicateModules = [...moduleChunks.entries()]
  .filter(([, files]) => files.length > 1)
  .map(([id, files]) => ({ id, files: files.sort() }))
  .sort((left, right) => left.id.localeCompare(right.id));
const inlineDataUrls = [];
for (const asset of assets.filter(({ file }) => /\.(?:js|css)$/.test(file))) {
  const source = await readFile(join(outputDirectory, asset.file), "utf8");
  for (const dataUrl of findInlineDataUrls(source))
    inlineDataUrls.push({ file: asset.file, ...dataUrl });
}
const report = {
  schemaVersion: 1,
  entry,
  routes,
  routePageModules,
  interactionModules,
  css: assets.filter(({ file }) => file.endsWith(".css")),
  assets,
  sharedChunks,
  duplicateModules,
  inlineDataUrls,
};

const lines = [
  "# Admin bundle report",
  "",
  `Initial JS: ${entry.rawBytes} raw / ${entry.gzipBytes} gzip / ${entry.brotliBytes} Brotli bytes`,
  `Initial CSS: ${report.css.reduce((sum, asset) => sum + asset.gzipBytes, 0)} gzip bytes`,
  "",
  "| Logical closure | Raw bytes | Gzip bytes | Brotli bytes |",
  "| --- | ---: | ---: | ---: |",
  ...Object.entries({ ...routes, ...interactionModules }).map(
    ([id, value]) => `| ${id} | ${value.rawBytes} | ${value.gzipBytes} | ${value.brotliBytes} |`,
  ),
  "",
  "## Initial top contributors",
  "",
  ...entry.modules.slice(0, 15).map((module) => `- ${module.id}: ${module.renderedBytes} bytes`),
  "",
];
await mkdir(artifactDirectory, { recursive: true });
await writeFile(
  join(artifactDirectory, "admin-bundle-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
await writeFile(join(artifactDirectory, "admin-bundle-report.md"), `${lines.join("\n")}\n`);
console.log(
  `Admin bundle report: ${entry.gzipBytes} gzip bytes initial JS; ${Object.keys(routes).length} routes.`,
);
