import Sidebar from "@/components/Sidebar";

export default function Shell({ children, full = false }: { children: React.ReactNode; full?: boolean }) {
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">{full ? children : <div className="main-inner">{children}</div>}</main>
    </div>
  );
}
