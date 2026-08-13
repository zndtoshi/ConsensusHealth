import { execFileSync } from "node:child_process";

// The E2E backend intentionally runs with NODE_ENV=test so its strictly gated
// OAuth fixtures are available. Build the browser bundle as production first,
// otherwise Vite compiles out import.meta.env.PROD failure handling.
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  env: { ...process.env, NODE_ENV: "production" },
  stdio: "inherit",
});
