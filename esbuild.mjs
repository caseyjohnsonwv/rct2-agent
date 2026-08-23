import { build } from "esbuild";
import { mkdirSync } from "node:fs";

const which = process.argv[2]; // "plugin" | "server" | undefined (both)

mkdirSync("dist", { recursive: true });

const common = { bundle: true, logLevel: "info", sourcemap: false };

async function buildPlugin() {
  // OpenRCT2 plugin: a single script that calls the global registerPlugin().
  // Target older JS — OpenRCT2's Duktape engine is roughly ES5/ES2015.
  await build({
    ...common,
    entryPoints: ["src/plugin/main.ts"],
    outfile: "dist/rct2-agent.plugin.js",
    format: "iife",
    platform: "neutral",
    target: ["es2017"],
  });
  console.log("built dist/rct2-agent.plugin.js");
}

async function buildServer() {
  await build({
    ...common,
    entryPoints: ["src/server/index.ts"],
    outfile: "dist/server.mjs",
    format: "esm",
    platform: "node",
    target: ["node20"],
    // keep node built-ins + deps external? bundle deps for a single-file server.
    packages: "external",
  });
  console.log("built dist/server.mjs");
}

if (which === "plugin") await buildPlugin();
else if (which === "server") await buildServer();
else {
  await buildPlugin();
  await buildServer();
}
