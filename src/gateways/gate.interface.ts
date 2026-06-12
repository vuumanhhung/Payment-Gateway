export enum GateType {
  MBBANK = 'MBBANK',
  ACBBANK = 'ACBBANK',
  TPBANK = 'TPBANK',
  VCBBANK = 'VCBBANK',
  TRON_USDT_BLOCKCHAIN = 'TRON_USDT_BLOCKCHAIN',
  BEP20_USDT_BLOCKCHAIN = 'BEP20_USDT_BLOCKCHAIN',
}

export const DEFAULT_VCB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.56 Safari/537.36';

export interface Payment {
  transaction_id: string;
  content: string;
  amount: number;
  date: Date;
  gate: GateType;
  account_receiver: string;
}

export interface GateConfig {
  name: string;
  type: GateType;
  enabled?: boolean;
  password?: string;
  login_id?: string;
  account: string;
  account_name?: string;
  bank_id?: string;
  token?: string;
  repeat_interval_in_sec: number;
  proxy?: string;
  device_id?: string;
  user_agent?: string;
  get_transaction_day_limit: number;
  get_transaction_count_limit: number;
}
