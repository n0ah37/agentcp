import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests run against a throwaway home folder, never the real ~/.claude.
const home = path.join(os.tmpdir(), `acp-test-home-${process.pid}`);

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
    // OpenCode's folders follow XDG_CONFIG_HOME and XDG_DATA_HOME, and its database OPENCODE_DB, so a shell that sets
    // any of them can't point a test at the real ones. OpenCode ships after 1.0; ACP_OPENCODE=1 tests it anyway.
    env: { ACP_OPENCODE: "1", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ACP_HOME: path.join(home, ".agent-control-plane"), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), OPENCODE_DB: "" },
    testTimeout: 20000,
    fileParallelism: false,
  },
});
