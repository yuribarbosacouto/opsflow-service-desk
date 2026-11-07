import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  FilterX,
  Gauge,
  History,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCcw,
  Share2,
  ShieldAlert,
  Target,
  Trash2,
  Users,
  X
} from "lucide-react";
import {
  dueStates,
  getTicketRisk,
  ticketEventTypeNames,
  ticketCategories,
  ticketPriorities,
  ticketStatuses,
  type CreateTicketInput,
  type DueState,
  type Ticket,
  type TicketEvent,
  type TicketCategory,
  type TicketFilters,
  type TicketInsight,
  type TicketPriority,
  type TicketStats,
  type TicketStatus,
  type UpdateTicketInput
} from "@opsflow/domain";
import { addTicketComment, createTicket, deleteTicket, fetchInsights, fetchStats, fetchTicketEvents, fetchTickets, isOnlineDemo, resetOnlineDemo, updateTicket, updateTicketStatus } from "./lib/api";
import {
  categoryLabel,
  formatDateTime,
  getPriorityClass,
  getRiskClass,
  priorityLabel,
  riskLabel,
  statusLabel
} from "./lib/format";
import { StatTile } from "./components/StatTile";
import { TicketFilters as TicketFiltersPanel } from "./components/TicketFilters";
import { TicketForm, type TicketFormPayload } from "./components/TicketForm";
import { TicketTable } from "./components/TicketTable";

type ViewMode = "overview" | "queue" | "kanban" | "reports";

const emptyStats: TicketStats = {
  total: 0,
  open: 0,
  resolved: 0,
  urgent: 0,
  atRisk: 0,
  breached: 0,
  completionRate: 0,
  overdueRate: 0,
  byStatus: {
    backlog: 0,
    triage: 0,
    in_progress: 0,
    waiting: 0,
    resolved: 0
  },
  byPriority: {
    low: 0,
    medium: 0,
    high: 0,
    urgent: 0
  },
  byCategory: {
    access: 0,
    documentation: 0,
    automation: 0,
    data: 0,
    incident: 0
  },
  byAssignee: {}
};

const navItems: Array<{ id: ViewMode; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "queue", label: "Fila operacional", icon: ListChecks },
  { id: "kanban", label: "Kanban", icon: ClipboardList },
  { id: "reports", label: "Relatórios", icon: BarChart3 }
];

const filterKeys: Array<keyof TicketFilters> = ["q", "status", "priority", "category", "assignee", "month", "due"];

const insightClass: Record<TicketInsight["severity"], string> = {
  info: "border-slate-200 bg-white text-slate-800",
  warning: "border-amber-200 bg-amber-50 text-amber-950",
  critical: "border-rose-200 bg-rose-50 text-rose-950",
  success: "border-emerald-200 bg-emerald-50 text-emerald-950"
};

function formatMonth(value: string): string {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(new Date(year ?? 2026, (month ?? 1) - 1, 1));
}

function readFiltersFromUrl(): TicketFilters {
  if (typeof window === "undefined") {
    return {};
  }

  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const priority = params.get("priority");
  const category = params.get("category");
  const due = params.get("due");
  const month = params.get("month");
  const priorityValue = priority as TicketPriority;
  const dueValue = due as DueState;

  return {
    q: params.get("q") || undefined,
    status: ticketStatuses.includes(status as TicketStatus) ? status as TicketFilters["status"] : undefined,
    priority: priority && ticketPriorities.includes(priorityValue) ? priorityValue : undefined,
    category: ticketCategories.includes(category as TicketCategory) ? category as TicketFilters["category"] : undefined,
    assignee: params.get("assignee") || undefined,
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : undefined,
    due: due && dueStates.includes(dueValue) ? dueValue : undefined
  };
}

function syncFiltersToUrl(filters: TicketFilters) {
  if (typeof window === "undefined") {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  for (const key of filterKeys) {
    params.delete(key);
    const value = filters[key];
    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
}

function escapeCsv(value: string | number): string {
  const text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildTicketsCsv(tickets: Ticket[]): string {
  const headers = ["Titulo", "Solicitante", "Area", "Responsavel", "Categoria", "Status", "Prioridade", "Prazo", "Tags"];
  const rows = tickets.map((ticket) => [
    ticket.title,
    ticket.requester,
    ticket.department,
    ticket.assignee,
    categoryLabel[ticket.category],
    statusLabel[ticket.status],
    priorityLabel[ticket.priority],
    formatDateTime(ticket.dueAt),
    ticket.tags.join(", ")
  ]);

  return [headers, ...rows]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\n");
}

function downloadTicketsCsv(tickets: Ticket[]) {
  const csv = buildTicketsCsv(tickets);
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `opsflow-fila-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function getFilterChips(filters: TicketFilters) {
  return [
    filters.q ? { key: "q", label: `Busca: ${filters.q}` } : undefined,
    filters.status ? { key: "status", label: `Status: ${statusLabel[filters.status]}` } : undefined,
    filters.priority ? { key: "priority", label: `Prioridade: ${priorityLabel[filters.priority]}` } : undefined,
    filters.category ? { key: "category", label: `Categoria: ${categoryLabel[filters.category]}` } : undefined,
    filters.assignee ? { key: "assignee", label: `Responsável: ${filters.assignee}` } : undefined,
    filters.month ? { key: "month", label: `Mês: ${formatMonth(filters.month)}` } : undefined,
    filters.due ? { key: "due", label: `Prazo: ${filters.due === "overdue" ? "vencidas" : filters.due === "today" ? "hoje" : "7 dias"}` } : undefined
  ].filter(Boolean) as Array<{ key: keyof TicketFilters; label: string }>;
}

function sortByRisk(tickets: Ticket[], allTickets: Ticket[]) {
  return tickets
    .slice()
    .sort((a, b) => {
      const riskDiff = getTicketRisk(b, allTickets).score - getTicketRisk(a, allTickets).score;
      if (riskDiff !== 0) {
        return riskDiff;
      }

      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    });
}

function getTopEntries(record: Record<string, number>, limit = 5) {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function BarList({ items }: { items: Array<{ label: string; value: number; tone?: string }> }) {
  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item.label}>
          <div className="mb-1 flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-slate-700">{item.label}</span>
            <span className="text-slate-500">{item.value}</span>
          </div>
          <div className="h-2 rounded-full bg-slate-100">
            <div
              className={`h-2 rounded-full ${item.tone ?? "bg-cyan-600"}`}
              style={{ width: `${Math.max(6, (item.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyQueue({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  return (
    <section className="flex min-h-80 flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-white px-6 py-10 text-center shadow-sm">
      <FilterX aria-hidden="true" className="h-9 w-9 text-slate-400" />
      <h2 className="mt-4 text-base font-semibold text-slate-950">
        {hasFilters ? "Nenhuma tarefa encontrada para os filtros atuais" : "Nenhuma tarefa cadastrada"}
      </h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-600">
        {hasFilters
          ? "Os indicadores continuam mostrando a operação inteira, mas a fila abaixo está filtrada. Limpe os filtros para voltar à visão completa."
          : "Crie a primeira tarefa para começar a acompanhar prazos, responsáveis e risco operacional."}
      </p>
      {hasFilters && (
        <button
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          type="button"
          onClick={onClear}
        >
          <X aria-hidden="true" className="h-4 w-4" />
          Limpar filtros
        </button>
      )}
    </section>
  );
}

export function App() {
  const [allTickets, setAllTickets] = useState<Ticket[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [stats, setStats] = useState<TicketStats>(emptyStats);
  const [insights, setInsights] = useState<TicketInsight[]>([]);
  const [filters, setFilters] = useState<TicketFilters>(() => readFiltersFromUrl());
  const [selectedId, setSelectedId] = useState<string>();
  const [activeView, setActiveView] = useState<ViewMode>("overview");
  const [formMode, setFormMode] = useState<"create" | "edit">();
  const [ticketToDelete, setTicketToDelete] = useState<Ticket>();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [viewCopied, setViewCopied] = useState(false);
  const [ticketEvents, setTicketEvents] = useState<TicketEvent[]>([]);
  const [eventsRefreshKey, setEventsRefreshKey] = useState(0);
  const [commentText, setCommentText] = useState("");
  const [isCommenting, setIsCommenting] = useState(false);
  const [eventError, setEventError] = useState<string>();
  const latestRequestId = useRef(0);

  const rankedTickets = useMemo(
    () => sortByRisk(tickets, allTickets),
    [allTickets, tickets]
  );
  const selectedTicket = useMemo(
    () => allTickets.find((ticket) => ticket.id === selectedId) ?? rankedTickets[0] ?? sortByRisk(allTickets, allTickets)[0],
    [allTickets, rankedTickets, selectedId]
  );
  const filterChips = useMemo(() => getFilterChips(filters), [filters]);
  const hasActiveFilters = filterChips.length > 0;
  const priorityTickets = useMemo(
    () => sortByRisk(allTickets.filter((ticket) => ticket.status !== "resolved"), allTickets).slice(0, 4),
    [allTickets]
  );
  const selectedRisk = selectedTicket ? getTicketRisk(selectedTicket, allTickets) : undefined;

  async function loadData(nextFilters = filters) {
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    setIsLoading(true);
    setError(undefined);

    try {
      const [ticketData, allTicketData, statsData, insightData] = await Promise.all([
        fetchTickets(nextFilters),
        fetchTickets({}),
        fetchStats(),
        fetchInsights()
      ]);
      if (requestId !== latestRequestId.current) {
        return;
      }

      setTickets(ticketData);
      setAllTickets(allTicketData);
      setStats(statsData);
      setInsights(insightData);
      setSelectedId((current) => {
        if (current && ticketData.some((ticket) => ticket.id === current)) {
          return current;
        }

        return sortByRisk(ticketData, allTicketData)[0]?.id ?? sortByRisk(allTicketData, allTicketData)[0]?.id;
      });
      setError(undefined);
    } catch {
      if (requestId !== latestRequestId.current) {
        return;
      }
      setError("Não foi possível carregar as tarefas. Verifique se a API está rodando.");
    } finally {
      if (requestId === latestRequestId.current) {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    void loadData(filters);
  }, []);

  useEffect(() => {
    const ticketId = selectedTicket?.id;
    if (!ticketId) {
      setTicketEvents([]);
      return;
    }

    let isActive = true;
    setEventError(undefined);
    fetchTicketEvents(ticketId)
      .then((events) => {
        if (isActive) {
          setTicketEvents(events);
        }
      })
      .catch(() => {
        if (isActive) {
          setTicketEvents([]);
          setEventError("Não foi possível carregar o histórico da tarefa.");
        }
      });

    return () => {
      isActive = false;
    };
  }, [selectedTicket?.id, eventsRefreshKey]);

  async function handleFilterChange(nextFilters: TicketFilters) {
    setFilters(nextFilters);
    syncFiltersToUrl(nextFilters);
    await loadData(nextFilters);
  }

  async function clearFilters() {
    const clearedFilters: TicketFilters = {};
    setFilters(clearedFilters);
    syncFiltersToUrl(clearedFilters);
    await loadData(clearedFilters);
  }

  async function removeFilter(key: keyof TicketFilters) {
    const nextFilters = { ...filters, [key]: undefined };
    await handleFilterChange(nextFilters);
  }

  async function handleCreateTicket(input: CreateTicketInput) {
    const ticket = await createTicket(input);
    const clearedFilters: TicketFilters = {};
    setFormMode(undefined);
    setFilters(clearedFilters);
    syncFiltersToUrl(clearedFilters);
    await loadData(clearedFilters);
    setSelectedId(ticket.id);
  }

  async function copyCurrentView() {
    if (typeof window === "undefined" || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(window.location.href);
    setViewCopied(true);
    window.setTimeout(() => setViewCopied(false), 1600);
  }

  async function handleUpdateTicket(input: TicketFormPayload) {
    if (!selectedTicket) {
      return;
    }

    const ticket = await updateTicket(selectedTicket.id, input as UpdateTicketInput);
    setFormMode(undefined);
    await loadData(filters);
    setSelectedId(ticket.id);
    setEventsRefreshKey((current) => current + 1);
  }

  async function handleDeleteTicket() {
    if (!ticketToDelete) {
      return;
    }

    await deleteTicket(ticketToDelete.id);
    setTicketToDelete(undefined);
    setFormMode(undefined);
    await loadData(filters);
  }

  async function handleStatusChange(status: TicketStatus) {
    if (!selectedTicket) {
      return;
    }

    const ticket = await updateTicketStatus(selectedTicket.id, status);
    await loadData(filters);
    setSelectedId(ticket.id);
    setEventsRefreshKey((current) => current + 1);
  }

  async function handleAddComment() {
    if (!selectedTicket || !commentText.trim()) {
      return;
    }

    setIsCommenting(true);
    setEventError(undefined);
    try {
      const event = await addTicketComment(selectedTicket.id, {
        actor: "Yuri Barbosa",
        message: commentText.trim()
      });
      setTicketEvents((current) => [event, ...current]);
      setCommentText("");
      await loadData(filters);
      setSelectedId(selectedTicket.id);
    } catch {
      setEventError("Não foi possível registrar o comentário.");
    } finally {
      setIsCommenting(false);
    }
  }

  const statusChart = ticketStatuses.map((status) => ({
    label: statusLabel[status],
    value: stats.byStatus[status],
    tone: status === "resolved" ? "bg-emerald-500" : status === "waiting" ? "bg-amber-500" : "bg-cyan-600"
  }));
  const categoryChart = ticketCategories.map((category: TicketCategory) => ({
    label: categoryLabel[category],
    value: stats.byCategory[category],
    tone: category === "documentation" ? "bg-indigo-500" : category === "data" ? "bg-cyan-600" : "bg-slate-500"
  }));
  const assigneeChart = getTopEntries(stats.byAssignee).map(([label, value]) => ({ label, value, tone: "bg-slate-800" }));

  return (
    <main className="min-h-screen bg-[#f3f6fa] text-slate-950 lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-slate-950 px-4 py-4 text-white lg:min-h-screen lg:border-b-0 lg:border-r lg:border-slate-800">
        <div className="flex items-center justify-between gap-3 lg:block">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">OpsFlow</p>
            <h1 className="mt-1 text-lg font-semibold">Command Center</h1>
          </div>
          <button
            className="inline-flex items-center gap-2 rounded-md bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950 lg:hidden"
            type="button"
            onClick={() => setFormMode("create")}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            Nova
          </button>
        </div>

        <nav className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-1">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition ${
                activeView === item.id ? "bg-white text-slate-950" : "text-slate-300 hover:bg-white/10 hover:text-white"
              }`}
              type="button"
              onClick={() => setActiveView(item.id)}
            >
              <item.icon aria-hidden="true" className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-6 hidden rounded-md border border-white/10 bg-white/5 p-3 text-sm leading-6 text-slate-300 lg:block">
          <strong className="block text-white">Foco do produto</strong>
          Priorizar demandas administrativas, detectar gargalos e controlar prazos críticos.
        </div>
      </aside>

      <section className="min-w-0">
        <header className="border-b border-slate-200 bg-white px-4 py-4 md:px-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-700">Painel de gargalos administrativos</p>
              <h2 className="mt-1 text-2xl font-semibold">Priorize o que destrava a operação</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                Score de risco por prazo, prioridade, carga do responsável e categoria com gargalo. A tela responde o que fazer primeiro, não apenas lista tarefas.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                type="button"
                onClick={() => void loadData(filters)}
              >
                <RefreshCcw aria-hidden="true" className="h-4 w-4" />
                Atualizar
              </button>
              {isOnlineDemo() && (
                <button
                  className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                  type="button"
                  onClick={() => {
                    if (!window.confirm("Restaurar os dados fictícios originais? Suas alterações nesta demonstração serão perdidas.")) return;
                    resetOnlineDemo();
                    setSelectedId(undefined);
                    setTicketEvents([]);
                    setEventsRefreshKey((value) => value + 1);
                    void loadData(filters);
                  }}
                >
                  <RefreshCcw aria-hidden="true" className="h-4 w-4" />
                  Restaurar demo
                </button>
              )}
              <button
                className="hidden items-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 lg:inline-flex"
                type="button"
                onClick={() => setFormMode("create")}
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                Nova tarefa
              </button>
            </div>
          </div>
        </header>

        <div className="flex flex-col gap-5 px-4 py-5 md:px-6">
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <StatTile icon={ClipboardList} label="Tarefas abertas" value={stats.open} />
            <StatTile icon={Gauge} label="Conclusão" value={`${stats.completionRate}%`} />
            <StatTile icon={ShieldAlert} label="Urgentes" value={stats.urgent} tone={stats.urgent > 0 ? "danger" : "default"} />
            <StatTile icon={AlertTriangle} label="Em risco" value={stats.atRisk} tone={stats.atRisk > 0 ? "warning" : "default"} />
            <StatTile icon={AlertTriangle} label="Vencidas" value={stats.breached} tone={stats.breached > 0 ? "danger" : "default"} />
            <StatTile icon={CheckCircle2} label="Concluídas" value={stats.resolved} />
          </section>

          {error && (
            <section className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900">
              {error}
            </section>
          )}

          {formMode && (
            <TicketForm
              mode={formMode}
              initialValue={formMode === "edit" ? selectedTicket : undefined}
              onSubmit={(input) => formMode === "edit" ? handleUpdateTicket(input) : handleCreateTicket(input)}
              onCancel={() => setFormMode(undefined)}
            />
          )}

          {activeView === "overview" && (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_420px]">
              <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-2">
                  <Target aria-hidden="true" className="h-5 w-5 text-rose-700" />
                  <h2 className="text-base font-semibold">Prioridade de hoje</h2>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {priorityTickets.map((ticket, index) => {
                    const risk = getTicketRisk(ticket, allTickets);
                    return (
                      <button
                        key={ticket.id}
                        className="rounded-md border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-cyan-300 hover:bg-cyan-50/40"
                        type="button"
                        onClick={() => {
                          setSelectedId(ticket.id);
                          setActiveView("queue");
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="rounded-sm bg-slate-950 px-2 py-1 text-xs font-semibold text-white">#{index + 1}</span>
                          <span className={`rounded-sm px-2 py-1 text-xs font-semibold ${getRiskClass(risk.level)}`}>
                            Risco {risk.score}
                          </span>
                        </div>
                        <h3 className="mt-3 text-base font-semibold leading-tight">{ticket.title}</h3>
                        <p className="mt-2 text-sm text-slate-600">{ticket.assignee} · {categoryLabel[ticket.category]} · {formatDateTime(ticket.dueAt)}</p>
                        <p className="mt-3 text-xs leading-5 text-slate-500">{risk.reasons.slice(0, 2).join(" + ")}</p>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-2">
                  <Lightbulb aria-hidden="true" className="h-5 w-5 text-cyan-700" />
                  <h2 className="text-base font-semibold">Insights operacionais</h2>
                </div>
                <div className="space-y-3">
                  {insights.map((insight) => (
                    <article key={insight.id} className={`rounded-md border p-3 ${insightClass[insight.severity]}`}>
                      <h3 className="text-sm font-semibold">{insight.title}</h3>
                      <p className="mt-1 text-xs leading-5">{insight.description}</p>
                    </article>
                  ))}
                </div>
              </section>

              <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-base font-semibold">Tarefas por status</h2>
                <div className="mt-4">
                  <BarList items={statusChart} />
                </div>
              </section>

              <section className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-base font-semibold">Gargalos por categoria</h2>
                <div className="mt-4">
                  <BarList items={categoryChart} />
                </div>
              </section>
            </div>
          )}

          {activeView === "queue" && (
            <>
              <section className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-slate-950">Fila operacional compartilhável</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    A busca atual fica salva na URL e pode ser enviada para outra pessoa revisar a mesma visão.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                    type="button"
                    onClick={() => void copyCurrentView()}
                  >
                    {viewCopied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Share2 aria-hidden="true" className="h-4 w-4" />}
                    {viewCopied ? "Link copiado" : "Copiar visão"}
                  </button>
                  <button
                    className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    onClick={() => downloadTicketsCsv(tickets)}
                    disabled={tickets.length === 0}
                  >
                    <Download aria-hidden="true" className="h-4 w-4" />
                    Exportar CSV
                  </button>
                </div>
              </section>

              <TicketFiltersPanel filters={filters} onChange={(nextFilters) => void handleFilterChange(nextFilters)} />

              {hasActiveFilters && (
                <section className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm">
                  <span className="text-xs font-semibold uppercase text-slate-500">Filtros ativos</span>
                  {filterChips.map((chip) => (
                    <button
                      key={chip.key}
                      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
                      type="button"
                      onClick={() => void removeFilter(chip.key)}
                    >
                      {chip.label}
                      <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  ))}
                  <button
                    className="inline-flex items-center gap-1 rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
                    type="button"
                    onClick={() => void clearFilters()}
                  >
                    <FilterX aria-hidden="true" className="h-3.5 w-3.5" />
                    Limpar tudo
                  </button>
                </section>
              )}

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
                {isLoading ? (
                  <section className="flex min-h-80 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600">
                    <Loader2 aria-hidden="true" className="mr-2 h-5 w-5 animate-spin" />
                    Carregando tarefas
                  </section>
                ) : tickets.length > 0 ? (
                  <TicketTable tickets={rankedTickets} allTickets={allTickets} selectedId={selectedTicket?.id} onSelect={(ticket) => setSelectedId(ticket.id)} />
                ) : (
                  <EmptyQueue hasFilters={hasActiveFilters} onClear={() => void clearFilters()} />
                )}

                <aside className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
                  {selectedTicket && selectedRisk ? (
                    <div className="flex h-full flex-col gap-5">
                      <div>
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <span className="rounded-sm bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-800">{categoryLabel[selectedTicket.category]}</span>
                          <span className={`rounded-sm px-2 py-1 text-xs font-semibold ${getRiskClass(selectedRisk.level)}`}>
                            {riskLabel[selectedRisk.level]} · {selectedRisk.score}
                          </span>
                        </div>
                        <h2 className="text-lg font-semibold leading-tight">{selectedTicket.title}</h2>
                        <p className="mt-3 text-sm leading-6 text-slate-600">{selectedTicket.description}</p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                          type="button"
                          onClick={() => setFormMode("edit")}
                        >
                          <Pencil aria-hidden="true" className="h-4 w-4" />
                          Editar
                        </button>
                        <button
                          className="inline-flex items-center gap-2 rounded-md border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-50"
                          type="button"
                          onClick={() => setTicketToDelete(selectedTicket)}
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                          Excluir
                        </button>
                      </div>

                      <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <dt className="text-xs font-semibold uppercase text-slate-500">Solicitante</dt>
                          <dd className="mt-1 text-slate-900">{selectedTicket.requester}</dd>
                        </div>
                        <div>
                          <dt className="text-xs font-semibold uppercase text-slate-500">Área</dt>
                          <dd className="mt-1 text-slate-900">{selectedTicket.department}</dd>
                        </div>
                        <div>
                          <dt className="text-xs font-semibold uppercase text-slate-500">Responsável</dt>
                          <dd className="mt-1 text-slate-900">{selectedTicket.assignee}</dd>
                        </div>
                        <div>
                          <dt className="text-xs font-semibold uppercase text-slate-500">Prazo</dt>
                          <dd className="mt-1 text-slate-900">{formatDateTime(selectedTicket.dueAt)}</dd>
                        </div>
                      </dl>

                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase text-slate-500">Status</div>
                        <div className="grid grid-cols-2 gap-2">
                          {ticketStatuses.map((status) => (
                            <button
                              key={status}
                              className={`rounded-md border px-3 py-2 text-left text-sm font-medium transition ${
                                selectedTicket.status === status
                                  ? "border-slate-950 bg-slate-950 text-white"
                                  : "border-slate-200 text-slate-700 hover:bg-slate-50"
                              }`}
                              type="button"
                              onClick={() => void handleStatusChange(status)}
                            >
                              {statusLabel[status]}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
                        <div className="mb-2 flex items-center gap-2 font-semibold">
                          <ShieldAlert aria-hidden="true" className="h-4 w-4 text-rose-700" />
                          Por que essa tarefa importa
                        </div>
                        <ul className="space-y-1 text-slate-600">
                          {selectedRisk.reasons.map((reason) => (
                            <li key={reason}>• {reason}</li>
                          ))}
                        </ul>
                      </div>

                      <section className="border-t border-slate-200 pt-4">
                        <div className="mb-3 flex items-center gap-2 font-semibold">
                          <History aria-hidden="true" className="h-4 w-4 text-cyan-700" />
                          Histórico e comentários
                        </div>
                        <div className="space-y-2">
                          <label className="block text-xs font-semibold uppercase text-slate-500" htmlFor="ticket-comment">
                            Comentário interno
                          </label>
                          <textarea
                            id="ticket-comment"
                            className="min-h-20 w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900"
                            maxLength={500}
                            placeholder="Registre decisão, impedimento ou próximo passo..."
                            value={commentText}
                            onChange={(event) => setCommentText(event.target.value)}
                          />
                          <button
                            className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                            type="button"
                            disabled={isCommenting || !commentText.trim()}
                            onClick={() => void handleAddComment()}
                          >
                            {isCommenting ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <MessageSquare aria-hidden="true" className="h-4 w-4" />}
                            Registrar comentário
                          </button>
                        </div>

                        {eventError && (
                          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-900">{eventError}</p>
                        )}

                        <ol className="mt-4 max-h-72 space-y-3 overflow-y-auto border-l border-slate-200 pl-4">
                          {ticketEvents.map((event) => (
                            <li key={event.id} className="relative text-sm">
                              <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border border-white bg-cyan-700" />
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-semibold text-slate-950">{ticketEventTypeNames[event.type]}</span>
                                <span className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</span>
                              </div>
                              <p className="mt-1 leading-6 text-slate-700">{event.message}</p>
                              <p className="mt-1 text-xs text-slate-500">Por {event.actor}</p>
                              {event.changes.length > 0 && (
                                <ul className="mt-2 space-y-1 text-xs text-slate-600">
                                  {event.changes.map((change) => (
                                    <li key={change}>{change}</li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ol>
                      </section>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-600">Selecione uma tarefa para ver detalhes, histórico e ações rápidas.</p>
                  )}
                </aside>
              </div>
            </>
          )}

          {activeView === "kanban" && (
            <section className="grid gap-4 xl:grid-cols-5">
              {ticketStatuses.map((status) => {
                const columnTickets = sortByRisk(allTickets.filter((ticket) => ticket.status === status), allTickets);
                return (
                  <div key={status} className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold">{statusLabel[status]}</h2>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{columnTickets.length}</span>
                    </div>
                    <div className="space-y-3">
                      {columnTickets.map((ticket) => {
                        const risk = getTicketRisk(ticket, allTickets);
                        return (
                          <button
                            key={ticket.id}
                            className="w-full rounded-md border border-slate-200 bg-white p-3 text-left shadow-sm hover:border-cyan-300 hover:bg-cyan-50/40"
                            type="button"
                            onClick={() => {
                              setSelectedId(ticket.id);
                              setActiveView("queue");
                            }}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-xs font-semibold text-slate-500">{categoryLabel[ticket.category]}</span>
                              <span className={`rounded-sm px-2 py-0.5 text-xs font-semibold ${getRiskClass(risk.level)}`}>{risk.score}</span>
                            </div>
                            <h3 className="mt-2 text-sm font-semibold leading-tight">{ticket.title}</h3>
                            <p className="mt-2 text-xs text-slate-500">{ticket.assignee} · {formatDateTime(ticket.dueAt)}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {activeView === "reports" && (
            <section className="grid gap-5 xl:grid-cols-3">
              <article className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-2">
                  <BarChart3 aria-hidden="true" className="h-5 w-5 text-cyan-700" />
                  <h2 className="text-base font-semibold">Distribuição por status</h2>
                </div>
                <BarList items={statusChart} />
              </article>
              <article className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-2">
                  <Users aria-hidden="true" className="h-5 w-5 text-cyan-700" />
                  <h2 className="text-base font-semibold">Carga por responsável</h2>
                </div>
                <BarList items={assigneeChart.length > 0 ? assigneeChart : [{ label: "Sem tarefas abertas", value: 0 }]} />
              </article>
              <article className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-2">
                  <Gauge aria-hidden="true" className="h-5 w-5 text-cyan-700" />
                  <h2 className="text-base font-semibold">Categorias com gargalo</h2>
                </div>
                <BarList items={categoryChart} />
              </article>
            </section>
          )}
        </div>
      </section>

      {ticketToDelete && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-950/45 px-4">
          <section className="w-full max-w-md rounded-md border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-rose-50 p-2 text-rose-700">
                <Trash2 aria-hidden="true" className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-950">Excluir tarefa?</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  A tarefa "{ticketToDelete.title}" será removida do banco local. Essa ação evita exclusão acidental por exigir confirmação.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                type="button"
                onClick={() => setTicketToDelete(undefined)}
              >
                Cancelar
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-md bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-800"
                type="button"
                onClick={() => void handleDeleteTicket()}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
                Confirmar exclusão
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
