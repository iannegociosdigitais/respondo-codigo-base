// Marca do Email Optimizer: balão de fala com seta de resposta.
export function LogoMark({ size = 24, light = false }: { size?: number; light?: boolean }) {
  const bg = light ? "#ffffff" : "#4f46e5";
  const fg = light ? "#4f46e5" : "#ffffff";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill={bg} />
      <path d="M8.5 9.5h15a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H14l-4.5 3.5V21.5H8.5A2.5 2.5 0 0 1 6 19v-7a2.5 2.5 0 0 1 2.5-2.5Z" fill={fg} fillOpacity="0.95" />
      <path d="M15.5 12.5 12 15.5l3.5 3v-2c2.6 0 4.4.7 5.5 2.5-.4-3.2-2.2-5-5.5-5v-1.5Z" fill={bg} />
    </svg>
  );
}

export default function Logo({ light = false, size = 24 }: { light?: boolean; size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", fontWeight: 700, fontSize: "1.0625rem", color: light ? "#fff" : "inherit", letterSpacing: "-0.01em" }}>
      <LogoMark size={size} light={light} />
      Email Optimizer
    </span>
  );
}
