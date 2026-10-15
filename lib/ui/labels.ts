export const STATUS_LABEL: Record<string, string> = {
  nova: "Nova",
  reaberta: "Reaberta",
  aguardando_humano: "Pendente",
  respondida_ia: "Respondida (IA)",
  respondida_humano: "Respondida",
  encerrada: "Encerrada",
  spam: "Spam",
};

export const STATUS_CLASS: Record<string, string> = {
  nova: "badge-warn",
  reaberta: "badge-danger",
  aguardando_humano: "badge-warn",
  respondida_ia: "badge-ok",
  respondida_humano: "badge-ok",
  encerrada: "",
  spam: "",
};

export const CATEGORY_LABEL: Record<string, string> = {
  duvidas_gerais: "Dúvida",
  edicao_pedido: "Edição de pedido",
  rastreio: "Rastreio",
  reembolso: "Reembolso",
  reclamacao: "Reclamação",
  spam: "Spam",
  outro: "Outro",
  sem_categoria: "Sem categoria",
};

export const URGENCY_LABEL: Record<string, string> = {
  baixa: "baixa",
  normal: "normal",
  alta: "alta",
  urgente: "urgente",
};

export const URGENCY_CLASS: Record<string, string> = {
  baixa: "",
  normal: "",
  alta: "badge-warn",
  urgente: "badge-danger",
};

export { LANG_LABEL } from "@/lib/ai/lang";
export { PHASE_LABEL } from "@/lib/agent/phase";
export const PHASE_SHORT: Record<number, string> = { 1: "Fase 1", 2: "Fase 2", 3: "Fase 3", 4: "Fase 4" };
export const PHASE_CLASS: Record<number, string> = { 1: "", 2: "badge-warn", 3: "badge-danger", 4: "badge-accent" };

export const PENDING_STATUSES = ["nova", "reaberta", "aguardando_humano"];

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
