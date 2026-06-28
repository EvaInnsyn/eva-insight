import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Eva Insight",
  description: "AI side panel that reads and acts on the web.",
  version: pkg.version,
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
  ],
  host_permissions: ["<all_urls>"],
  content_security_policy: {
    extension_pages:
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src https:;",
  },
  icons: {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  minimum_chrome_version: "116",
});
