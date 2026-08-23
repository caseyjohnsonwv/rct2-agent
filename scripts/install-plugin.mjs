// Copies the built plugin into the OpenRCT2 plugin folder.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const src = path.resolve("dist/rct2-agent.plugin.js");
const pluginDir = process.env.RCT2_PLUGIN_DIR ||
  "C:\\Users\\casey\\OneDrive\\Documents\\OpenRCT2\\plugin";

if (!existsSync(src)) {
  console.error(`Build first: ${src} not found. Run: npm run build:plugin`);
  process.exit(1);
}
mkdirSync(pluginDir, { recursive: true });
const dest = path.join(pluginDir, "rct2-agent.plugin.js");
copyFileSync(src, dest);
console.log(`installed plugin -> ${dest}`);
