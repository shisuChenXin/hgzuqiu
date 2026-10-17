// 用户角色类型
export type UserRole = 'admin' | 'agent' | 'staff';
// 白标 / 租户与下注选择映射类型
export type SelectionMappingMode = 'identity' | 'inverse';

export interface Whitelabel {
  id: number;
  name: string;
  domain: string;
  status: 'active' | 'disabled';
  is_default: boolean;
  owner_user_id?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface WhitelabelListItem extends Whitelabel {
  mapping_mode: SelectionMappingMode;
  mapping_enabled: boolean;
  mapping_version: number;
  user_count: number;
}

export interface WhitelabelUser {
  id: number;
  username: string;
  email: string | null;
  role: UserRole;
  created_at: string;
}

export interface SelectionMappingSettings {
  id: number;
  whitelabel_id: number;
  mapping_mode: SelectionMappingMode;
  enabled: boolean;
  version: number;
  updated_by?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface SelectionMappingAuditLog {
  id: number;
  whitelabel_id: number;
  from_mode: SelectionMappingMode;
  to_mode: SelectionMappingMode;
  from_enabled: boolean;
  to_enabled: boolean;
  from_version: number;
  to_version: number;
  operator_user_id?: number | null;
  operator_username?: string | null;
  reason?: string | null;
  created_at: string;
}

export interface SelectionMappingSnapshot {
  whitelabel_id: number;
  mapping_mode: SelectionMappingMode;
  mapping_enabled?: boolean;
  mapping_version: number;
  mapping_applied: boolean;
  displayed_market_side?: 'home' | 'away' | 'draw' | 'over' | 'under' | null;
  executed_market_side?: 'home' | 'away' | 'draw' | 'over' | 'under' | null;
  displayed_market_rtype?: string | null;
  executed_market_rtype?: string | null;
  displayed_market_chose_team?: 'H' | 'C' | 'N' | null;
  executed_market_chose_team?: 'H' | 'C' | 'N' | null;
}


// 用户认证相关类型
export interface User {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  parent_id?: number;
  agent_id?: number;
  whitelabel_id?: number;
  credit_limit?: number;  // 信用额度（皇冠账号余额总和）
  created_at: string;
  updated_at: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  verificationCode?: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: User;
  message?: string;
  error?: string;
  requireEmailBinding?: boolean;
  requireVerification?: boolean;
  userId?: number;
  email?: string;
}

// 分组类型
export interface Group {
  id: number;
  user_id: number;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface GroupCreateRequest {
  name: string;
  description?: string;
}

// 初始化类型
export type InitType = 'none' | 'password_only' | 'full';

// 皇冠账号类型
export interface CrownAccount {
  id: number;
  user_id: number;
  group_id: number;
  group_name?: string;
  agent_id?: number;
  owner_username?: string;
  username: string;
  password: string;
  passcode?: string;
  display_name: string;
  original_username?: string;        // 原始账号（首次登录时的账号）
  initialized_username?: string;     // 修改后的账号（初始化后使用的账号）
  init_type: InitType;               // 初始化类型：none-不初始化, password_only-仅改密码, full-完整初始化
  game_type: string;
  source: string;
  currency: string;
  discount: number;
  note: string;
  stop_profit_limit?: number;
  device_type: string;
  balance?: number; // 余额（从皇冠拉取并回写）
  credit?: number; // 信用额度（从皇冠拉取并回写）

  // 代理设置
  proxy_enabled: boolean;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: number;
  proxy_username?: string;
  proxy_password?: string;

  // 限额设置
  football_prematch_limit: number;
  football_live_limit: number;
  basketball_prematch_limit: number;
  basketball_live_limit: number;

  // 状态字段
  is_enabled: boolean;
  is_online?: boolean;
  status?: string;
  last_login?: string;
  use_for_fetch?: boolean; // 是否用于赛事抓取
  limits_data?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface CrownAccountCreateRequest {
  group_id: number;
  username: string;
  password: string;
  passcode?: string;
  display_name?: string;
  original_username?: string;
  initialized_username?: string;
  init_type?: InitType;
  game_type?: string;
  source?: string;
  currency?: string;
  discount?: number;
  stop_profit_limit?: number;
  note?: string;
  device_type?: string;
  proxy_enabled?: boolean;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: number;
  proxy_username?: string;
  proxy_password?: string;
  football_prematch_limit?: number;
  football_live_limit?: number;
  basketball_prematch_limit?: number;
  basketball_live_limit?: number;
  limits_data?: Record<string, any>;
}

export interface AccountSelectionEntry {
  account: {
    id: number;
    group_id: number;
    group_name?: string;
    username: string;
    display_name?: string;
    original_username?: string;
    initialized_username?: string;
    currency?: string;
    discount?: number;
    stop_profit_limit: number;
    line_key: string;
    is_online: boolean;
  };
  stats: {
    daily_effective_amount: number;
    daily_profit: number;
    weekly_profit: number;
    loss_bucket: number;
  };
  flags: {
    stop_profit_reached: boolean;
    line_conflicted: boolean;
    offline?: boolean;
  };
}

export interface AccountSelectionResponse {
  generated_at: string;
  daily_boundary: string;
  weekly_boundary: string;
  match_id?: number;
  total_accounts: number;
  eligible_accounts: AccountSelectionEntry[];
  excluded_accounts: AccountSelectionEntry[];
}

// 比赛类型
export interface Match {
  id: number;
  match_id: string;
  gid?: string;  // WSS 推送数据的皇冠比赛 ID
  league_name: string;
  home_team: string;
  away_team: string;
  match_time: string;
  status: 'scheduled' | 'live' | 'finished' | 'cancelled';
  current_score?: string;
  home_redcard?: number;
  away_redcard?: number;
  match_period?: string;
  markets?: any;
  crown_gid?: string | null;
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
}

// 下注类型
export interface Bet {
  id: number;
  user_id: number;
  user_username?: string;
  account_id: number;
  account_username?: string;
  account_display_name?: string;
  match_id: number;
  league_name?: string;
  home_team?: string;
  away_team?: string;
  current_score?: string;
  bet_type: string;
  bet_option: string;
  bet_amount: number;
  virtual_bet_amount?: number;
  odds: number;
  official_odds?: number;
  market_category?: 'moneyline' | 'handicap' | 'overunder';
  market_scope?: 'full' | 'half';
  whitelabel_id?: number | null;
  market_side?: 'home' | 'away' | 'draw' | 'over' | 'under';
  displayed_market_side?: 'home' | 'away' | 'draw' | 'over' | 'under';
  executed_market_side?: 'home' | 'away' | 'draw' | 'over' | 'under';
  displayed_market_rtype?: string;
  executed_market_rtype?: string;
  displayed_market_chose_team?: 'H' | 'C' | 'N';
  executed_market_chose_team?: 'H' | 'C' | 'N';
  mapping_mode?: SelectionMappingMode;
  mapping_version?: number;
  mapping_applied?: boolean;
  market_line?: string;
  market_index?: number;
  market_wtype?: string;
  market_rtype?: string;
  market_chose_team?: 'H' | 'C' | 'N';
  single_limit: number;
  interval_seconds: number;
  quantity: number;
  status: 'pending' | 'confirmed' | 'settled' | 'cancelled';
  result?: string;
  result_score?: string;
  result_text?: string;
  payout?: number;
  profit_loss?: number;
  virtual_profit_loss?: number;
  score?: string;
  official_bet_id?: string;
  error_message?: string;
  confirmed_at?: string;
  settled_at?: string;
  created_at: string;
  updated_at: string;
}

export interface BetCreateResponse {
  total: number;
  queued: number;
  processing?: number;
  cancelled?: number;
  bet_ids?: number[];
  selection_mapping?: SelectionMappingSnapshot;
}

export interface BetCreateRequest {
  idempotency_key?: string; // 客户端请求级幂等键；未携带时保持旧兼容行为
  account_ids: number[];
  match_id?: number;
  bet_type: string;
  bet_option: string;
  total_amount: number;  // 总金额（实数）
  odds: number;
  single_limit?: string;  // 单笔限额（虚数），格式如 "10000-14000" 或留空
  interval_range?: string;  // 间隔时间范围（秒），格式如 "3-15"
  quantity?: number;  // 参与下注的账号数量
  min_odds?: number;  // 最低赔率
  crown_match_id?: string;
  league_name?: string;
  home_team?: string;
  away_team?: string;
  match_time?: string;
  match_status?: string;
  current_score?: string;
  match_period?: string;
  market_category?: 'moneyline' | 'handicap' | 'overunder';
  market_scope?: 'full' | 'half';
  market_side?: 'home' | 'away' | 'draw' | 'over' | 'under';
  market_line?: string;
  market_index?: number;
  market_wtype?: string;
  market_rtype?: string;
  market_chose_team?: 'H' | 'C' | 'N';
  dry_run?: boolean;
}

// 金币交易类型
export interface CoinTransaction {
  id: number;
  user_id: number;
  account_id?: number;
  account_username?: string;
  account_display_name?: string;
  bet_id?: number;
  transaction_id: string;
  transaction_type: string;
  description: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  created_at: string;
}

export interface AliasRecord {
  id: number;
  canonical_key: string;
  name_en?: string;
  name_zh_cn?: string;
  name_zh_tw?: string;
  name_crown_zh_cn?: string;
  aliases: string[];
  created_at: string;
  updated_at: string;
}

// API响应类型
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

// 统计类型
export interface BetStats {
  total_bets: number;
  settled_bets: number;
  pending_bets: number;
  cancelled_bets: number;
  total_amount: number;
  total_profit_loss: number;
  total_payout: number;
  win_rate: string;
}

export interface CoinStats {
  current_balance: number;
  transaction_summary: {
    [key: string]: {
      count: number;
      total_amount: number;
    };
  };
}

// 页面状态类型
export interface TablePagination {
  current: number;
  pageSize: number;
  total: number;
}

export interface TableFilters {
  [key: string]: any;
}

// 员工管理相关类型
export interface StaffCreateRequest {
  username: string;
  email: string;
  password: string;
}

export interface StaffUpdateRequest {
  username?: string;
  email?: string;
  password?: string;
}
