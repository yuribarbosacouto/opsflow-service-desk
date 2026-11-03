import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ticketEventSchema, ticketSchema, type Ticket, type TicketEvent } from "@opsflow/domain";

const ticketArraySchema = ticketSchema.array();
const ticketEventArraySchema = ticketEventSchema.array();

export type TicketRepository = {
  findAll: () => Promise<Ticket[]>;
  findById: (id: string) => Promise<Ticket | undefined>;
  findEvents: (ticketId?: string) => Promise<TicketEvent[]>;
  changeTicket: (id: string, change: ChangeTicket) => Promise<TicketChange | undefined>;
};

type TicketChange = { ticket: Ticket | null; event?: TicketEvent };
type ChangeTicket = (current: Ticket | undefined) => TicketChange | undefined;

type TicketRow = Omit<Ticket, "tags" | "resolution"> & {
  tags: string;
  resolution: string | null;
};

type TicketEventRow = Omit<TicketEvent, "changes"> & {
  changes: string;
};

function parseTicketRow(row: TicketRow): Ticket {
  return ticketSchema.parse({ ...row, tags: JSON.parse(row.tags), resolution: row.resolution ?? undefined });
}

function createSeedEvents(tickets: Ticket[]): TicketEvent[] {
  return tickets.flatMap((ticket) => {
    const events: TicketEvent[] = [
      {
        id: `evt-${ticket.id}-created`,
        ticketId: ticket.id,
        type: "created",
        actor: "Sistema demo",
        message: "Tarefa criada a partir da base demonstrativa",
        changes: [
          `Status inicial: ${ticket.status}`,
          `Responsável inicial: ${ticket.assignee}`
        ],
        createdAt: ticket.createdAt
      }
    ];

    if (ticket.updatedAt !== ticket.createdAt) {
      events.push({
        id: `evt-${ticket.id}-updated`,
        ticketId: ticket.id,
        type: ticket.status === "resolved" ? "status_changed" : "updated",
        actor: "Sistema demo",
        message: ticket.status === "resolved" ? "Tarefa concluída na base demonstrativa" : "Tarefa atualizada na base demonstrativa",
        changes: ticket.resolution ? [ticket.resolution] : ["Dados operacionais revisados"],
        createdAt: ticket.updatedAt
      });
    }

    return events;
  });
}

export class SqliteTicketRepository implements TicketRepository {
  private readonly db: DatabaseSync;

  constructor(
    private readonly dbPath = path.resolve("data/opsflow.sqlite"),
    private readonly seedPath = path.resolve("data/tickets.seed.json")
  ) {
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.createSchema();
    this.seedIfEmpty();
  }

  close(): void {
    this.db.close();
  }

  async findAll(): Promise<Ticket[]> {
    const rows = this.db.prepare(`
      SELECT id, title, requester, department, category, priority, status, assignee,
             description, tags, createdAt, updatedAt, dueAt, resolution
      FROM tickets
      ORDER BY datetime(dueAt) ASC
    `).all() as TicketRow[];

    return rows.map(parseTicketRow);
  }

  async findById(id: string): Promise<Ticket | undefined> {
    return this.readTicket(id);
  }

  private readTicket(id: string): Ticket | undefined {
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined;
    return row && parseTicketRow(row);
  }

  async findEvents(ticketId?: string): Promise<TicketEvent[]> {
    const rows = ticketId
      ? this.db.prepare(`
          SELECT id, ticketId, type, actor, message, changes, createdAt
          FROM ticket_events
          WHERE ticketId = ?
          ORDER BY createdAt DESC, rowid DESC
        `).all(ticketId) as TicketEventRow[]
      : this.db.prepare(`
          SELECT id, ticketId, type, actor, message, changes, createdAt
          FROM ticket_events
          ORDER BY createdAt DESC, rowid DESC
        `).all() as TicketEventRow[];

    return ticketEventArraySchema.parse(rows.map((row) => ({
      ...row,
      changes: JSON.parse(row.changes) as string[]
    })));
  }

  async changeTicket(id: string, change: ChangeTicket): Promise<TicketChange | undefined> {
    return this.transaction(() => {
      const result = change(this.readTicket(id));
      if (!result) return undefined;
      if (result.ticket) {
        this.writeTicket(result.ticket);
      } else {
        this.db.prepare("DELETE FROM tickets WHERE id = ?").run(id);
      }
      if (result.event) this.appendEvent(result.event);
      return result;
    });
  }

  private writeTicket(value: Ticket): void {
    const ticket = ticketSchema.parse(value);
    this.db.prepare(`
      INSERT INTO tickets (
        id, title, requester, department, category, priority, status, assignee,
        description, tags, createdAt, updatedAt, dueAt, resolution
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, requester = excluded.requester, department = excluded.department,
        category = excluded.category, priority = excluded.priority, status = excluded.status,
        assignee = excluded.assignee, description = excluded.description, tags = excluded.tags,
        updatedAt = excluded.updatedAt, dueAt = excluded.dueAt, resolution = excluded.resolution
    `).run(
      ticket.id, ticket.title, ticket.requester, ticket.department, ticket.category, ticket.priority,
      ticket.status, ticket.assignee, ticket.description, JSON.stringify(ticket.tags), ticket.createdAt,
      ticket.updatedAt, ticket.dueAt, ticket.resolution ?? null
    );
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendEvent(event: TicketEvent): void {
    const parsedEvent = ticketEventSchema.parse(event);
    this.db.prepare(`
      INSERT INTO ticket_events (id, ticketId, type, actor, message, changes, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsedEvent.id,
      parsedEvent.ticketId,
      parsedEvent.type,
      parsedEvent.actor,
      parsedEvent.message,
      JSON.stringify(parsedEvent.changes),
      parsedEvent.createdAt
    );
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        requester TEXT NOT NULL,
        department TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        assignee TEXT NOT NULL,
        description TEXT NOT NULL,
        tags TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        dueAt TEXT NOT NULL,
        resolution TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
      CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category);
      CREATE INDEX IF NOT EXISTS idx_tickets_dueAt ON tickets(dueAt);

      CREATE TABLE IF NOT EXISTS ticket_events (
        id TEXT PRIMARY KEY,
        ticketId TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        message TEXT NOT NULL,
        changes TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ticket_events_ticketId ON ticket_events(ticketId);
      CREATE INDEX IF NOT EXISTS idx_ticket_events_createdAt ON ticket_events(createdAt);
    `);
  }

  private seedIfEmpty(): void {
    this.transaction(() => {
      // Historical events remain after all tickets are deliberately deleted.
      if (this.db.prepare("SELECT 1 FROM ticket_events LIMIT 1").get()) return;
      const rows = this.db.prepare("SELECT * FROM tickets").all() as TicketRow[];
      const tickets = rows.length > 0
        ? rows.map(parseTicketRow)
        : ticketArraySchema.parse(JSON.parse(readFileSync(this.seedPath, "utf-8")));
      if (rows.length === 0) {
        for (const ticket of tickets) this.writeTicket(ticket);
      }
      for (const event of createSeedEvents(tickets)) this.appendEvent(event);
    });
  }
}

export function createMemoryRepository(initialTickets: Ticket[]): TicketRepository {
  let tickets = ticketArraySchema.parse(initialTickets);
  let events = ticketEventArraySchema.parse(createSeedEvents(tickets));

  return {
    async findAll() {
      return structuredClone(tickets);
    },
    async findById(id) {
      return structuredClone(tickets.find((ticket) => ticket.id === id));
    },
    async findEvents(ticketId) {
      return structuredClone(
        events
          .filter((event) => !ticketId || event.ticketId === ticketId)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      );
    },
    async changeTicket(id, change) {
      const current = tickets.find((ticket) => ticket.id === id);
      const result = change(structuredClone(current));
      if (!result) return undefined;
      const ticket = result.ticket && ticketSchema.parse(result.ticket);
      const event = result.event && ticketEventSchema.parse(result.event);
      if (event && events.some(({ id }) => id === event.id)) {
        throw new Error("Ticket event already exists");
      }
      tickets = tickets.filter((item) => item.id !== id);
      if (ticket) tickets.unshift(ticket);
      if (event) events.unshift(event);
      return { ticket, event };
    }
  };
}
