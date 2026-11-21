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
const manifest = JSON.parse(await readFile(join(outputDirectory, ".vite/manifest.json"), "utf8"));

const diskAssets = {};
for (const directory of ["admin/assets"]) {
  for (const name of (await readdir(join(outputDirectory, directory))).sort()) {
    const file = `${directory}/${name}`;
    const source = await readFile(join(outputDirectory, file));
    diskAssets[file] = { file, ...compressedSizes(source) };
  }
}

function closureFiles(entries) {
  return [...new Set(entries.flatMap((file) => staticClosure(file, metadata.chunks)))].sort();
}

function closureReport(entryFile, files) {
  const modules = new Map();
  for (const file of files) {
    for (const [id, renderedBytes] of Object.entries(metadata.chunks[file]?.modules ?? {})) {
      modules.set(id, (modules.get(id) ?? 0) + renderedBytes);
    }
  }
  const javascript = files.map((file) => {
    const asset = diskAssets[file];
    if (!asset) throw new Error(`Missing client chunk: ${file}`);
    return asset;
  });
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

const chunks = Object.entries(metadata.chunks);
const clientEntries = chunks.filter(([, chunk]) => chunk.isEntry).map(([file]) => file);
if (clientEntries.length !== 1) {
  throw new Error(`Expected one Start client entry, found ${clientEntries.length}.`);
}
const [entryFile] = clientEntries;
const adminLayouts = chunks
  .filter(([, chunk]) =>
    Object.keys(chunk.modules).some(
      (id) =>
        id === "src/admin/components/admin-dashboard.tsx" ||
        /^src\/web\/routes\/admin(?:\/_dashboard)?\.tsx\?tsr-split=/.test(id),
    ),
  )
  .map(([file]) => file);
if (adminLayouts.length === 0)
  throw new Error("Admin dashboard layout is missing from the client build.");

const entry = closureReport(entryFile, closureFiles([entryFile, ...adminLayouts]));
const initialFiles = new Set(entry.files);
const initialModules = new Set(
  entry.files.flatMap((file) => Object.keys(metadata.chunks[file].modules)),
);
const dynamicEntries = new Set();
const reachable = new Set([entryFile]);
for (const file of reachable) {
  const chunk = metadata.chunks[file];
  if (!chunk) throw new Error(`Missing client chunk metadata: ${file}`);
  for (const imported of chunk.imports) reachable.add(imported);
  for (const imported of chunk.dynamicImports) {
    dynamicEntries.add(imported);
    reachable.add(imported);
  }
}
for (const layout of adminLayouts) {
  if (!reachable.has(layout)) throw new Error(`Admin layout is unreachable: ${layout}`);
}

const logicalEntries = chunks
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
const routes = {};
const routePageModules = {};
const interactionModules = {};
for (const [id, file] of logicalEntries) {
  const closure = closureReport(
    file,
    closureFiles([file]).filter((dependency) => !initialFiles.has(dependency)),
  );
  if (id.startsWith("route.")) {
    if (routes[id]) throw new Error(`Duplicate admin route closure: ${id}`);
    routes[id] = closure;
    const moduleId = metadata.chunks[file].facadeModuleId;
    routePageModules[id] = {
      moduleId,
      file,
      dynamicallyImported: dynamicEntries.has(file),
      inInitialGraph: initialModules.has(moduleId),
    };
  }
  if (id.startsWith("interaction.")) {
    if (!dynamicEntries.has(file) || initialFiles.has(file)) {
      throw new Error(`Admin interaction must remain on demand: ${id}`);
    }
    interactionModules[id] = closure;
  }
}

const cssFiles = new Set(
  [entry, ...Object.values(routes)].flatMap(({ files }) =>
    files.flatMap((file) => metadata.chunks[file].css),
  ),
);
for (const { src, file } of Object.values(manifest)) {
  if (/(?:^|\/)src\/landing\//.test(src) && file.endsWith(".css")) cssFiles.delete(file);
}
if (cssFiles.size === 0) throw new Error("No CSS found in the Admin client graph.");
const css = [...cssFiles].sort().map((file) => {
  const asset = diskAssets[file];
  if (!asset) throw new Error(`Missing client stylesheet: ${file}`);
  return asset;
});
const assets = Object.values(diskAssets).sort((left, right) => left.file.localeCompare(right.file));
const chunkImporters = new Map();
const moduleChunks = new Map();
for (const [file, chunk] of chunks) {
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
  css,
  assets,
  sharedChunks,
  duplicateModules,
  inlineDataUrls,
};

const lines = [
  "# Admin bundle report",
  "",
  `Initial JS: ${entry.rawBytes} raw / ${entry.gzipBytes} gzip / ${entry.brotliBytes} Brotli bytes`,
  `Admin CSS: ${report.css.reduce((sum, asset) => sum + asset.gzipBytes, 0)} gzip bytes`,
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
