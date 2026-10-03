/**
 * Where AgentCP lives on the web, in one place: the About page, the Help menu
 * and the updater read these. The repo is the public one releases are built
 * from; the private working repo is never linked.
 */
export const REPO = "https://github.com/n0ah37/agentcp";
export const SITE = "https://agentcp.noahgeneralgroup.com";
export const LINKS = {
  site: SITE,
  repo: REPO,
  issues: `${REPO}/issues/new/choose`,
  releases: `${REPO}/releases`,
  license: `${REPO}/blob/main/LICENSE`,
  security: `${REPO}/security/policy`,
};
export const COPYRIGHT = "© 2026 Noah General Group Inc.";
