import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createMemoryRepository, SqliteTicketRepository } from "../src/repository";
import type { Ticket } from "@opsflow/domain";

const tickets: Ticket[] = [
  {
    id: "tk-test-1",
    title: "Automatizar painel de contratos",
    requester: "Marina Alves",
    department: "Administrativo",
    category: "automation",
    priority: "high",
    status: "in_progress",
    assignee: "Yuri Barbosa",
    description: "Criar acompanhamento de contratos com responsáveis e prazos.",
    tags: ["excel", "power-apps"],
    createdAt: "2026-05-25T12:00:00.000Z",
    updatedAt: "2026-05-25T12:00:00.000Z",
    dueAt: "2026-05-28T12:00:00.000Z"
  }
];

describe("OpsFlow API", () => {
  it("rejects external origins before reading or changing tickets", async () => {
    const repository = createMemoryRepository(tickets);
    const app = createApp(repository);
    await request(app).get("/api/tickets").set("Origin", "https://untrusted.example").expect(403);
    await request(app).delete("/api/tickets/tk-test-1").set("Origin", "https://untrusted.example").expect(403);
    await request(app).delete("/api/tickets/tk-test-1").set("Origin", "null").expect(403);
    await request(app).delete("/api/tickets/tk-test-1").set("Host", "untrusted.example").expect(403);
    expect(await repository.findAll()).toHaveLength(1);
  });

  it("allows the local frontend and its preflight", async () => {
    const app = createApp(createMemoryRepository(tickets));
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
      const response = await request(app).get("/api/tickets").set("Origin", origin).expect(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      await request(app).options("/api/tickets").set("Origin", origin)
        .set("Access-Control-Request-Method", "POST").expect(204);
    }
  });

  it("returns health status", async () => {
    const app = createApp(createMemoryRepository(tickets));

    const response = await request(app).get("/health").expect(200);

    expect(response.body).toEqual({ ok: true, service: "opsflow-api" });
  });

  it("filters ticket queue", async () => {
    const app = createApp(createMemoryRepository(tickets));

    const response = await request(app).get("/api/tickets?q=contratos&assignee=Yuri&month=2026-05").expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].title).toContain("contratos");
  });

  it("rejects malformed JSON and ambiguous filters as client errors", async () => {
    const app = createApp(createMemoryRepository(tickets));
    await request(app).post("/api/tickets").type("json").send("{").expect(400).expect("Content-Type", /json/);
    await request(app).get("/api/tickets?status=triage&status=waiting").expect(400);
  });

  it("returns dashboard insights", async () => {
    const app = createApp(createMemoryRepository(tickets));

    const response = await request(app).get("/api/insights").expect(200);

    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.data[0]).toHaveProperty("title");
  });

  it("validates and creates a new ticket", async () => {
    const app = createApp(createMemoryRepository(tickets));

    const response = await request(app)
      .post("/api/tickets")
      .send({
        title: "Padronizar cadastro de lotes",
        requester: "Aline Ribeiro",
        department: "Operações",
        category: "data",
        priority: "medium",
        assignee: "Yuri Barbosa",
        description: "Criar padrão de cadastro para reduzir erros de digitação.",
        tags: ["dados"]
      })
      .expect(201);

    expect(response.body.data.id).toMatch(/^tk-/);
    expect(response.body.data.status).toBe("triage");
  });

  it("edits a task", async () => {
    const app = createApp(createMemoryRepository(tickets));

    const response = await request(app)
      .put("/api/tickets/tk-test-1")
      .send({
        title: "Automatizar painel administrativo",
        status: "waiting",
        assignee: "Carlos Lima"
      })
      .expect(200);

    expect(response.body.data.title).toBe("Automatizar painel administrativo");
    expect(response.body.data.status).toBe("waiting");
    expect(response.body.data.assignee).toBe("Carlos Lima");
    expect(response.body.data.tags).toEqual(tickets[0]?.tags);
    await request(app).put("/api/tickets/tk-test-1").send({}).expect(400);

    const events = await request(app).get("/api/tickets/tk-test-1/events").expect(200);
    expect(events.body.data.some((event: { type: string }) => event.type === "updated")).toBe(true);
  });

  it("updates ticket status", async () => {
    const app = createApp(createMemoryRepository(tickets));

    const response = await request(app)
      .patch("/api/tickets/tk-test-1/status")
      .send({ status: "resolved", resolution: "Fluxo validado com a equipe." })
      .expect(200);

    expect(response.body.data.status).toBe("resolved");
    expect(response.body.data.resolution).toContain("Fluxo");

    const events = await request(app).get("/api/tickets/tk-test-1/events").expect(200);
    expect(events.body.data[0].type).toBe("status_changed");
  });

  it("adds internal comments to the audit timeline", async () => {
    const app = createApp(createMemoryRepository(tickets));

    const response = await request(app)
      .post("/api/tickets/tk-test-1/comments")
      .send({ message: "Validar dependência com o financeiro antes do fechamento." })
      .expect(201);

    expect(response.body.data.type).toBe("comment_added");
    expect(response.body.data.actor).toBe("Yuri Barbosa");

    const events = await request(app).get("/api/tickets/tk-test-1/events").expect(200);
    expect(events.body.data[0].message).toContain("financeiro");
  });

  it("deletes a task with confirmation support", async () => {
    const app = createApp(createMemoryRepository(tickets));

    await request(app).delete("/api/tickets/tk-test-1").expect(204);

    const response = await request(app).get("/api/tickets").expect(200);
    expect(response.body.data).toHaveLength(0);

    const events = await request(app).get("/api/events").expect(200);
    expect(events.body.data[0].type).toBe("deleted");
  });
});

describe("OpsFlow SQLite persistence", () => {
  it("preserves concurrent edits and history after deleting the last ticket and restarting", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "opsflow-sqlite-"));
    const dbPath = path.join(directory, "tickets.sqlite");
    const seedPath = path.join(directory, "seed.json");
    writeFileSync(seedPath, JSON.stringify(tickets));
    let repository = new SqliteTicketRepository(dbPath, seedPath);
    try {
      const app = createApp(repository);
      await Promise.all([
        request(app).put("/api/tickets/tk-test-1").send({ title: "Revisar painel de contratos" }).expect(200),
        request(app).patch("/api/tickets/tk-test-1/status").send({ status: "waiting" }).expect(200)
      ]);
      const { body } = await request(app).get("/api/tickets/tk-test-1").expect(200);
      expect(body.data).toMatchObject({ title: "Revisar painel de contratos", status: "waiting" });
      expect((await repository.findEvents("tk-test-1")).map(({ type }) => type))
        .toEqual(expect.arrayContaining(["updated", "status_changed"]));

      await request(app).delete("/api/tickets/tk-test-1").expect(204);
      repository.close();
      repository = new SqliteTicketRepository(dbPath, seedPath);
      expect(await repository.findAll()).toEqual([]);
      expect((await repository.findEvents()).some(({ type }) => type === "deleted")).toBe(true);
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a ticket write if its audit event cannot be recorded", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "opsflow-sqlite-"));
    const seedPath = path.join(directory, "seed.json");
    writeFileSync(seedPath, JSON.stringify(tickets));
    const repository = new SqliteTicketRepository(path.join(directory, "tickets.sqlite"), seedPath);
    try {
      const [existingEvent] = await repository.findEvents("tk-test-1");
      expect(existingEvent).toBeDefined();
      await expect(repository.changeTicket("tk-test-1", (current) => current && {
        ticket: { ...current, status: "waiting" },
        event: existingEvent
      })).rejects.toThrow();
      expect(await repository.findById("tk-test-1")).toMatchObject({ status: "in_progress" });
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
