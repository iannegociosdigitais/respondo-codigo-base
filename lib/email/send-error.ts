// Erro de envio de e-mail de marketing com a classificação que o motor usa
// para decidir entre RETENTAR e NÃO RETENTAR o passo:
//
//  - definitivo (ambiguous = false): o provedor recusou ANTES de aceitar a
//    mensagem (4xx, credencial, restrição, validação, conexão que nem abriu).
//    Nada saiu: liberar a trava e tentar de novo é seguro.
//  - ambíguo (ambiguous = true): timeout, abort, 5xx ou resposta perdida DEPOIS
//    de conectar. O provedor pode ter aceitado e enviado. Reenviar pode
//    duplicar o e-mail para o cliente: o motor mantém a trava, não retenta,
//    avança o passo e levanta um alerta.
//
//  - cota/limite (quota = true, sempre definitivo): o provedor recusou por
//    cota diária/mensal ou limite de taxa (HTTP 429). A culpa não é do
//    destinatário nem do passo: o motor libera a trava SEM contar tentativa,
//    não avança e segura os e-mails da loja por 60 min.
export class SendError extends Error {
  public quota: boolean;
  constructor(message: string, public ambiguous: boolean, public status?: number, quota?: boolean) {
    super(message);
    this.name = "SendError";
    this.quota = quota ?? status === 429;
  }
}

// Códigos de rede em que a conexão nem chegou a abrir (nada foi enviado).
const NOT_CONNECTED = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

// Falha do fetch/SDK sem resposta HTTP: ambígua, exceto quando o código de
// rede prova que a conexão não abriu.
export function networkErrorAmbiguous(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && NOT_CONNECTED.has(code)) return false;
    cur = (cur as { cause?: unknown }).cause;
  }
  return true;
}
