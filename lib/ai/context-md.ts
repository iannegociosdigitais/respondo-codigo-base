import { parseContext, serializeContext, CONTEXT_TYPES, TOPICS } from "@/lib/ai/context-meta";

// Exportar/importar o contexto como um único .md editável fora da plataforma.
export interface MdBlock {
  label: string;
  produto: string | null;
  content: string; // cabeçalho (tipo/temas/…) + '---' + texto, sem a linha produto
}

export const MD_GUIDE = `<!--
COMO ORGANIZAR (a IA lê exatamente isto):
- Cada bloco começa com "## Título". Um assunto por bloco, texto direto, no imperativo ("Responder…", "Nunca…").
- Linhas opcionais logo abaixo do título, depois uma linha '---' e o texto:
    tipo: ${CONTEXT_TYPES.join(" | ")}
    produto: nome exato do produto (vazio = vale pra loja inteira)
    temas: ${TOPICS.join(", ")}
    fases: 1, 2, 3, 4
    idiomas: fr, he, tr   (só entra pra clientes nesses idiomas)
    palavras: palavras que o CLIENTE usa, em qualquer idioma (krem, colis, where is my order)
- tipo base/idioma/loja/prazo/produto entram em TODA resposta daquele produto.
  objecao/politica/fase entram quando o tema, a fase ou as palavras do e-mail batem.
- Contextos base de todo produto: idioma e persona · informações do produto · informações da loja ·
  consulta do pedido · prazos de entrega. Depois: contestação/chargeback, devolução, assinatura, etc.
-->`;

export function exportMd(storeName: string, blocks: Array<{ label: string; content: string; productName: string | null }>): string {
  const parts = blocks.map((b) => {
    const { meta, body } = parseContext(b.content);
    const head = serializeContext(meta, "").replace(/\n---\n?$/, "").trim();
    const lines = [`## ${b.label}`, b.productName ? `produto: ${b.productName}` : "", head].filter(Boolean);
    return `${lines.join("\n")}\n---\n${body}\n`;
  });
  return `# Contexto · ${storeName}\n\n${MD_GUIDE}\n\n${parts.join("\n")}`;
}

export function isStructuredMd(text: string): boolean {
  return /^##\s+\S/m.test(text);
}

export function importMd(text: string): MdBlock[] {
  const clean = text.replace(/<!--[\s\S]*?-->/g, "");
  const chunks = clean.split(/^##\s+/m).slice(1);
  const out: MdBlock[] = [];
  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    const label = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    let rest = nl === -1 ? "" : chunk.slice(nl + 1);
    let produto: string | null = null;
    rest = rest.replace(/^\s*produto\s*:\s*(.*)$/im, (_m, v: string) => {
      produto = v.trim() || null;
      return "";
    });
    const content = rest.replace(/^\s*\n/, "").trim();
    if (label && content) out.push({ label: label.slice(0, 120), produto, content });
  }
  return out;
}
