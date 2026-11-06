import type {
  CreateCommentInput,
  CreateTicketInput,
  Ticket,
  TicketEvent,
  TicketFilters,
  TicketInsight,
  TicketStats,
  TicketStatus,
  UpdateTicketInput
} from "@opsflow/domain";
import { filterTickets, getTicketInsights, getTicketStats } from "@opsflow/domain";
import { demoTickets } from "../data/demoTickets";

type ApiResponse<T> = {
  data: T;
};

const apiBase = import.meta.env.VITE_API_URL ?? "";
const isBrowser = typeof window !== "undefined";
const isLocalHost = isBrowser && ["localhost", "127.0.0.1"].includes(window.location.hostname);
const useStaticDemo = isBrowser && !apiBase && !isLocalHost;
const demoStorageKey = "opsflow-demo-v1";

type StoredDemo = { tickets: Ticket[]; events: TicketEvent[] };

function readStoredDemo(): StoredDemo | undefined {
  if (!useStaticDemo) return undefined;
  try {
    const raw = window.localStorage.getItem(demoStorageKey);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== "object" ||
      !("tickets" in parsed) || !Array.isArray(parsed.tickets) ||
      !("events" in parsed) || !Array.isArray(parsed.events)
    ) return undefined;
    return parsed as StoredDemo;
  } catch {
    return undefined;
  }
}

const savedDemo = readStoredDemo();
let demoState = savedDemo?.tickets ?? structuredClone(demoTickets);
let demoEvents = savedDemo?.events ?? createDemoEvents(demoState);

function persistDemo(): void {
  if (!useStaticDemo) return;
  try {
    window.localStorage.setItem(demoStorageKey, JSON.stringify({ tickets: demoState, events: demoEvents }));
  } catch {
    // Storage can be disabled or full: keep the demonstration usable in memory.
  }
}

export function isOnlineDemo(): boolean {
  return useStaticDemo;
}

export function resetOnlineDemo(): void {
  if (!useStaticDemo) return;
  demoState = structuredClone(demoTickets);
  demoEvents = createDemoEvents(demoState);
  try {
    window.localStorage.removeItem(demoStorageKey);
  } catch {
    // Reset still applies to the in-memory session.
  }
}

function sortByDueDate(tickets: Ticket[]): Ticket[] {
  return tickets
    .slice()
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}

function createDemoEvents(tickets: Ticket[]): TicketEvent[] {
  return tickets.flatMap((ticket) => {
    const events: TicketEvent[] = [
      {
        id: `evt-${ticket.id}-created`,
        ticketId: ticket.id,
        type: "created",
        actor: "Sistema demo",
        message: "Tarefa criada a partir da base demonstrativa",
        changes: [`Responsável inicial: ${ticket.assignee}`, `Status inicial: ${ticket.status}`],
        createdAt: ticket.createdAt
      }
    ];

    if (ticket.updatedAt !== ticket.createdAt) {
      events.push({
        id: `evt-${ticket.id}-updated`,
        ticketId: ticket.id,
        type: ticket.status === "resolved" ? "status_changed" : "updated",
        actor: "Sistema demo",
        message: ticket.status === "resolved" ? "Tarefa concluída na base demonstrativa" : "Dados revisados na base demonstrativa",
        changes: ticket.resolution ? [ticket.resolution] : ["Campos operacionais revisados"],
        createdAt: ticket.updatedAt
      });
    }

    return events;
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function appendDemoEvent(event: Omit<TicketEvent, "id" | "createdAt" | "actor"> & { actor?: string }): TicketEvent {
  const { actor, ...eventInput } = event;
  const nextEvent: TicketEvent = {
    id: `evt-demo-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    actor: actor ?? "Yuri Barbosa",
    createdAt: new Date().toISOString(),
    ...eventInput
  };
  demoEvents = [nextEvent, ...demoEvents];
  persistDemo();
  return nextEvent;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function fetchTickets(filters: TicketFilters): Promise<Ticket[]> {
  if (useStaticDemo) {
    return sortByDueDate(filterTickets(demoState, filters));
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      params.set(key, value);
    }
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await requestJson<ApiResponse<Ticket[]>>(`/api/tickets${suffix}`);
  return response.data;
}

export async function fetchStats(): Promise<TicketStats> {
  if (useStaticDemo) {
    return getTicketStats(demoState);
  }

  const response = await requestJson<ApiResponse<TicketStats>>("/api/analytics");
  return response.data;
}

export async function fetchInsights(): Promise<TicketInsight[]> {
  if (useStaticDemo) {
    return getTicketInsights(demoState);
  }

  const response = await requestJson<ApiResponse<TicketInsight[]>>("/api/insights");
  return response.data;
}

export async function fetchTicketEvents(ticketId: string): Promise<TicketEvent[]> {
  if (useStaticDemo) {
    return demoEvents.filter((event) => event.ticketId === ticketId);
  }

  const response = await requestJson<ApiResponse<TicketEvent[]>>(`/api/tickets/${ticketId}/events`);
  return response.data;
}

export async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  if (useStaticDemo) {
    const now = new Date().toISOString();
    const ticket: Ticket = {
      id: `demo-${Date.now()}`,
      ...input,
      status: "triage",
      assignee: input.assignee ?? "Yuri Barbosa",
      createdAt: now,
      updatedAt: now,
      dueAt: input.dueAt ?? now
    };
    demoState = [ticket, ...demoState];
    appendDemoEvent({
      ticketId: ticket.id,
      type: "created",
      message: "Tarefa criada",
      changes: [`Responsável inicial: ${ticket.assignee}`, `Prioridade inicial: ${ticket.priority}`]
    });
    return ticket;
  }

  const response = await requestJson<ApiResponse<Ticket>>("/api/tickets", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return response.data;
}

export async function updateTicket(id: string, input: UpdateTicketInput): Promise<Ticket> {
  if (useStaticDemo) {
    const current = demoState.find((ticket) => ticket.id === id);
    if (!current) {
      throw new Error("Task not found");
    }

    const updated: Ticket = {
      ...current,
      ...input,
      tags: input.tags ?? current.tags,
      updatedAt: new Date().toISOString()
    };
    demoState = demoState.map((ticket) => ticket.id === id ? updated : ticket);
    const changedKeys = Object.keys(input);
    if (!(changedKeys.length === 1 && changedKeys[0] === "status")) {
      appendDemoEvent({
        ticketId: id,
        type: "updated",
        message: "Campos da tarefa atualizados",
        changes: changedKeys.map((key) => `${key} alterado`)
      });
    }
    persistDemo();
    return updated;
  }

  const response = await requestJson<ApiResponse<Ticket>>(`/api/tickets/${id}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
  return response.data;
}

export async function updateTicketStatus(id: string, status: TicketStatus): Promise<Ticket> {
  if (useStaticDemo) {
    const current = demoState.find((ticket) => ticket.id === id);
    const updated = await updateTicket(id, { status });
    appendDemoEvent({
      ticketId: id,
      type: "status_changed",
      message: current ? `Status alterado de ${current.status} para ${status}` : `Status alterado para ${status}`,
      changes: []
    });
    return updated;
  }

  const response = await requestJson<ApiResponse<Ticket>>(`/api/tickets/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  return response.data;
}

export async function addTicketComment(id: string, input: CreateCommentInput): Promise<TicketEvent> {
  if (useStaticDemo) {
    if (!demoState.some((ticket) => ticket.id === id)) throw new Error("Task not found");
    demoState = demoState.map((ticket) => ticket.id === id ? { ...ticket, updatedAt: new Date().toISOString() } : ticket);
    return appendDemoEvent({
      ticketId: id,
      type: "comment_added",
      actor: input.actor,
      message: input.message,
      changes: []
    });
  }

  const response = await requestJson<ApiResponse<TicketEvent>>(`/api/tickets/${id}/comments`, {
    method: "POST",
    body: JSON.stringify(input)
  });
  return response.data;
}

export async function deleteTicket(id: string): Promise<void> {
  if (useStaticDemo) {
    const current = demoState.find((ticket) => ticket.id === id);
    demoState = demoState.filter((ticket) => ticket.id !== id);
    appendDemoEvent({
      ticketId: id,
      type: "deleted",
      message: current ? `Tarefa excluída: ${current.title}` : "Tarefa excluída",
      changes: []
    });
    return;
  }

  await requestJson<void>(`/api/tickets/${id}`, {
    method: "DELETE"
  });
}
