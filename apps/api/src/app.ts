import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  createCommentSchema,
  createTicketSchema,
  filterTickets,
  getDueDateForPriority,
  getTicketInsights,
  getTicketStats,
  ticketFilterSchema,
  updateTicketSchema,
  updateStatusSchema,
  type Ticket,
  type TicketEvent,
  type TicketFilters
} from "@opsflow/domain";
import type { TicketRepository } from "./repository";

const actorName = "Yuri Barbosa";
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function normalizeFilters(query: Request["query"]): TicketFilters {
  const normalized = Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== "")
  );

  return ticketFilterSchema.parse(normalized);
}

function getTicketId(req: Request): string {
  const { id } = req.params;
  return Array.isArray(id) ? id[0] ?? "" : id ?? "";
}

function createTicketEvent(input: Omit<TicketEvent, "id" | "createdAt" | "actor"> & { actor?: string }): TicketEvent {
  const { actor, ...eventInput } = input;
  return {
    id: `evt-${randomUUID().slice(0, 12)}`,
    actor: actor ?? actorName,
    createdAt: new Date().toISOString(),
    ...eventInput
  };
}

function describeTicketChanges(before: Ticket, after: Ticket): string[] {
  const labels: Partial<Record<keyof Ticket, string>> = {
    title: "Título",
    requester: "Solicitante",
    department: "Área",
    category: "Categoria",
    priority: "Prioridade",
    status: "Status",
    assignee: "Responsável",
    description: "Descrição",
    tags: "Tags",
    dueAt: "Prazo",
    resolution: "Resolução"
  };

  return (Object.entries(labels) as Array<[keyof Ticket, string]>)
    .filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(([, label]) => `${label} alterado`);
}

export function createApp(repository: TicketRepository) {
  const app = express();

  const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]);
  // Reject requests, not just CORS response headers, before any mutation runs.
  app.use((req, res, next) => {
    if (!loopbackHost.test(req.get("host") ?? "")) {
      res.status(403).json({ error: "Host not allowed" });
      return;
    }
    const origin = req.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  });
  app.use(cors({ origin: [...allowedOrigins] }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "opsflow-api" });
  });

  app.get("/api/analytics", asyncRoute(async (_req, res) => {
    const tickets = await repository.findAll();
    res.json({ data: getTicketStats(tickets) });
  }));

  app.get("/api/insights", asyncRoute(async (_req, res) => {
    const tickets = await repository.findAll();
    res.json({ data: getTicketInsights(tickets) });
  }));

  app.get("/api/events", asyncRoute(async (_req, res) => {
    const events = await repository.findEvents();
    res.json({ data: events });
  }));

  app.get("/api/tickets", asyncRoute(async (req, res) => {
    const filters = normalizeFilters(req.query);
    const tickets = await repository.findAll();
    const filtered = filterTickets(tickets, filters)
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

    res.json({
      data: filtered,
      meta: {
        total: filtered.length,
        filters
      }
    });
  }));

  app.get("/api/tickets/:id", asyncRoute(async (req, res) => {
    const ticketId = getTicketId(req);
    const ticket = await repository.findById(ticketId);

    if (!ticket) {
      res.status(404).json({ error: "Tarefa não encontrada" });
      return;
    }

    res.json({ data: ticket });
  }));

  app.get("/api/tickets/:id/events", asyncRoute(async (req, res) => {
    const ticketId = getTicketId(req);
    const ticket = await repository.findById(ticketId);

    if (!ticket) {
      res.status(404).json({ error: "Tarefa não encontrada" });
      return;
    }

    const events = await repository.findEvents(ticketId);
    res.json({ data: events });
  }));

  app.post("/api/tickets", asyncRoute(async (req, res) => {
    const input = createTicketSchema.parse(req.body);
    const now = new Date();

    const ticket: Ticket = {
      id: `tk-${randomUUID()}`,
      ...input,
      status: "triage",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      dueAt: input.dueAt ?? getDueDateForPriority(input.priority, now)
    };

    await repository.changeTicket(ticket.id, () => ({
      ticket,
      event: createTicketEvent({
        ticketId: ticket.id,
        type: "created",
        message: "Tarefa criada",
        changes: [
          `Responsável inicial: ${ticket.assignee}`,
          `Prioridade inicial: ${ticket.priority}`,
          `Prazo inicial: ${ticket.dueAt}`
        ]
      })
    }));
    res.status(201).json({ data: ticket });
  }));

  app.patch("/api/tickets/:id/status", asyncRoute(async (req, res) => {
    const ticketId = getTicketId(req);
    const input = updateStatusSchema.parse(req.body);
    const result = await repository.changeTicket(ticketId, (current) => {
      if (!current) return undefined;
      const ticket: Ticket = {
        ...current,
        status: input.status,
        resolution: input.resolution ?? current.resolution,
        updatedAt: new Date().toISOString()
      };
      return {
        ticket,
        event: createTicketEvent({
          ticketId,
          type: "status_changed",
          message: `Status alterado de ${current.status} para ${ticket.status}`,
          changes: input.resolution ? [`Resolução: ${input.resolution}`] : []
        })
      };
    });
    if (!result) {
      res.status(404).json({ error: "Tarefa não encontrada" });
      return;
    }
    res.json({ data: result.ticket });
  }));

  app.put("/api/tickets/:id", asyncRoute(async (req, res) => {
    const ticketId = getTicketId(req);
    const input = updateTicketSchema.parse(req.body);
    const result = await repository.changeTicket(ticketId, (current) => {
      if (!current) return undefined;
      const ticket: Ticket = {
        ...current,
        ...input,
        tags: input.tags ?? current.tags,
        resolution: input.resolution ?? current.resolution,
        updatedAt: new Date().toISOString()
      };
      const changes = describeTicketChanges(current, ticket);
      return {
        ticket,
        event: changes.length > 0 ? createTicketEvent({
          ticketId,
          type: "updated",
          message: "Campos da tarefa atualizados",
          changes
        }) : undefined
      };
    });
    if (!result) {
      res.status(404).json({ error: "Tarefa não encontrada" });
      return;
    }
    res.json({ data: result.ticket });
  }));

  app.post("/api/tickets/:id/comments", asyncRoute(async (req, res) => {
    const ticketId = getTicketId(req);
    const input = createCommentSchema.parse(req.body);
    const result = await repository.changeTicket(ticketId, (current) => current ? {
      ticket: { ...current, updatedAt: new Date().toISOString() },
      event: createTicketEvent({
        ticketId,
        type: "comment_added",
        actor: input.actor,
        message: input.message,
        changes: []
      })
    } : undefined);
    if (!result) {
      res.status(404).json({ error: "Tarefa não encontrada" });
      return;
    }
    res.status(201).json({ data: result.event });
  }));

  app.delete("/api/tickets/:id", asyncRoute(async (req, res) => {
    const ticketId = getTicketId(req);
    const result = await repository.changeTicket(ticketId, (ticket) => ticket ? {
      ticket: null,
      event: createTicketEvent({
        ticketId,
        type: "deleted",
        message: `Tarefa excluída: ${ticket.title}`,
        changes: [`Último responsável: ${ticket.assignee}`]
      })
    } : undefined);
    if (!result) {
      res.status(404).json({ error: "Tarefa não encontrada" });
      return;
    }
    res.status(204).send();
  }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error && typeof error === "object" && "issues" in error) {
      res.status(400).json({ error: "Validation failed", details: error });
      return;
    }

    if (error && typeof error === "object" && "status" in error
      && (error.status === 400 || error.status === 413 || error.status === 415)) {
      res.status(error.status).json({ error: "Invalid request body or parameters" });
      return;
    }

    res.status(500).json({ error: "Unexpected server error" });
  });

  return app;
}
