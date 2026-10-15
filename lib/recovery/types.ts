// Tipos das tabelas da recuperação de carrinho (migration 0018).
export type RecoveryStatus = "ativo" | "pausado" | "recuperado" | "parado_comprou" | "parado_respondeu" | "parado_descadastrou" | "parado_suprimido" | "substituido" | "concluido_sem_compra";
export type RecoveryChannel = "email" | "whatsapp" | "sms";
export type AgentMode = "agente" | "humano" | "pausado";

export interface RecoveryItem {
  title: string;
  quantity: number;
  variantTitle: string | null;
  sku: string | null;
  productId: string | null;
  variantId: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
  imageUrl: string | null;
}

export interface RecoveryRow {
  id: string;
  store_id: string;
  checkout_id: string;
  checkout_name: string | null;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  locale: string | null;
  language: string | null;
  country_code: string | null;
  city: string | null;
  currency: string | null;
  total: number | string | null;
  subtotal: number | string | null;
  total_discount: number | string | null;
  items: RecoveryItem[];
  discount_codes: string[];
  recovery_url: string;
  email_consent: string | null;
  sms_consent: string | null;
  customer_orders_count: number | null;
  shopify_customer_id: string | null;
  abandoned_at: string;
  shopify_updated_at: string | null;
  completed_at: string | null;
  status: RecoveryStatus;
  step: number;
  next_send_at: string | null;
  email_step: number;
  email_next_at: string | null;
  wa_step: number;
  wa_next_at: string | null;
  agent_mode: AgentMode;
  needs_human: boolean;
  needs_human_reason: string | null;
  waha_session: string | null;
  whatsapp_exists: boolean | null;
  whatsapp_checked_at: string | null;
  first_contact_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  unread_count: number;
  offered_discount_code: string | null;
  offered_discount_percent: number | string | null;
  summary_pt: string | null;
  tags: string[];
  notes: string | null;
  recovered_order_id: string | null;
  recovered_order_name: string | null;
  recovered_at: string | null;
  recovered_amount: number | string | null;
  recovered_currency: string | null;
  recovered_channel: string | null;
  recovered_discount_code: string | null;
  attribution: string | null;
  stop_reason: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecoverySettings {
  store_id: string;
  enabled: boolean;
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
  agent_enabled: boolean;
  test_mode: boolean;
  test_email: string;
  test_phone: string | null;
  require_consent: boolean;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  agent_name: string | null;
  agent_prompt: string | null;
  agent_max_discount: number | string;
  daily_cap_email: number;
  daily_cap_whatsapp: number;
  max_days: number;
  quiet_hours: { start?: number; end?: number; shabbat?: boolean; tz?: string } | null;
  welcome_enabled: boolean;
  welcome_since: string | null;
  welcome_skip_first_if_receipt: boolean;
  contact_url: string | null;
  email_provider: "resend" | "ses" | "activecampaign";
  min_gap_hours: number;
  production_since: string | null; // reinicia a cada saída do modo de teste (corte de lançamento)
  warmup_since?: string | null; // início ORIGINAL da rampa de aquecimento (migration 0019; ausente = coluna não existe ainda)
  send_languages?: string[] | null; // idiomas liberados (migration 0021); null/vazio = todos

  measure_since: string;
  last_sync_at: string | null;
  last_tick_at: string | null;
  updated_at: string;
}

export type RecoveryFlow = "carrinho" | "pos_compra";
export type StepSendIf = "sempre" | "enviado" | "nao_enviado";

export interface RecoveryStep {
  id: string;
  store_id: string;
  flow: RecoveryFlow;
  channel: "email" | "whatsapp";
  position: number;
  send_if: StepSendIf;
  preview: Record<string, string>;
  button: Record<string, string>;
  name: string | null;
  delay_minutes: number;
  only_if_no_reply: boolean;
  discount_percent: number | string | null;
  subject: Record<string, string>;
  // WhatsApp: idioma → variantes; e-mail: idioma → texto/html
  body: Record<string, string | string[]>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface RecoveryDiscount {
  id: string;
  store_id: string;
  code: string;
  percent: number | string;
  combinable: boolean;
  active: boolean;
  shopify_discount_id: string | null;
  note: string | null;
  created_at: string;
}

export interface RecoveryKnowledge {
  id: string;
  store_id: string;
  kind: "script" | "produto" | "objecao" | "preco" | "garantia" | "regra" | "outro";
  title: string;
  content: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WhatsappSessionRow {
  name: string;
  store_id: string | null;
  label: string | null;
  phone: string | null;
  status: string | null;
  me_id: string | null;
  me_name: string | null;
  active: boolean;
  daily_cap: number;
  sent_today: number;
  sent_today_date: string | null;
  last_used_at: string | null;
  restricted_until: string | null;
  alerted_at: string | null;
  last_event_at: string | null;
  detail: unknown;
  updated_at: string;
}

export type PostPurchaseStatus = "ativo" | "pausado" | "concluido" | "parado_cancelado" | "parado_descadastrou" | "parado_suprimido";

export interface PostPurchaseRun {
  id: string;
  store_id: string;
  order_id: string;
  order_name: string | null;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  language: string | null;
  country_code: string | null;
  currency: string | null;
  total: number | string | null;
  items: RecoveryItem[];
  purchased_at: string;
  fulfilled_at: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  tracking_company: string | null;
  financial_status: string | null;
  cancelled_at: string | null;
  status: PostPurchaseStatus;
  step: number;
  next_at: string | null;
  receipt_sent: boolean;
  stop_reason: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecoveryAlert {
  id: string;
  kind: "sessao" | "waha" | "envio" | "humano" | "outro";
  key: string;
  message: string;
  store_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface WhatsappMessageRow {
  id: string;
  session: string;
  chat_id: string;
  phone: string | null;
  direction: "inbound" | "outbound";
  author: "cliente" | "agente" | "humano" | "regua";
  message_id: string | null;
  body: string | null;
  body_pt: string | null;
  has_media: boolean;
  media_url: string | null;
  step: number | null;
  ack: number | null;
  status: string | null;
  error: string | null;
  is_test: boolean;
  recovery_id: string | null;
  raw: unknown;
  sent_at: string | null;
  created_at: string;
}

// Tabela ausente = migration 0018 não rodada. Tudo que depende dela falha
// FECHADO (não envia, não quebra o cron).
export const RECOVERY_MISSING_TABLE = /cart_recoveries|recovery_settings|recovery_events|recovery_steps|recovery_suppressions|recovery_knowledge|recovery_discounts|recovery_alerts|post_purchase_runs|whatsapp_sessions|whatsapp_messages|does not exist|schema cache/i;
