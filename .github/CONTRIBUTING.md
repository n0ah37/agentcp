# Contributing

Thanks for helping. A few things keep AgentCP trustworthy, so pull requests are held to them.

## Run it

```bash
pnpm install
pnpm docs        # Claude Code's and Codex's documentation, which every check quotes
pnpm dev         # the app in a browser, on 127.0.0.1:3100
pnpm app         # the desktop app
pnpm test        # the engine's tests, against a throwaway home folder
pnpm typecheck && pnpm lint
```

## The rules the code keeps

- **The engine is the only code that touches files**, and `engine/lib/write.ts` is the only writer: it shows the change first, refuses a save if the file moved on disk, writes atomically, and keeps the earlier version in History.
- **Editing is off until the person turns it on**, and the engine enforces it, not the interface.
- **Every check cites the documentation** and names the sentence it relies on. If a docs update drops the sentence, fix the check, not the test.
- **What the app knows about an agent comes from that agent's documentation**, not from the copy installed on your Mac.
- **Secrets never reach the interface.** MCP server environment variables and headers are listed by name.
- **Plain, short copy.** Say what the person is looking at and what to do. Buttons name the outcome: Save, Restore this version.

## Pull requests

Keep a pull request to one change, say why in its description, and include a test when you change what the engine reads or writes. For anything large, open an issue first so we can agree on the shape.

By contributing, you agree that your contribution is released under the [MIT License](../LICENSE).
