"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, Inbox, Ticket, ListChecks, FileSignature, Users, BookOpen, Store, LogOut, Moon, Sun, MailCheck, Activity, ShoppingCart } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import Logo from "@/components/Logo";

const NAV_ITEMS = [
  { href: "/", label: "Painel de controle", Icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", Icon: Inbox },
  { href: "/tickets", label: "Tickets", Icon: Ticket },
  { href: "/formularios", label: "Formulários", Icon: FileSignature },
  { href: "/confirmacoes", label: "E-mail de confirmação", Icon: MailCheck },
  { href: "/entregabilidade", label: "Entregabilidade", Icon: Activity },
  { href: "/recuperacao", label: "Recuperação de carrinho", Icon: ShoppingCart },
  // "/contestacoes" e "/pedir-telefone" continuam existindo como página e
  // API, mas fora do menu: o Ian pede direto quando precisar (23/09/2026).
  { href: "/afazer", label: "A fazer (promessas)", Icon: ListChecks },
  { href: "/clientes", label: "CRM de clientes", Icon: Users },
  { href: "/contexto", label: "Contexto com Objeções", Icon: BookOpen },
  { href: "/lojas", label: "Minhas lojas", Icon: Store },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, setPending] = useState<number | null>(null);
  const [tickets, setTickets] = useState(0);
  const [gaps, setGaps] = useState(0);
  const [todo, setTodo] = useState(0);
  const [forms, setForms] = useState(0);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("respondo-theme") === "dark";
      setDark(saved);
      document.documentElement.setAttribute("data-theme", saved ? "dark" : "light");
    } catch {}
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    try { localStorage.setItem("respondo-theme", next ? "dark" : "light"); } catch {}
  }

  useEffect(() => {
    const refresh = () =>
      fetch("/api/counts")
        .then((r) => r.json())
        .then((d) => {
          setPending(d.pending ?? 0);
          setTickets(d.tickets ?? 0);
          setGaps(d.gaps ?? 0);
          setTodo(d.todos ?? 0);
          setForms(d.forms ?? 0);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 60000);
    window.addEventListener("respondo:counts", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("respondo:counts", refresh);
    };
  }, [pathname]);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo />
      </div>
      <nav style={{ display: "flex", flexDirection: "column", gap: "0.125rem", flex: 1 }}>
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={`nav-item${active ? " active" : ""}`}>
              <Icon />
              <span style={{ flex: 1 }}>{label}</span>
              {href === "/inbox" && pending ? <span className="badge badge-accent" title="Aguardando você enviar">{pending}</span> : null}
              {href === "/tickets" && tickets ? <span className="badge badge-danger" title="Casos que precisam de você">{tickets}</span> : null}
              {href === "/formularios" && forms ? <span className="badge badge-warn" title="Formulários aguardando decisão">{forms}</span> : null}
              {href === "/afazer" && todo ? <span className="badge badge-danger" title="Prometido ao cliente e ainda não feito">{todo}</span> : null}
              {href === "/contexto" && gaps ? <span className="badge badge-warn" title="A IA pediu contexto">{gaps}</span> : null}
            </Link>
          );
        })}
      </nav>
      <button type="button" className="nav-item" onClick={toggleTheme} style={{ border: "none", background: "transparent", cursor: "pointer" }}>
        {dark ? <Sun /> : <Moon />}
        {dark ? "Tema claro" : "Tema escuro"}
      </button>
      <button type="button" className="nav-item" onClick={handleLogout} style={{ border: "none", background: "transparent", cursor: "pointer" }}>
        <LogOut />
        Sair
      </button>
    </aside>
  );
}
