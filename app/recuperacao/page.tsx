"use client";

import { Suspense, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Shell from "@/components/Shell";
import StoreSelect, { useStoresState } from "@/components/StoreSelect";
import DashboardTab from "@/components/recovery/DashboardTab";
import ConversationsTab from "@/components/recovery/ConversationsTab";
import StepsTab from "@/components/recovery/StepsTab";
import SettingsTab from "@/components/recovery/SettingsTab";
import DeliverabilityTab from "@/components/recovery/DeliverabilityTab";

// Recuperação de carrinho em abas: Painel (métricas, alertas, pós-compra),
// Conversas (chat ao vivo do WhatsApp), Régua (passos por fluxo/canal/idioma),
// Configuração e Entregabilidade (DNS, aquecimento, saúde, taxa de entrega).
// Aba, loja e conversa aberta ficam na URL (?tab=&store=&c=) para o link
// poder ser colado.

type Tab = "painel" | "conversas" | "regua" | "configuracao" | "entregabilidade";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "painel", label: "Painel" },
  { key: "conversas", label: "Conversas" },
  { key: "regua", label: "Régua" },
  { key: "configuracao", label: "Configuração" },
  { key: "entregabilidade", label: "Entregabilidade" },
];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.key === v);
// Abas que precisam de UMA loja escolhida (sem escolha, a primeira).
const PER_STORE: Tab[] = ["regua", "configuracao"];

function RecuperacaoInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { stores, loading: storesLoading, error: storesError } = useStoresState();
  // Alterações não salvas (Régua/Configuração avisam por onDirtyChange): trocar
  // de loja ou de aba pede confirmação.
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => { dirtyRef.current = d; }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const tabParam = params.get("tab");
  const tab: Tab = isTab(tabParam) ? tabParam : "painel";
  const store = params.get("store") ?? "";
  const selected = params.get("c");
  const effectiveStore = store || stores[0]?.id || "";

  const go = useCallback((patch: Record<string, string | null>) => {
    // Trocar de aba ou de loja com edição pendente descarta o que não foi salvo.
    const changesTab = "tab" in patch && (patch.tab ?? "painel") !== tab;
    const changesStore = "store" in patch && (patch.store ?? "") !== store && !(PER_STORE.includes(tab) && patch.store === effectiveStore);
    if (dirtyRef.current && (changesTab || changesStore)) {
      if (!window.confirm("Há alterações não salvas nesta tela. Trocar de aba ou de loja descarta essas alterações. Continuar?")) return;
      dirtyRef.current = false;
    }
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const qs = sp.toString();
    router.replace(qs ? `/recuperacao?${qs}` : "/recuperacao");
  }, [params, router, tab, store, effectiveStore]);

  const noStore = <div className="empty" style={storesError ? { color: "var(--danger)" } : undefined}>{storesError ? `Não consegui carregar as lojas: ${storesError}` : storesLoading ? "Carregando lojas…" : "Nenhuma loja cadastrada."}</div>;

  return (
    <Shell full>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", minHeight: 0 }}>
        <div style={{ padding: "1rem 2.5rem 0.75rem", borderBottom: "1px solid var(--border)", background: "var(--surface)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
            <h1 className="page-title" style={{ margin: 0 }}>Recuperação de carrinho</h1>
            <div className="tabs">
              {TABS.map((t) => (
                <button key={t.key} type="button" className={`tab${tab === t.key ? " active" : ""}`} onClick={() => go({ tab: t.key })}>{t.label}</button>
              ))}
            </div>
          </div>
          {tab !== "painel" && (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span className="hint">Loja</span>
              {PER_STORE.includes(tab) ? (
                <StoreSelect value={effectiveStore} onChange={(v) => go({ store: v || null })} allLabel={null} />
              ) : (
                <StoreSelect value={store} onChange={(v) => go({ store: v || null })} allLabel="Todas as lojas" />
              )}
            </div>
          )}
        </div>

        {tab === "conversas" ? (
          <ConversationsTab store={store} selectedId={selected} onSelect={(id) => go({ c: id })} />
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "1.25rem 2.5rem 4rem" }}>
            {tab === "painel" && <DashboardTab onOpenConversation={(id) => go({ tab: "conversas", c: id, store: null })} />}
            {tab === "regua" && (effectiveStore ? <StepsTab storeId={effectiveStore} onDirtyChange={onDirtyChange} /> : noStore)}
            {tab === "configuracao" && (effectiveStore ? <SettingsTab storeId={effectiveStore} onDirtyChange={onDirtyChange} /> : noStore)}
            {tab === "entregabilidade" && <DeliverabilityTab storeId={store || undefined} />}
          </div>
        )}
      </div>
    </Shell>
  );
}

export default function RecuperacaoPage() {
  return (
    <Suspense fallback={<Shell><div className="empty">Carregando…</div></Shell>}>
      <RecuperacaoInner />
    </Suspense>
  );
}
