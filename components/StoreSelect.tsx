"use client";

import { useEffect, useState } from "react";

interface StoreOpt {
  id: string;
  name: string;
}

// Lista de lojas com estado de carregamento e erro (r.ok tratado: 401/500
// viram mensagem em vez de ficar "Carregando lojas…" para sempre).
export function useStoresState() {
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/stores", { cache: "no-store" });
        const d = (await r.json().catch(() => null)) as { stores?: StoreOpt[]; error?: string } | null;
        if (!alive) return;
        if (!r.ok) {
          setError(typeof d?.error === "string" ? d.error : `Erro ${r.status} ao carregar as lojas.`);
          return;
        }
        setStores(Array.isArray(d?.stores) ? d.stores : []);
      } catch (e) {
        if (alive) setError(`Sem resposta do servidor ao carregar as lojas (${(e as Error).message}).`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return { stores, loading, error };
}

// Compatível com quem só quer o array.
export function useStores() {
  return useStoresState().stores;
}

export default function StoreSelect({
  value,
  onChange,
  allLabel = "Todas as lojas",
}: {
  value: string;
  onChange: (v: string) => void;
  allLabel?: string | null;
}) {
  const { stores, error } = useStoresState();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title={error || undefined}>
      {allLabel !== null && <option value="">{allLabel}</option>}
      {error && <option value="" disabled>Erro ao carregar lojas</option>}
      {stores.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
