import { Router } from "express";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import path from "path";

const router = Router();

const WORKSPACE_ROOT = process.cwd();
const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".tsbuildinfo",
  "pnpm-lock.yaml",
]);

function buildFileTree(dirPath: string, rootPath: string, depth = 0): object[] {
  if (depth > 5) return [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const result: object[] = [];

  for (const entry of entries) {
    if (IGNORED.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".env.example"))
      continue;
    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: relPath,
        type: "directory",
        size: null,
        children: buildFileTree(fullPath, rootPath, depth + 1),
      });
    } else {
      const stat = statSync(fullPath);
      result.push({
        name: entry.name,
        path: relPath,
        type: "file",
        size: stat.size,
        children: null,
      });
    }
  }

  return result.sort((a: any, b: any) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function detectLanguage(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".py": "python",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".sh": "bash",
    ".css": "css",
    ".html": "html",
    ".sql": "sql",
    ".toml": "toml",
    ".env": "dotenv",
    ".txt": "text",
  };
  return map[ext] ?? null;
}

router.get("/files", (req, res) => {
  try {
    const relPath = (req.query.path as string) ?? "";
    const dirPath = relPath ? path.join(WORKSPACE_ROOT, relPath) : WORKSPACE_ROOT;

    if (!existsSync(dirPath)) return res.status(404).json({ error: "Path not found" });

    const tree = buildFileTree(dirPath, WORKSPACE_ROOT);
    return res.json(tree);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/files/content", (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path query parameter required" });

    const fullPath = path.join(WORKSPACE_ROOT, filePath);
    if (!existsSync(fullPath)) return res.status(404).json({ error: "File not found" });

    const stat = statSync(fullPath);
    if (stat.isDirectory()) return res.status(400).json({ error: "Path is a directory" });
    if (stat.size > 500_000) return res.status(400).json({ error: "File too large (>500KB)" });

    const content = readFileSync(fullPath, "utf-8");
    return res.json({
      path: filePath,
      content,
      language: detectLanguage(filePath),
      size: stat.size,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
