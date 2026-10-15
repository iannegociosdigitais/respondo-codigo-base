"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FORM_LANGS, FORM_STRINGS, RTL_LANGS, pickFormLang, type FormLang } from "@/lib/forms/i18n";
import { formatDate, formatMoney, formLocale } from "@/lib/forms/format";
import "./form.css";

interface Order { name: string; date: string; items: string[]; total: string | null; currency: string | null; shown: { amount: number; currency: string } | null; totalLabel: string; country: string | null; city: string | null }

const fmtDate = formatDate;
// valor na moeda do cliente, formatado no idioma que ele está lendo
const money = (o: Order, lang: string) => (o.shown ? formatMoney(o.shown.amount, o.shown.currency, lang) : o.totalLabel);

function SignaturePad({ onChange, clearLabel }: { onChange: (dataUrl: string) => void; clearLabel: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = ref.current!.getContext("2d")!;
    drawing.current = true;
    ref.current!.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext("2d")!;
    const p = pos(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
    dirty.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current) onChange(ref.current!.toDataURL("image/png"));
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    dirty.current = false;
    onChange("");
  };
  return (
    <div>
      <canvas ref={ref} width={880} height={260} className="rf-sign" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerLeave={end} />
      <button type="button" className="rf-btn rf-btn-ghost rf-btn-sm" onClick={clear}>{clearLabel}</button>
    </div>
  );
}

function FormInner() {
  const params = useSearchParams();
  const token = params.get("t") ?? "";
  // Idioma: ?l= no link, depois o do link pessoal (vem da API); sem nenhum dos
  // dois, o do navegador — lido só depois de montar, pra não divergir do servidor.
  const [lang, setLang] = useState<FormLang>(pickFormLang(params.get("l") ?? "en"));
  // o cliente escolheu o idioma na mão: a partir daí ninguém troca por ele
  const userPicked = useRef(Boolean(params.get("l")));
  useEffect(() => {
    if (!params.get("l") && !params.get("t")) setLang(pickFormLang(navigator.language));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const t = FORM_STRINGS[lang];
  const startedAt = useRef(Date.now());

  const [step, setStep] = useState(0);
  const [brand, setBrand] = useState(params.get("p") ?? "");
  const [email, setEmail] = useState("");
  const [emailLocked, setEmailLocked] = useState(false);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [notReceived, setNotReceived] = useState(false);
  const [confirmOrder, setConfirmOrder] = useState(false);
  const [address, setAddress] = useState({ address1: "", address2: "", city: "", state: "", zip: "", country: "" });
  const [description, setDescription] = useState("");
  const [resolution, setResolution] = useState<"" | "reenvio" | "regularizacao">("");
  const [consents, setConsents] = useState({ c1: false, c2: false, c3: false });
  const [signature, setSignature] = useState("");
  const [reference, setReference] = useState("");

  const search = useCallback(async (mail?: string) => {
    setBusy(true); setErr("");
    const r = await fetch("/api/public/solicitacao", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "start", token, email: mail ?? email, language: userPicked.current ? lang : undefined }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(d.error === "token" ? t.invalidLink : t.error); return; }
    if (d.brand) setBrand(d.brand);
    if (d.language && !userPicked.current) setLang(pickFormLang(d.language));
    if (d.emailLocked && d.email) { setEmail(d.email); setEmailLocked(true); }
    setOrders(d.orders ?? []);
    if ((d.orders ?? []).length > 0) {
      const first = d.orders[0] as Order;
      setAddress((a) => ({ ...a, city: a.city || first.city || "", country: a.country || first.country || "" }));
      if (d.orders.length === 1) setPicked([first.name]);
      setStep(1);
    } else {
      setStep(0);
    }
  }, [email, token, lang, t.error, t.invalidLink]);

  // Link pessoal: já abre nos pedidos do cliente.
  useEffect(() => { if (token) search(""); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const chosen = (orders ?? []).filter((o) => picked.includes(o.name));
  const canNext: Record<number, boolean> = {
    1: picked.length > 0,
    2: name.trim().length > 2 && phone.trim().length > 5,
    3: confirmOrder && (notReceived || Boolean(receivedAt)),
    4: Boolean(address.address1.trim() && address.city.trim() && address.zip.trim()),
    5: description.trim().length >= 150,
    6: Boolean(resolution),
    7: consents.c1 && consents.c2 && consents.c3 && Boolean(signature),
  };

  async function submit() {
    setBusy(true); setErr("");
    const r = await fetch("/api/public/solicitacao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "submit", token, email, orders: picked, name, phone, receivedAt, notReceived, address, description, resolution, consents, signature, language: lang, fillSeconds: Math.round((Date.now() - startedAt.current) / 1000) }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok || !d.reference) { setErr(d.error === "required" ? t.required : d.error === "limit" ? t.tooMany : t.error); return; }
    setReference(d.reference);
    setStep(8);
  }

  const progress = step >= 2 && step <= 7 ? Math.round(((step - 1) / 6) * 100) : 0;
  // função comum (não componente): não remonta os botões a cada tecla digitada
  const nav = (onNext: () => void, nextLabel?: string) => (
    <div className="rf-nav">
      <button type="button" className="rf-btn rf-btn-ghost" onClick={() => setStep((s) => Math.max(emailLocked ? 1 : 0, s - 1))}>{t.back}</button>
      <button type="button" className="rf-btn rf-btn-primary" disabled={!canNext[step] || busy} onClick={onNext}>{nextLabel ?? t.next}</button>
    </div>
  );

  return (
    <div className="rf-page" dir={RTL_LANGS.includes(lang) ? "rtl" : "ltr"} lang={lang}>
      <div className="rf-wrap">
        <div className="rf-head">
          <div>
            <div className="rf-brand">{brand || "Support"}</div>
            <div className="rf-sub">{t.subtitle}</div>
          </div>
          <div className="rf-head-side">
            <span className="rf-secure">🛡 {t.secure}</span>
            <select className="rf-lang" aria-label={t.language} value={lang} onChange={(e) => { userPicked.current = true; setLang(pickFormLang(e.target.value)); }}>
              {FORM_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
        </div>
        <div className="rf-trust"><span>🔒 {t.encrypted}</span><span>✔ {t.protectedData}</span><span>◎ {t.verification}</span></div>

        <div className="rf-card">
          {step >= 2 && step <= 7 && (
            <div className="rf-steps">
              {t.steps.map((label, i) => (
                <div key={label} className={`rf-step${i + 2 < step ? " done" : i + 2 === step ? " on" : ""}`}><span>{i + 2 < step ? "✓" : i + 1}</span><em>{label}</em></div>
              ))}
              <div className="rf-bar"><i style={{ width: `${progress}%` }} /></div>
            </div>
          )}

          {step === 0 && (
            <>
              <h1>{t.findTitle}</h1><p className="rf-hint">{t.findHint}</p>
              <label>{t.email} *</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" dir="ltr" onKeyDown={(e) => e.key === "Enter" && email && search()} />
              <p className="rf-small">{t.emailHint}</p>
              <button type="button" className="rf-btn rf-btn-primary rf-full" disabled={!email || busy} onClick={() => search()}>{busy ? t.searching : t.search}</button>
              {orders && orders.length === 0 && <p className="rf-err">{t.noOrders}</p>}
            </>
          )}

          {step === 1 && (
            <>
              <h1>{t.selectTitle}</h1><p className="rf-hint">{t.selectHint}</p>
              {(orders ?? []).map((o) => (
                <button type="button" key={o.name} className={`rf-order${picked.includes(o.name) ? " on" : ""}`} onClick={() => setPicked((p) => (p.includes(o.name) ? p.filter((x) => x !== o.name) : [...p, o.name]))}>
                  <div className="rf-row"><strong>{o.name}</strong><span>{fmtDate(o.date, lang)}</span></div>
                  <div className="rf-items">{o.items.join(" · ")}</div>
                  <div><strong dir="ltr">{money(o, lang)}</strong></div>
                </button>
              ))}
              <div className="rf-nav">
                {!emailLocked && <button type="button" className="rf-btn rf-btn-ghost" onClick={() => setStep(0)}>{t.back}</button>}
                <button type="button" className="rf-btn rf-btn-primary" disabled={!canNext[1]} onClick={() => setStep(2)}>{t.next}</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h1>{t.identityTitle}</h1><p className="rf-hint">{t.identityHint}</p>
              <label>{t.fullName} *</label><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              <label>{t.phone} *</label><input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" />
              {nav(() => setStep(3))}
            </>
          )}

          {step === 3 && (
            <>
              <h1>{t.orderTitle}</h1><p className="rf-hint">{t.orderHint}</p>
              {chosen.map((o) => (
                <div key={o.name} className="rf-order on static">
                  <div className="rf-row"><strong>{o.name}</strong><span>{fmtDate(o.date, lang)}</span></div>
                  <div className="rf-items">{o.items.join(" · ")}</div>
                  <div><strong>{t.total}: <span dir="ltr">{money(o, lang)}</span></strong></div>
                </div>
              ))}
              <label>{t.receivedWhen} *</label>
              <input type="date" value={receivedAt} max={new Date().toISOString().slice(0, 10)} disabled={notReceived} onChange={(e) => setReceivedAt(e.target.value)} />
              <label className="rf-check"><input type="checkbox" checked={confirmOrder} onChange={(e) => setConfirmOrder(e.target.checked)} /> {t.confirmOrder}</label>
              <label className="rf-check"><input type="checkbox" checked={notReceived} onChange={(e) => setNotReceived(e.target.checked)} /> {t.notReceived}</label>
              {nav(() => setStep(4))}
            </>
          )}

          {step === 4 && (
            <>
              <h1>{t.addressTitle}</h1><p className="rf-hint">{t.addressHint}</p>
              <label>{t.address1} *</label><input value={address.address1} onChange={(e) => setAddress({ ...address, address1: e.target.value })} autoComplete="address-line1" />
              <label>{t.address2}</label><input value={address.address2} onChange={(e) => setAddress({ ...address, address2: e.target.value })} autoComplete="address-line2" />
              <div className="rf-grid">
                <div><label>{t.city} *</label><input value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} /></div>
                <div><label>{t.state}</label><input value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} /></div>
                <div><label>{t.zip} *</label><input value={address.zip} onChange={(e) => setAddress({ ...address, zip: e.target.value })} /></div>
                <div><label>{t.country}</label><input value={address.country} onChange={(e) => setAddress({ ...address, country: e.target.value })} /></div>
              </div>
              {nav(() => setStep(5))}
            </>
          )}

          {step === 5 && (
            <>
              <h1>{t.whatTitle}</h1><p className="rf-hint">{t.whatHint}</p>
              <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t.whatPlaceholder} />
              <p className={`rf-small${description.trim().length < 150 ? " rf-warn" : ""}`}>{description.trim().length}/150 · {t.minChars}</p>
              {nav(() => setStep(6))}
            </>
          )}

          {step === 6 && (
            <>
              <h1>{t.resolveTitle}</h1><p className="rf-hint">{t.resolveHint}</p>
              <button type="button" className={`rf-order${resolution === "reenvio" ? " on" : ""}`} onClick={() => setResolution("reenvio")}><strong>{t.optResend}</strong><div className="rf-items">{t.optResendHint}</div></button>
              <button type="button" className={`rf-order${resolution === "regularizacao" ? " on" : ""}`} onClick={() => setResolution("regularizacao")}><strong>{t.optSettle}</strong><div className="rf-items">{t.optSettleHint}</div></button>
              {nav(() => setStep(7))}
            </>
          )}

          {step === 7 && (
            <>
              <h1>{t.confirmTitle}</h1><p className="rf-hint">{t.confirmHint}</p>
              {(["c1", "c2", "c3"] as const).map((k) => (
                <label key={k} className="rf-check"><input type="checkbox" checked={consents[k]} onChange={(e) => setConsents({ ...consents, [k]: e.target.checked })} /> {t[k]}</label>
              ))}
              <label>{t.signature} *</label>
              <SignaturePad onChange={setSignature} clearLabel={t.clear} />
              {nav(submit, busy ? t.sending : t.submit)}
            </>
          )}

          {step === 8 && (
            <div className="rf-done">
              <div className="rf-ok">✓</div>
              <h1>{t.doneTitle}</h1><p className="rf-hint">{t.doneText}</p>
              <div className="rf-ref"><small>{t.reference}</small><strong>{reference}</strong></div>
              <div className="rf-receipt">
                <p><strong>{brand}</strong> · {t.subtitle} · {reference} · {new Date().toLocaleString(formLocale(lang))}</p>
                <p>{name} · {email} · {phone}</p>
                <p>{chosen.map((o) => `${o.name} (${money(o, lang)})`).join(", ")}</p>
                <p>{[address.address1, address.address2, address.zip, address.city, address.state, address.country].filter(Boolean).join(", ")}</p>
                <p>{notReceived ? t.notReceived : `${t.receivedWhen} ${receivedAt ? fmtDate(receivedAt, lang) : ""}`}</p>
                <p>{resolution === "reenvio" ? t.optResend : t.optSettle}</p>
                <p>{description}</p>
                {signature && <img src={signature} alt="signature" />}
              </div>
              <button type="button" className="rf-btn rf-btn-primary" onClick={() => window.print()}>⬇ {t.download}</button>
            </div>
          )}

          {err && <p className="rf-err">{err}</p>}
        </div>
        <p className="rf-foot">🔒 SSL 256-bit · GDPR · Anti-fraud<br />© {new Date().getFullYear()} {brand || "Support"} · {t.footer}</p>
      </div>
    </div>
  );
}

export default function SolicitacaoPage() {
  return (
    <Suspense>
      <FormInner />
    </Suspense>
  );
}
