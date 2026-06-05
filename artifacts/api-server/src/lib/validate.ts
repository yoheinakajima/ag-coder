/**
 * Validates a repository URL supplied by a client before the agent is allowed to
 * clone it. We intentionally only accept https github.com owner/repo URLs:
 *
 *  - the agent embeds GitHub OAuth tokens into clone URLs, so it must never be
 *    pointed at an arbitrary host
 *  - rejecting non-https / non-github URLs is a cheap defense against SSRF and
 *    credential-leak vectors
 */
export function isValidRepoUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return false;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return false;

  const [owner, repoRaw] = segments;
  const repo = repoRaw.replace(/\.git$/, "");
  const namePattern = /^[A-Za-z0-9._-]+$/;

  return (
    owner.length > 0 &&
    repo.length > 0 &&
    namePattern.test(owner) &&
    namePattern.test(repo)
  );
}
