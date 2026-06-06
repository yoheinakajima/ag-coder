import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "markup",
  html: "markup",
  css: "css",
  scss: "scss",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  php: "php",
  swift: "swift",
  lua: "lua",
};

export function languageForPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? "text";
}

const customStyle: React.CSSProperties = {
  margin: 0,
  padding: "12px",
  background: "transparent",
  fontSize: "11px",
  lineHeight: 1.6,
};

export function CodeBlock({ code, path }: { code: string; path: string }) {
  const language = languageForPath(path);
  return (
    <SyntaxHighlighter
      language={language}
      style={oneDark}
      customStyle={customStyle}
      codeTagProps={{ style: { fontFamily: "var(--font-mono, monospace)", fontSize: "11px" } }}
      showLineNumbers
      lineNumberStyle={{
        color: "#475569",
        minWidth: "2.5em",
        paddingRight: "1em",
        userSelect: "none",
      }}
      wrapLongLines={false}
    >
      {code}
    </SyntaxHighlighter>
  );
}
