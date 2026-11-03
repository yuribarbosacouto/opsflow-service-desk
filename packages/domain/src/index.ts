import { z } from "zod";

export const ticketStatuses = ["backlog", "triage", "in_progress", "waiting", "resolved"] as const;
export const ticketPriorities = ["low", "medium", "high", "urgent"] as const;
export const ticketCategories = ["access", "documentation", "automation", "data", "incident"] as const;
export const dueStates = ["overdue", "today", "week"] as const;
export const ticketEventTypes = ["created", "updated", "status_changed", "comment_added", "deleted"] as const;

export const ticketSchema = z.object({
  id: z.string().min(6),
  title: z.string().min(4),
  requester: z.string().min(2),
  department: z.string().min(2),
  category: z.enum(ticketCategories),
  priority: z.enum(ticketPriorities),
  status: z.enum(ticketStatuses),
  assignee: z.string().min(2),
  description: z.string().min(12),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  dueAt: z.string().datetime(),
  resolution: z.string().optional()
});

export const createTicketSchema = ticketSchema
  .pick({
    title: true,
    requester: true,
    department: true,
    category: true,
    priority: true,
    dueAt: true,
    description: true,
    tags: true
  })
  .extend({
    assignee: z.string().min(2).default("Yuri Barbosa"),
    dueAt: z.string().datetime().optional()
  });

export const updateTicketSchema = ticketSchema
  .pick({
    title: true,
    requester: true,
    department: true,
    category: true,
    priority: true,
    status: true,
    assignee: true,
    description: true,
    tags: true,
    dueAt: true,
    resolution: true
  })
  .partial()
  .extend({ tags: z.array(z.string()).optional() })
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one field must be provided"
  });

export const updateStatusSchema = z.object({
  status: z.enum(ticketStatuses),
  resolution: z.string().min(8).optional()
});

export const ticketFilterSchema = z.object({
  q: z.string().optional(),
  status: z.enum(ticketStatuses).optional(),
  priority: z.enum(ticketPriorities).optional(),
  category: z.enum(ticketCategories).optional(),
  assignee: z.string().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  due: z.enum(dueStates).optional()
});

export const ticketEventSchema = z.object({
  id: z.string().min(6),
  ticketId: z.string().min(6),
  type: z.enum(ticketEventTypes),
  actor: z.string().min(2),
  message: z.string().min(4),
  changes: z.array(z.string()).default([]),
  createdAt: z.string().datetime()
});

export const createCommentSchema = z.object({
  actor: z.string().min(2).default("Yuri Barbosa"),
  message: z.string().min(4).max(500)
});

export type Ticket = z.infer<typeof ticketSchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type TicketEvent = z.infer<typeof ticketEventSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type TicketFilters = z.infer<typeof ticketFilterSchema>;
export type TicketStatus = (typeof ticketStatuses)[number];
export type TicketPriority = (typeof ticketPriorities)[number];
export type TicketCategory = (typeof ticketCategories)[number];
export type DueState = (typeof dueStates)[number];
export type TicketEventType = (typeof ticketEventTypes)[number];

export const ticketCategoryNames: Record<TicketCategory, string> = {
  access: "Acessos",
  documentation: "Documentos",
  automation: "Automação",
  data: "Dados",
  incident: "Incidentes"
};

export const ticketEventTypeNames: Record<TicketEventType, string> = {
  created: "Criação",
  updated: "Atualização",
  status_changed: "Mudança de status",
  comment_added: "Comentário",
  deleted: "Exclusão"
};

export type SlaState = "healthy" | "at_risk" | "breached" | "done";

export type TicketStats = {
  total: number;
  open: number;
  resolved: number;
  urgent: number;
  atRisk: number;
  breached: number;
  completionRate: number;
  overdueRate: number;
  byStatus: Record<TicketStatus, number>;
  byPriority: Record<TicketPriority, number>;
  byCategory: Record<TicketCategory, number>;
  byAssignee: Record<string, number>;
};

export type TicketInsight = {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical" | "success";
};

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type TicketRisk = {
  score: number;
  level: RiskLevel;
  reasons: string[];
};

export function getSlaState(ticket: Ticket, now = new Date()): SlaState {
  if (ticket.status === "resolved") {
    return "done";
  }

  const dueAt = new Date(ticket.dueAt).getTime();
  const current = now.getTime();

  if (current > dueAt) {
    return "breached";
  }

  const hoursLeft = (dueAt - current) / 1000 / 60 / 60;
  return hoursLeft <= 12 ? "at_risk" : "healthy";
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function formatSearchDate(value: string): string {
  const date = new Date(value);
  return [
    new Intl.DateTimeFormat("pt-BR").format(date),
    new Intl.DateTimeFormat("pt-BR", { month: "long" }).format(date),
    new Intl.DateTimeFormat("pt-BR", { month: "2-digit", year: "numeric" }).format(date),
    value.slice(0, 10),
    value.slice(0, 7)
  ].join(" ");
}

function isSameDay(first: Date, second: Date): boolean {
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

function matchesDueState(ticket: Ticket, due: DueState, now: Date): boolean {
  if (ticket.status === "resolved") {
    return false;
  }

  const dueDate = new Date(ticket.dueAt);

  if (due === "overdue") {
    return dueDate.getTime() < now.getTime();
  }

  if (due === "today") {
    return isSameDay(dueDate, now);
  }

  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);
  return dueDate.getTime() >= now.getTime() && dueDate.getTime() <= weekAhead.getTime();
}

export function filterTickets(tickets: Ticket[], filters: TicketFilters): Ticket[] {
  const query = filters.q ? normalizeText(filters.q.trim()) : undefined;
  const now = new Date();

  return tickets.filter((ticket) => {
    const matchesQuery = !query
      || [
        ticket.title,
        ticket.requester,
        ticket.department,
        ticket.description,
        ticket.assignee,
        ticket.status,
        ticket.priority,
        ticket.category,
        formatSearchDate(ticket.dueAt),
        formatSearchDate(ticket.createdAt),
        ...ticket.tags
      ]
        .join(" ")
        .split(/\s+/)
        .join(" ")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .includes(query);

    return matchesQuery
      && (!filters.status || ticket.status === filters.status)
      && (!filters.priority || ticket.priority === filters.priority)
      && (!filters.category || ticket.category === filters.category)
      && (!filters.assignee || normalizeText(ticket.assignee).includes(normalizeText(filters.assignee)))
      && (!filters.month || ticket.dueAt.startsWith(filters.month))
      && (!filters.due || matchesDueState(ticket, filters.due, now));
  });
}

export function getTicketStats(tickets: Ticket[], now = new Date()): TicketStats {
  const byStatus = Object.fromEntries(ticketStatuses.map((status) => [status, 0])) as Record<TicketStatus, number>;
  const byPriority = Object.fromEntries(ticketPriorities.map((priority) => [priority, 0])) as Record<TicketPriority, number>;
  const byCategory = Object.fromEntries(ticketCategories.map((category) => [category, 0])) as Record<TicketCategory, number>;
  const byAssignee: Record<string, number> = {};

  for (const ticket of tickets) {
    byStatus[ticket.status] += 1;
    byPriority[ticket.priority] += 1;
    byCategory[ticket.category] += 1;

    if (ticket.status !== "resolved") {
      byAssignee[ticket.assignee] = (byAssignee[ticket.assignee] ?? 0) + 1;
    }
  }

  const resolved = byStatus.resolved;
  const breached = tickets.filter((ticket) => getSlaState(ticket, now) === "breached").length;

  return {
    total: tickets.length,
    open: tickets.filter((ticket) => ticket.status !== "resolved").length,
    resolved,
    urgent: byPriority.urgent,
    atRisk: tickets.filter((ticket) => getSlaState(ticket, now) === "at_risk").length,
    breached,
    completionRate: tickets.length === 0 ? 0 : Math.round((resolved / tickets.length) * 100),
    overdueRate: tickets.length === 0 ? 0 : Math.round((breached / tickets.length) * 100),
    byStatus,
    byPriority,
    byCategory,
    byAssignee
  };
}

export function getTicketRisk(ticket: Ticket, tickets: Ticket[], now = new Date()): TicketRisk {
  if (ticket.status === "resolved") {
    return {
      score: 0,
      level: "low",
      reasons: ["Tarefa concluída"]
    };
  }

  const reasons: string[] = [];
  let score = 0;
  const sla = getSlaState(ticket, now);
  const assigneeOpen = tickets.filter((item) => item.status !== "resolved" && item.assignee === ticket.assignee).length;
  const categoryOpen = tickets.filter((item) => item.status !== "resolved" && item.category === ticket.category).length;

  if (sla === "breached") {
    score += 3;
    reasons.push("Prazo vencido");
  } else if (sla === "at_risk" || isSameDay(new Date(ticket.dueAt), now)) {
    score += 2;
    reasons.push("Vence hoje ou está em risco");
  }

  if (ticket.priority === "urgent") {
    score += 2;
    reasons.push("Prioridade urgente");
  } else if (ticket.priority === "high") {
    score += 1;
    reasons.push("Prioridade alta");
  }

  if (assigneeOpen >= 3) {
    score += 1;
    reasons.push("Responsável com alta carga");
  }

  if (categoryOpen >= 2) {
    score += 1;
    reasons.push("Categoria com gargalo");
  }

  if (ticket.status === "waiting") {
    score += 1;
    reasons.push("Aguardando retorno");
  }

  const level: RiskLevel = score >= 7 ? "critical" : score >= 5 ? "high" : score >= 3 ? "medium" : "low";

  return {
    score,
    level,
    reasons: reasons.length > 0 ? reasons : ["Sem risco imediato"]
  };
}

function getLargestEntry<T extends string>(record: Record<T, number>): [T, number] | undefined {
  return Object.entries(record).sort((a, b) => Number(b[1]) - Number(a[1]))[0] as [T, number] | undefined;
}

export function getTicketInsights(tickets: Ticket[], now = new Date()): TicketInsight[] {
  const stats = getTicketStats(tickets, now);
  const openTickets = tickets.filter((ticket) => ticket.status !== "resolved");
  const insights: TicketInsight[] = [];

  if (stats.breached > 0) {
    insights.push({
      id: "overdue",
      title: "Prazo em risco para a operação",
      description: `${stats.breached} tarefa(s) vencida(s). Replaneje responsáveis e registre impedimentos antes de abrir novas demandas.`,
      severity: "critical"
    });
  }

  const mainCategory = getLargestEntry(stats.byCategory);
  if (mainCategory && mainCategory[1] > 0) {
    insights.push({
      id: "category",
      title: "Categoria que mais consome a fila",
      description: `${mainCategory[1]} tarefa(s) estão concentradas em ${ticketCategoryNames[mainCategory[0]]}. Isso indica onde uma automação ou padrão pode reduzir retrabalho.`,
      severity: mainCategory[1] >= Math.max(3, Math.ceil(tickets.length / 2)) ? "warning" : "info"
    });
  }

  const mainAssignee = Object.entries(stats.byAssignee).sort((a, b) => b[1] - a[1])[0];
  if (mainAssignee) {
    insights.push({
      id: "assignee",
      title: "Carga por responsável",
      description: `${mainAssignee[0]} tem ${mainAssignee[1]} tarefa(s) aberta(s). Redistribuir trabalho evita gargalo individual.`,
      severity: mainAssignee[1] >= 4 ? "warning" : "info"
    });
  }

  const nextDue = openTickets
    .slice()
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())[0];

  if (nextDue) {
    insights.push({
      id: "next-due",
      title: "Próxima decisão operacional",
      description: `A próxima entrega é "${nextDue.title}". Ela deve ser tratada antes das tarefas de menor prioridade.`,
      severity: getSlaState(nextDue, now) === "healthy" ? "success" : "warning"
    });
  }

  if (stats.completionRate < 35 && tickets.length >= 4) {
    insights.push({
      id: "completion",
      title: "Baixa taxa de conclusão",
      description: `Apenas ${stats.completionRate}% da fila está concluída. O painel sugere revisar escopo, status e prazos para destravar a operação.`,
      severity: "warning"
    });
  }

  return insights.slice(0, 4);
}

export function getDueDateForPriority(priority: TicketPriority, createdAt = new Date()): string {
  const hoursByPriority: Record<TicketPriority, number> = {
    urgent: 24,
    high: 48,
    medium: 96,
    low: 168
  };
  return new Date(createdAt.getTime() + hoursByPriority[priority] * 3_600_000).toISOString();
}
