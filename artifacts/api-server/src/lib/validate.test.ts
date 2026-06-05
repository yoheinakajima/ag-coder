import { describe, it, expect } from "vitest";
import { CreateRunBody } from "@workspace/api-zod";
import { isValidRepoUrl } from "./validate";

describe("isValidRepoUrl", () => {
  it("accepts https github.com owner/repo URLs", () => {
    expect(isValidRepoUrl("https://github.com/yoheinakajima/ag-coder")).toBe(true);
    expect(isValidRepoUrl("https://github.com/yoheinakajima/ag-coder.git")).toBe(true);
    expect(isValidRepoUrl("https://github.com/owner/repo/")).toBe(true);
  });

  it("rejects non-https, non-github, and malformed URLs", () => {
    expect(isValidRepoUrl("http://github.com/owner/repo")).toBe(false);
    expect(isValidRepoUrl("https://gitlab.com/owner/repo")).toBe(false);
    expect(isValidRepoUrl("https://github.com/onlyowner")).toBe(false);
    expect(isValidRepoUrl("file:///etc/passwd")).toBe(false);
    expect(isValidRepoUrl("not a url")).toBe(false);
    expect(isValidRepoUrl("")).toBe(false);
  });
});

describe("CreateRunBody", () => {
  it("requires a non-empty goal", () => {
    expect(CreateRunBody.safeParse({}).success).toBe(false);
    expect(CreateRunBody.safeParse({ goal: "" }).success).toBe(false);
  });

  it("accepts a valid goal", () => {
    expect(CreateRunBody.safeParse({ goal: "write a prime checker" }).success).toBe(true);
  });
});
