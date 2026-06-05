import { Router } from "express";
import { githubRequest } from "../github-client.js";

const router = Router();

interface GithubApiRepo {
  full_name: string;
  private: boolean;
  html_url: string;
}

interface GithubSearchResult {
  items: GithubApiRepo[];
}

router.get("/github/repos", async (req, res) => {
  const q = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";

  try {
    let repos: GithubApiRepo[];

    if (!q) {
      repos = await githubRequest<GithubApiRepo[]>(
        "GET",
        "/user/repos?sort=updated&per_page=30&affiliation=owner",
      );
    } else {
      const user = await githubRequest<{ login: string }>("GET", "/user");
      const result = await githubRequest<GithubSearchResult>(
        "GET",
        `/search/repositories?q=user:${encodeURIComponent(user.login)}+${encodeURIComponent(q)}&per_page=30`,
      );
      repos = result.items;
    }

    return res.json({
      repos: repos.map((r) => ({
        fullName: r.full_name,
        private: r.private,
        htmlUrl: r.html_url,
      })),
    });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (msg.includes("connector unavailable") || msg.includes("GITHUB_TOKEN")) {
      return res.status(503).json({ error: "GitHub not connected" });
    }
    req.log.warn({ err: msg }, "GitHub repos fetch failed");
    return res.status(503).json({ error: msg.slice(0, 200) });
  }
});

export default router;
