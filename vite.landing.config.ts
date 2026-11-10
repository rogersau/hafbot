import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist-landing",
    emptyOutDir: true,
    // Inline only tiny assets; larger shared media must remain independently cacheable.
    assetsInlineLimit: 4_096,
    rollupOptions: {
      input: {
        home: "src/landing/home.ts",
        changelog: "src/landing/changelog.ts",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "landing.css";
          return "[name].[ext]";
        },
      },
    },
  },
});
