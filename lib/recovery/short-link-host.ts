// Sem dependências (o middleware importa isto): base e host dos links curtos.
// Env: SHORT_LINK_BASE_URL (ex.: https://go.skininsiderdaily.com).
export const shortLinkBase = () => (process.env.SHORT_LINK_BASE_URL ?? "").trim().replace(/\/+$/, "");
export const shortLinkHost = () => {
  try {
    return shortLinkBase() ? new URL(shortLinkBase()).host.toLowerCase() : "";
  } catch {
    return "";
  }
};
export const SHORT_CODE_RE = /^[A-Za-z0-9]{7}$/;
