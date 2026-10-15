// Estado do chargeback guardado em conversations.analysis.chargeback.
export interface ChargebackOrder {
  name: string; // "#2847"
  opened_at: string | null;
  amount?: string | null;
  currency?: string | null;
  created_at?: string | null;
}

export interface ChargebackState {
  orders: ChargebackOrder[];
  // quantos e-mails da sequência JÁ foram enviados (0 = nenhum, 3 = sequência completa)
  step: number;
  first_sent_at: string | null;
  last_sent_at: string | null;
  resolved_at?: string | null;
  source?: string;
}

// Dias, contados do PRIMEIRO envio, em que saem o 2º e o 3º e-mail.
export const FOLLOWUP_AFTER_DAYS = [0, 1, 3];
