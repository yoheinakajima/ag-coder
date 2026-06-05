import { describe, it, expect, vi } from "vitest";

// Mock the database layer so these route-level smoke tests run hermetically
// (no live Postgres needed in CI). Every query chain resolves to an empty array,
// which is enough to exercise endpoint wiring, status codes, and response shapes.
vi.mock("@workspace/db", () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = [
      "select",
      "from",
      "where",
      "orderBy",
      "limit",
      "groupBy",
      "leftJoin",
      "innerJoin",
      "insert",
      "values",
      "update",
      "set",
      "delete",
      "returning",
    ];
    for (const m of methods) chain[m] = () => chain;
    // Make the chain awaitable: resolves to [] for any terminal query.
    chain.then = (resolve: (rows: unknown[]) => void) => resolve([]);
    return chain;
  };
  return {
    db: makeChain(),
    runsTable: {},
    agentEventsTable: {},
    graphObjectsTable: {},
    graphRelationsTable: {},
  };
});

const request = (await import("supertest")).default;
const app = (await import("./app")).default;

describe("API smoke tests", () => {
  it("GET /api/runs/stats returns aggregate counts", async () => {
    const res = await request(app).get("/api/runs/stats");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalRuns: expect.any(Number),
      completedRuns: expect.any(Number),
      failedRuns: expect.any(Number),
      activeRuns: expect.any(Number),
      totalEvents: expect.any(Number),
    });
  });

  it("GET /api/runs returns a list", async () => {
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /api/runs with an invalid body returns 400", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({})
      .set("Content-Type", "application/json");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/runs with an invalid repoUrl returns 400", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ goal: "do a thing", repoUrl: "https://gitlab.com/owner/repo" })
      .set("Content-Type", "application/json");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});
