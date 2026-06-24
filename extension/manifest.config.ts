import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Eva Insight",
  description: "AI side panel that reads and acts on the web.",
  version: pkg.version || "0.0.0",
  version_name: "0.0.0-dev",
  action: {
    default_title: "Open Eva Insight",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  permissions: [
    "sidePanel",
    "tabs",
    "activeTab",
    "scripting",
    "storage",
    "alarms",
    "webNavigation",
    "debugger",
  ],
  host_permissions: ["<all_urls>"],
  icons: {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  minimum_chrome_version: "116",
});
