// Verificação do endereço na caixa do provedor (QuickEmailVerification),
// UMA vez por carrinho, antes do 1º e-mail de marketing. Plano grátis: 100
// verificações por dia (o carrinho em hebraico gira em ~20/dia).
//
// Bloqueia só o que é certeza de problema: result = invalid (caixa não existe,
// domínio inválido) ou endereço descartável. "unknown" e "accept_all"
// (comum no walla, que aceita tudo) seguem: a checagem de erro de digitação e
// de MX (address-check.ts) já rodou antes.
// Sem chave, cota esgotada (402/429), timeout ou erro: null = segue sem
// verificar (nunca trava a régua por causa do verificador).
//
// Env: QEV_API_KEY.

export interface VerifyVerdict {
  block: boolean;
  result: string; // valid | invalid | unknown
  reason: string;
  didYouMean: string | null;
}

export const qevConfigured = () => Boolean(process.env.QEV_API_KEY?.trim());

export async function verifyEmailAddress(email: string | null | undefined): Promise<VerifyVerdict | null> {
  const key = process.env.QEV_API_KEY?.trim();
  const addr = String(email ?? "").trim().toLowerCase();
  if (!key || !addr) return null;
  try {
    const res = await fetch(`https://api.quickemailverification.com/v1/verify?email=${encodeURIComponent(addr)}&apikey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (!res.ok) return null; // 402 sem crédito, 429 limite, 401 chave: segue sem verificar
    const d = (await res.json()) as { success?: string; result?: string; reason?: string; disposable?: string; did_you_mean?: string };
    if (String(d.success) !== "true") return null;
    const result = String(d.result ?? "unknown");
    const disposable = String(d.disposable) === "true";
    return { block: result === "invalid" || disposable, result, reason: disposable ? "disposable" : String(d.reason ?? ""), didYouMean: d.did_you_mean ? String(d.did_you_mean) : null };
  } catch {
    return null;
  }
}
