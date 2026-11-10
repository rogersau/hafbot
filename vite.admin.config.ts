import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function externalizeLargeDataUrls(): Plugin {
  const dataUrlPattern =
    /(["'])(url\()?data:([a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/=]+)(\))?\1/g;
  const assets = new Map<string, string>();

  return {
    name: "admin-externalize-large-data-urls",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;

        output.code = output.code.replace(
          dataUrlPattern,
          (
            whole,
            quote: string,
            prefix: string | undefined,
            mimeType: string,
            payload: string,
            suffix: string | undefined,
          ) => {
            if (Boolean(prefix) !== Boolean(suffix)) return whole;
            const bytes = Buffer.from(payload, "base64");
            if (bytes.byteLength <= 4096) return whole;

            const extension = mimeType === "image/svg+xml" ? "svg" : "bin";
            const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
            const fileName = `admin/assets/inline-${hash}.${extension}`;
            if (!assets.has(fileName)) {
              this.emitFile({ type: "asset", fileName, source: bytes });
              assets.set(fileName, mimeType);
            }
            return `${quote}${prefix ?? ""}/admin/assets/inline-${hash}.${extension}${suffix ?? ""}${quote}`;
          },
        );
      }
    },
  };
}

function adminBundleMetadata(): Plugin {
  return {
    name: "admin-bundle-metadata",
    generateBundle(_options, bundle) {
      const normalize = (id: string) => relative(process.cwd(), id).split(sep).join("/");
      const chunks = Object.fromEntries(
        Object.entries(bundle)
          .filter(
            (entry): entry is [string, Extract<(typeof entry)[1], { type: "chunk" }>] =>
              entry[1].type === "chunk",
          )
          .map(([fileName, chunk]) => [
            fileName,
            {
              facadeModuleId: chunk.facadeModuleId ? normalize(chunk.facadeModuleId) : null,
              imports: [...chunk.imports].sort(),
              dynamicImports: [...chunk.dynamicImports].sort(),
              modules: Object.fromEntries(
                Object.entries(chunk.modules)
                  .map(([id, module]) => [normalize(id), module.renderedLength])
                  .sort(([left], [right]) => left.localeCompare(right)),
              ),
            },
          ]),
      );

      this.emitFile({
        type: "asset",
        fileName: ".vite/admin-bundle-metadata.json",
        source: `${JSON.stringify({ schemaVersion: 1, chunks }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), externalizeLargeDataUrls(), adminBundleMetadata()],
  build: {
    minify: "terser",
    terserOptions: { compress: { passes: 2 } },
    outDir: "dist-admin",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: { admin: "src/admin/main.tsx" },
      output: {
        entryFileNames: "admin/assets/[name].js",
        chunkFileNames: "admin/assets/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "admin/assets/admin.css";
          return "admin/assets/[name].[ext]";
        },
      },
    },
  },
});
