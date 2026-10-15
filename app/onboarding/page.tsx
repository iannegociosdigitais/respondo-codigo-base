"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Shell from "@/components/Shell";
import { PROVIDER_LABELS } from "@/lib/email/providers";

export default function OnboardingPage() {
  const router = useRouter();
  const [provider, setProvider] = useState("gmail");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    const r = await fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) {
      setError(d.error ?? "Erro ao criar a loja.");
      return;
    }
    router.push(`/lojas/${d.storeId}`);
  }

  return (
    <Shell>
      <Link href="/lojas" className="hint" style={{ textDecoration: "none" }}>
        ← Minhas lojas
      </Link>
      <h1 className="page-title" style={{ marginTop: "0.5rem" }}>Nova loja</h1>
      <p className="page-sub">Nome e caixa de e-mail. Contexto, tom de voz e Shopify você configura na tela da loja depois.</p>

      <form onSubmit={submit} className="card" style={{ maxWidth: "36rem" }}>
        <div className="section-title">Loja</div>
        <div className="field">
          <label htmlFor="storeName">Nome da loja</label>
          <input id="storeName" name="storeName" placeholder="Ex: Olavita" required />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
          <div className="field">
            <label htmlFor="agentName">Quem assina (opcional)</label>
            <input id="agentName" name="agentName" placeholder="Ex: Monique" />
          </div>
          <div className="field">
            <label htmlFor="deliveryDaysMax">Prazo máximo de entrega (dias)</label>
            <input id="deliveryDaysMax" name="deliveryDaysMax" type="number" placeholder="Ex: 17" />
          </div>
        </div>

        <div className="section-title" style={{ marginTop: "1rem" }}>Caixa de e-mail</div>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem", fontWeight: 400 }}>
          <input type="checkbox" name="sharedMailbox" checked={shared} onChange={(e) => setShared(e.target.checked)} style={{ width: "auto" }} />
          Esta marca recebe e-mails na caixa de outra loja já conectada
        </label>
        {shared && (
          <div className="field">
            <label htmlFor="aliases">Endereços desta marca (separados por vírgula)</label>
            <input id="aliases" name="aliases" placeholder="support@olavita.co.il, contact@olavita.com" required />
            <span className="hint">E-mails enviados pra esses endereços viram conversas desta loja, com contexto e assinatura próprios. Se a marca não tiver endereço próprio (ex.: Olavita só em hebraico), pode colocar a caixa compartilhada mesmo — o hebraico já roteia sozinho.</span>
          </div>
        )}
        {!shared && (<>
        <div className="field">
          <label htmlFor="provider">Provedor</label>
          <select id="provider" name="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDER_LABELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="emailAddress">E-mail de suporte</label>
          <input id="emailAddress" name="emailAddress" type="email" placeholder="support@minhaloja.com" required />
        </div>
        <div className="field">
          <label htmlFor="emailPassword">Senha de app (Gmail/Outlook) ou senha da caixa (Hostinger etc.)</label>
          <input id="emailPassword" name="emailPassword" type="password" required />
          <span className="hint">Gmail: myaccount.google.com/apppasswords. A senha é guardada criptografada.</span>
        </div>
        {provider === "manual" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div className="field"><label>Host IMAP</label><input name="imapHost" required /></div>
            <div className="field"><label>Porta IMAP</label><input name="imapPort" type="number" defaultValue={993} /></div>
            <div className="field"><label>Host SMTP</label><input name="smtpHost" required /></div>
            <div className="field"><label>Porta SMTP</label><input name="smtpPort" type="number" defaultValue={465} /></div>
          </div>
        )}
        </>)}

        {error && <p style={{ color: "var(--danger)", fontSize: "0.8125rem" }}>{error}</p>}
        <button type="submit" className="btn btn-primary" style={{ width: "100%", marginTop: "0.5rem" }} disabled={saving}>
          {saving ? "Criando..." : shared ? "Criar marca" : "Criar loja e conectar caixa"}
        </button>
      </form>
    </Shell>
  );
}
