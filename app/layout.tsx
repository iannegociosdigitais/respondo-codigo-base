import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Email Optimizer",
  description: "Atendimento por e-mail com contexto real das suas lojas",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("respondo-theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
