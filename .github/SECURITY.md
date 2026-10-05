# Security

AgentCP reads every instruction, memory and settings file Claude Code and Codex use on your Mac, and with editing on it writes them. If you find a way to make it read or write something it shouldn't, please tell us privately first.

## Report a vulnerability

Use [Report a vulnerability](https://github.com/n0ah37/agentcp/security/advisories/new) on this repository's Security tab. Include what you did, what happened, and the AgentCP version from About AgentCP. We reply as soon as we can, usually within a week.

Please don't open a public issue for a security problem.

## What counts

- A write that skips the review step, the History snapshot, or the editing switch.
- A file outside the agents' folders and your projects that AgentCP reads or writes.
- Another app or web page reaching AgentCP's local server, which listens on 127.0.0.1 and needs a token that changes every launch.
- A secret from an MCP server's settings (an environment variable, a header, a token) shown in the app.
- An update that installs something not signed by Noah General Group Inc.

## Supported versions

Only the latest release gets fixes. AgentCP updates itself from GitHub Releases unless you turn that off.
