import axios from 'axios';
import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
  User,
  LoginRequest,
  RegisterRequest,
  AuthResponse,
  Group,
  GroupCreateRequest,
  CrownAccount,
  CrownAccountCreateRequest,
  Match,
  Bet,
  BetCreateResponse,
  BetCreateRequest,
  CoinTransaction,
  ApiResponse,
  BetStats,
  CoinStats,
  AccountSelectionResponse,
  StaffCreateRequest,
  StaffUpdateRequest,
  AliasRecord,
  Whitelabel,
  WhitelabelListItem,
  WhitelabelUser,
  SelectionMappingSettings,
  SelectionMappingAuditLog,
  SelectionMappingMode,
} from '../types';

// 创建axios实例
const resolveBaseURL = (): string => {
  const raw = String((import.meta.env as any).VITE_API_URL ?? '').trim();
  if (raw) {
    // 允许配置成：
    // - "/api"（推荐）
    // - "http://localhost:3001/api"
    // 也兼容误配置成 "http://localhost:3001"（自动补 /api，避免 404）
    const ensureLeadingSlash = (value: string) => {
      if (/^https?:\/\//i.test(value)) return value;
      if (value.startsWith('/')) return value;
      return `/${value}`;
    };

    const normalized = ensureLeadingSlash(raw).replace(/\/+$/, '');
    const hasApiPath = /\/api(\/|$)/.test(normalized);
    return hasApiPath ? normalized : `${normalized}/api`;
  }

  // 本地开发时默认走同源代理，避免直接命中前端 dev server 返回 404
  // 生产环境也使用相对路径 /api，由 nginx 反向代理
  return '/api';
};

const baseURL = resolveBaseURL();

const resolveWhitelabelDomain = (): string | null => {
  const fromEnv = String((import.meta.env as any).VITE_WHITELABEL_DOMAIN ?? '').trim();
  const fromStorage = String(localStorage.getItem('whitelabelDomain') ?? '').trim();
  return (fromEnv || fromStorage) || null;
};

if (import.meta.env.DEV) {
  console.info('[API] Using base URL:', baseURL);
}

const apiClient: AxiosInstance = axios.create({
  baseURL,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
});


// 请求拦截器 - 添加token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    const hasToken = !!(token && token.trim().length > 0);
    if (hasToken) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    const whitelabelDomain = resolveWhitelabelDomain();
    if (whitelabelDomain) {
      config.headers['x-whitelabel-domain'] = whitelabelDomain;
    }
    if (import.meta.env.DEV) {
      console.log('[API] request', {
        method: config.method,
        url: (config.baseURL || '') + (config.url || ''),
        hasToken,
      });
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器 - 处理错误
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// 认证API
export const authApi = {
  // 用户注册
  register: (data: RegisterRequest): Promise<AuthResponse> =>
    apiClient.post('/auth/register', data).then(res => {
      const { success, message, error, data: payload } = res.data;
      return {
        success,
        message,
        error,
        token: payload?.token,
        user: payload?.user,
      } as AuthResponse;
    }),

  // 用户登录
  login: (data: LoginRequest): Promise<AuthResponse> =>
    apiClient.post('/auth/login', data).then(res => {
      const { success, message, error, data: payload } = res.data;
      return {
        success,
        message,
        error,
        token: payload?.token,
        user: payload?.user,
      } as AuthResponse;
    }),

  // 获取当前用户信息
  getCurrentUser: (): Promise<ApiResponse<User>> =>
    apiClient.get('/auth/me').then(res => res.data),

  // 修改密码
  changePassword: (data: { oldPassword: string; newPassword: string }): Promise<ApiResponse> =>
    apiClient.post('/auth/change-password', data).then(res => res.data),
};

// 代理管理API（超级管理员使用）
export const agentApi = {
  // 获取代理列表
  getAgentList: (): Promise<ApiResponse<User[]>> =>
    apiClient.get('/agents').then(res => res.data),

  // 获取单个代理信息
  getAgent: (userId: number): Promise<ApiResponse<User>> =>
    apiClient.get(`/agents/${userId}`).then(res => res.data),

  // 创建代理账号
  createAgent: (data: StaffCreateRequest): Promise<ApiResponse<User>> =>
    apiClient.post('/agents', data).then(res => res.data),

  // 更新代理信息
  updateAgent: (userId: number, data: StaffUpdateRequest): Promise<ApiResponse<User>> =>
    apiClient.put(`/agents/${userId}`, data).then(res => res.data),

  // 删除代理账号
  deleteAgent: (userId: number): Promise<ApiResponse> =>
    apiClient.delete(`/agents/${userId}`).then(res => res.data),
};

// 员工管理API（代理使用）
export const staffApi = {
  // 获取员工列表
  getStaffList: (): Promise<ApiResponse<User[]>> =>
    apiClient.get('/staff').then(res => res.data),

  // 获取单个员工信息
  getStaff: (userId: number): Promise<ApiResponse<User>> =>
    apiClient.get(`/staff/${userId}`).then(res => res.data),

  // 创建员工账号
  createStaff: (data: StaffCreateRequest): Promise<ApiResponse<User>> =>
    apiClient.post('/staff', data).then(res => res.data),

  // 更新员工信息
  updateStaff: (userId: number, data: StaffUpdateRequest): Promise<ApiResponse<User>> =>
    apiClient.put(`/staff/${userId}`, data).then(res => res.data),

  // 删除员工账号
  deleteStaff: (userId: number): Promise<ApiResponse> =>
    apiClient.delete(`/staff/${userId}`).then(res => res.data),
};

// 分组API
export const groupApi = {
  // 获取分组列表
  getGroups: (): Promise<ApiResponse<Group[]>> =>
    apiClient.get('/groups').then(res => res.data),

  // 创建分组
  createGroup: (data: GroupCreateRequest): Promise<ApiResponse<Group>> =>
    apiClient.post('/groups', data).then(res => res.data),

  // 更新分组
  updateGroup: (id: number, data: GroupCreateRequest): Promise<ApiResponse<Group>> =>
    apiClient.put(`/groups/${id}`, data).then(res => res.data),

  // 删除分组
  deleteGroup: (id: number): Promise<ApiResponse> =>
    apiClient.delete(`/groups/${id}`).then(res => res.data),
};

// 账号API
export const accountApi = {
  // 获取账号列表
  getAccounts: (groupId?: number): Promise<ApiResponse<CrownAccount[]>> =>
    apiClient.get('/accounts', { params: { group_id: groupId } }).then(res => res.data),

  // 创建账号
  createAccount: (data: CrownAccountCreateRequest): Promise<ApiResponse<CrownAccount>> =>
    apiClient.post('/accounts', data).then(res => res.data),

  // 更新账号
  updateAccount: (id: number, data: Partial<CrownAccountCreateRequest & { is_enabled?: boolean }>): Promise<ApiResponse<CrownAccount>> =>
    apiClient.put(`/accounts/${id}`, data).then(res => res.data),

  // 删除账号
  deleteAccount: (id: number): Promise<ApiResponse> =>
    apiClient.delete(`/accounts/${id}`).then(res => res.data),

  // 批量更新账号状态
  batchUpdateStatus: (accountIds: number[], isEnabled: boolean): Promise<ApiResponse> =>
    apiClient.post('/accounts/batch-update-status', {
      account_ids: accountIds,
      is_enabled: isEnabled
    }).then(res => res.data),

  // 账号优选
  autoSelect: (params?: { match_id?: number; limit?: number; group_id?: number }): Promise<ApiResponse<AccountSelectionResponse>> =>
    apiClient.get('/accounts/auto-select', { params }).then(res => res.data),

  // 获取账号限额
  fetchLimits: (accountId: number): Promise<ApiResponse<{
    football: { prematch: number; live: number };
    basketball: { prematch: number; live: number };
  }>> =>
    apiClient.post(`/crown-automation/fetch-limits/${accountId}`).then(res => res.data),
};

// 比赛API
export const matchApi = {
  // 获取比赛列表
  getMatches: (params?: { status?: string; league?: string; limit?: number; offset?: number }): Promise<ApiResponse<Match[]>> =>
    apiClient.get('/matches', { params }).then(res => res.data),

  // 获取比赛详情
  getMatch: (id: number): Promise<ApiResponse<Match>> =>
    apiClient.get(`/matches/${id}`).then(res => res.data),

  // 获取热门比赛
  getHotMatches: (): Promise<ApiResponse<Match[]>> =>
    apiClient.get('/matches/hot/list').then(res => res.data),

  // 搜索比赛
  searchMatches: (keyword: string, limit?: number): Promise<ApiResponse<Match[]>> =>
    apiClient.get(`/matches/search/${keyword}`, { params: { limit } }).then(res => res.data),
};

// 下注API
export const betApi = {
  // 获取下注记录
  getBets: (params?: {
    status?: string;
    date?: string;
    account_id?: number;
    limit?: number;
    offset?: number;
  }): Promise<ApiResponse<{ bets: Bet[]; stats: BetStats }>> =>
    apiClient.get('/bets', { params }).then(res => res.data),

  // 获取下注统计
  getStats: (params?: {
    start_date?: string;
    end_date?: string;
    user_id?: number;
    account_id?: string;
  }): Promise<ApiResponse<any>> =>
    apiClient.get('/bets/stats', { params }).then(res => res.data),

  // 创建下注
  createBet: (data: BetCreateRequest): Promise<ApiResponse<BetCreateResponse>> =>
    apiClient.post('/bets', data).then(res => res.data),

  // 更新下注状态
  updateBetStatus: (id: number, data: {
    status: string;
    result?: string;
    payout?: number;
    official_bet_id?: string;
  }): Promise<ApiResponse<Bet>> =>
    apiClient.put(`/bets/${id}/status`, data).then(res => res.data),

  // 同步下注结算结果
  syncSettlements: (accountIds?: number[]): Promise<ApiResponse<any>> =>
    apiClient
      .post('/bets/sync-settlements', accountIds && accountIds.length ? { account_ids: accountIds } : {})
      .then(res => res.data),
};

// 白标 / 租户与选择映射API（管理员）
export const whitelabelApi = {
  getWhitelabels: (): Promise<ApiResponse<WhitelabelListItem[]>> =>
    apiClient.get('/whitelabels').then(res => res.data),

  createWhitelabel: (data: {
    name: string;
    domain: string;
    owner_user_id?: number | null;
  }): Promise<ApiResponse<Whitelabel>> =>
    apiClient.post('/whitelabels', data).then(res => res.data),

  updateWhitelabel: (
    id: number,
    data: { name?: string; domain?: string; status?: 'active' | 'disabled'; owner_user_id?: number | null }
  ): Promise<ApiResponse<Whitelabel>> =>
    apiClient.put(`/whitelabels/${id}`, data).then(res => res.data),

  getWhitelabelUsers: (id: number): Promise<ApiResponse<WhitelabelUser[]>> =>
    apiClient.get(`/whitelabels/${id}/users`).then(res => res.data),

  assignUsers: (id: number, userIds: number[]): Promise<ApiResponse<{ assigned: number }>> =>
    apiClient.post(`/whitelabels/${id}/users`, { user_ids: userIds }).then(res => res.data),

  getMappingSettings: (id: number): Promise<ApiResponse<SelectionMappingSettings>> =>
    apiClient.get(`/whitelabels/${id}/mapping`).then(res => res.data),

  updateMappingSettings: (
    id: number,
    data: { mode: SelectionMappingMode; enabled: boolean; reason?: string }
  ): Promise<ApiResponse<SelectionMappingSettings>> =>
    apiClient.put(`/whitelabels/${id}/mapping`, data).then(res => res.data),

  getMappingAuditLogs: (id: number, limit = 100): Promise<ApiResponse<SelectionMappingAuditLog[]>> =>
    apiClient.get(`/whitelabels/${id}/mapping/audit`, { params: { limit } }).then(res => res.data),
};

// 金币API
export const coinApi = {
  // 获取金币流水
  getTransactions: (params?: {
    type?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    offset?: number;
  }): Promise<ApiResponse<{ transactions: CoinTransaction[]; stats: CoinStats }>> =>
    apiClient.get('/coins', { params }).then(res => res.data),

  // 创建金币交易
  createTransaction: (data: {
    transaction_type: string;
    amount: number;
    description: string;
    account_id?: number;
  }): Promise<ApiResponse<CoinTransaction>> =>
    apiClient.post('/coins', data).then(res => res.data),

  // 获取余额
  getBalance: (): Promise<ApiResponse<{ balance: number; currency: string }>> =>
    apiClient.get('/coins/balance').then(res => res.data),

  // 获取指定用户的余额
  getUserBalance: (userId: number): Promise<ApiResponse<{ balance: number; currency: string }>> =>
    apiClient.get(`/coins/balance/${userId}`).then(res => res.data),

  // 获取分析数据
  getAnalytics: (period?: string): Promise<ApiResponse<{
    period: string;
    daily_stats: any[];
    summary: any;
  }>> =>
    apiClient.get('/coins/analytics', { params: { period } }).then(res => res.data),

  // 充值
  recharge: (data: {
    target_user_id: number;
    amount: number;
    description?: string;
  }): Promise<ApiResponse<CoinTransaction & { new_balance?: number }>> =>
    apiClient.post('/coins/recharge', data).then(res => res.data),

  // 转账
  transfer: (data: {
    target_user_id: number;
    amount: number;
    description?: string;
  }): Promise<ApiResponse<CoinTransaction & { sender_new_balance?: number; receiver_new_balance?: number }>> =>
    apiClient.post('/coins/transfer', data).then(res => res.data),
};

// 皇冠自动化API
export const crownApi = {
  // 登录账号（纯 API 方式）
  loginAccount: (accountId: number): Promise<ApiResponse> =>
    apiClient.post(`/crown-automation/login-api/${accountId}`, undefined, { timeout: 30000 }).then(res => res.data),

  // 登出账号
  logoutAccount: (accountId: number): Promise<ApiResponse> =>
    apiClient.post(`/crown-automation/logout/${accountId}`, undefined, { timeout: 20000 }).then(res => res.data),

  // 执行自动下注
  placeBet: (accountId: number, data: {
    betType: string;
    betOption: string;
    amount: number;
    odds: number;
    matchId: number;
  }): Promise<ApiResponse> =>
    apiClient.post(`/crown-automation/bet/${accountId}`, data, { timeout: 60000 }).then(res => res.data),

  // 获取账号余额
  getAccountBalance: (accountId: number): Promise<ApiResponse> =>
    apiClient.get(`/crown-automation/balance/${accountId}`, { timeout: 60000 }).then(res => res.data),

  // 检查出口IP（用于验证代理）
  getProxyIP: (accountId: number): Promise<ApiResponse<{ ip: string }>> =>
    apiClient.get(`/crown-automation/proxy-ip/${accountId}`).then(res => res.data),

  // 获取自动化状态
  getStatus: (): Promise<ApiResponse> =>
    apiClient.get('/crown-automation/status', { timeout: 15000 }).then(res => res.data),

  // 首次登录改密（Playwright 方式，旧方法）
  initializeAccount: (accountId: number, data: { username: string; password: string }): Promise<ApiResponse> =>
    apiClient.post(`/crown-automation/initialize/${accountId}`, data, { timeout: 180000 }).then(res => res.data),

  // 首次登录改密（纯 API 方式，推荐）
  initializeAccountWithApi: (accountId: number, data: { username: string; password: string }): Promise<ApiResponse> => {
    const url = `/crown-automation/initialize-api/${accountId}`;
    console.log('📡 发送初始化请求:', { baseURL, url, fullUrl: `${baseURL}${url}` });
    return apiClient.post(url, data, { timeout: 180000 }).then(res => res.data);
  },

  // 批量登录账号
  batchLogin: (accountIds: number[]): Promise<ApiResponse> =>
    apiClient.post('/crown-automation/batch-login', { accountIds }, { timeout: 180000 }).then(res => res.data),

  // 批量登出账号
  batchLogout: (accountIds: number[]): Promise<ApiResponse> =>
    apiClient.post('/crown-automation/batch-logout', { accountIds }, { timeout: 30000 }).then(res => res.data),

  // 抓取赛事列表
  getMatches: (
    accountId: number,
    params?: { gtype?: string; showtype?: string; rtype?: string; ltype?: string; sorttype?: string }
  ): Promise<ApiResponse<{ matches: any[]; meta: any; raw?: string; source?: string; lastUpdate?: number; stale?: boolean; ageSeconds?: number }>> =>
    apiClient.get(`/crown-automation/matches/${accountId}`, { params, timeout: 120000 }).then(res => res.data),

  // 抓取赛事（系统默认账号）
  getMatchesSystem: (
    params?: { gtype?: string; showtype?: string; rtype?: string; ltype?: string; sorttype?: string; fast?: string }
  ): Promise<ApiResponse<{ matches: any[]; meta: any; raw?: string; source?: string; lastUpdate?: number; stale?: boolean; ageSeconds?: number }>> =>
    apiClient.get(`/crown-automation/matches-system`, { params, timeout: 120000 }).then(res => res.data),

  // 设置账号是否用于赛事抓取
  setFetchConfig: (accountId: number, useForFetch: boolean): Promise<ApiResponse> =>
    apiClient.patch(`/crown-automation/account/${accountId}/fetch-config`, { useForFetch }).then(res => res.data),

  // 同步赛事到本地
  syncMatches: (
    accountId: number,
    params?: { gtype?: string; showtype?: string; rtype?: string; ltype?: string; sorttype?: string }
  ): Promise<ApiResponse> =>
    apiClient.post(`/crown-automation/matches/sync/${accountId}`, undefined, { params, timeout: 120000 }).then(res => res.data),

  // 预览最新赔率
  previewOdds: (data: {
    account_id: number;
    match_id: number;
    crown_match_id?: string;
    bet_type: string;
    bet_option: string;
    odds?: number;
    bet_amount?: number;
    league_name?: string;
    home_team?: string;
    away_team?: string;
  }): Promise<ApiResponse<{
    odds: number | null;
    closed?: boolean;
    message?: string;
    raw?: any;
    max_bet?: string | number | null;
    min_bet?: string | number | null;
    spread_mismatch?: boolean;
    requested_line?: string;
    returned_spread?: string;
  }>> =>
    apiClient.post('/crown-automation/odds/preview', data, { timeout: 15000 }).then(res => res.data),

  // 获取账号额度设置
  getAccountSettings: (accountId: number, gtype?: string): Promise<ApiResponse> =>
    apiClient.get(`/crown-automation/account-settings/${accountId}`, { params: { gtype }, timeout: 30000 }).then(res => res.data),

  // 获取账号下注历史
  getHistory: (
    accountId: number,
    params?: { gtype?: string; isAll?: string; startdate?: string; enddate?: string; filter?: string }
  ): Promise<ApiResponse> =>
    apiClient.get(`/crown-automation/history/${accountId}`, { params, timeout: 60000 }).then(res => res.data),

  // 获取账号今日下注
  getTodayWagers: (accountId: number, params?: { gtype?: string; chk_cw?: string }): Promise<ApiResponse> =>
    apiClient.get(`/crown-automation/wagers/${accountId}`, { params, timeout: 30000 }).then(res => res.data),
  // 获取所有在线账号的今日下注
  getAllWagers: (): Promise<ApiResponse<{ wagers: any[]; errors: any[]; total_accounts: number; total_wagers: number }>> =>
    apiClient.get('/crown-automation/wagers-all', { timeout: 60000 }).then(res => res.data),
  // 获取本地存储的注单历史
  getLocalWagers: (params?: { date?: string; account_id?: number; limit?: number }): Promise<ApiResponse<{ wagers: any[]; total: number }>> =>
    apiClient.get('/crown-automation/wagers-local', { params, timeout: 30000 }).then(res => res.data),
};

export const aliasApi = {
  listLeagues: (params?: { search?: string }): Promise<ApiResponse<AliasRecord[]>> =>
    apiClient.get('/aliases/leagues', { params }).then(res => res.data),

  createLeague: (data: {
    canonical_key?: string;
    name_en?: string;
    name_zh_cn?: string;
    name_zh_tw?: string;
    aliases?: string[];
  }): Promise<ApiResponse<AliasRecord>> =>
    apiClient.post('/aliases/leagues', data).then(res => res.data),

  updateLeague: (id: number, data: {
    canonical_key?: string;
    name_en?: string;
    name_zh_cn?: string;
    name_zh_tw?: string;
    aliases?: string[];
  }): Promise<ApiResponse<AliasRecord>> =>
    apiClient.put(`/aliases/leagues/${id}`, data).then(res => res.data),

  deleteLeague: (id: number): Promise<ApiResponse> =>
    apiClient.delete(`/aliases/leagues/${id}`).then(res => res.data),

  importLeagues: (file: File): Promise<ApiResponse<{
    type: string;
    total: number;
    updated: number;
    skipped: number;
    notFound: number;
  }>> => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post('/aliases/leagues/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }).then(res => res.data);
  },

  exportUntranslatedLeagues: (): Promise<Blob> =>
    apiClient.get('/aliases/leagues/export-untranslated', {
      responseType: 'blob'
    }).then(res => res.data),

  listTeams: (params?: { search?: string }): Promise<ApiResponse<AliasRecord[]>> =>
    apiClient.get('/aliases/teams', { params }).then(res => res.data),

  createTeam: (data: {
    canonical_key?: string;
    name_en?: string;
    name_zh_cn?: string;
    name_zh_tw?: string;
    aliases?: string[];
  }): Promise<ApiResponse<AliasRecord>> =>
    apiClient.post('/aliases/teams', data).then(res => res.data),

  updateTeam: (id: number, data: {
    canonical_key?: string;
    name_en?: string;
    name_zh_cn?: string;
    name_zh_tw?: string;
    aliases?: string[];
  }): Promise<ApiResponse<AliasRecord>> =>
    apiClient.put(`/aliases/teams/${id}`, data).then(res => res.data),

  deleteTeam: (id: number): Promise<ApiResponse> =>
    apiClient.delete(`/aliases/teams/${id}`).then(res => res.data),

  importTeams: (file: File): Promise<ApiResponse<{
    type: string;
    total: number;
    updated: number;
    skipped: number;
    notFound: number;
  }>> => {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post('/aliases/teams/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }).then(res => res.data);
  },

  exportUntranslatedTeams: (): Promise<Blob> =>
    apiClient.get('/aliases/teams/export-untranslated', {
      responseType: 'blob'
    }).then(res => res.data),

  // 从皇冠赛事导入
  importFromCrown: (): Promise<ApiResponse<{
    leagues: { total: number; inserted: number; skipped: number };
    teams: { total: number; inserted: number; skipped: number };
  }>> =>
    apiClient.post('/aliases/import-from-crown').then(res => res.data),

  // 从 iSports API 导入
  importFromISports: (): Promise<ApiResponse<{
    leagues: { total: number; inserted: number; updated: number; skipped: number };
    teams: { total: number; inserted: number; updated: number; skipped: number };
  }>> =>
    apiClient.post('/aliases/import-from-isports').then(res => res.data),
};

// 皇冠赛事 API
export const crownMatchApi = {
  getMatches: (params: {
    page?: number;
    pageSize?: number;
    leagueMatched?: boolean;
    homeMatched?: boolean;
    awayMatched?: boolean;
    startDate?: string;
    endDate?: string;
  }): Promise<ApiResponse<{
    matches: any[];
    total: number;
  }>> =>
    apiClient.get('/crown-matches', { params }).then(res => res.data),

  getStats: (): Promise<ApiResponse<{
    total_matches: number;
    league_matched: number;
    home_matched: number;
    away_matched: number;
    fully_matched: number;
    league_match_rate: number;
    home_match_rate: number;
    away_match_rate: number;
    full_match_rate: number;
  }>> =>
    apiClient.get('/crown-matches/stats').then(res => res.data),

  getUnmatchedLeagues: (limit?: number): Promise<ApiResponse<string[]>> =>
    apiClient.get('/crown-matches/unmatched-leagues', { params: { limit } }).then(res => res.data),

  getUnmatchedTeams: (limit?: number): Promise<ApiResponse<string[]>> =>
    apiClient.get('/crown-matches/unmatched-teams', { params: { limit } }).then(res => res.data),

  deleteOldMatches: (daysAgo?: number): Promise<ApiResponse<{ deleted: number }>> =>
    apiClient.delete('/crown-matches/old', { params: { daysAgo } }).then(res => res.data),

  rematch: (data: {
    startDate: string;
    endDate?: string;
  }): Promise<ApiResponse<{
    total: number;
    matched: number;
    unmatched: number;
  }>> =>
    apiClient.post('/crown-matches/rematch', data).then(res => res.data),
};

// iSports 赛事 API
export const isportsMatchApi = {
  getMatches: (params: {
    date?: string;
  }): Promise<ApiResponse<{
    matches: any[];
    total: number;
    date: string;
  }>> =>
    apiClient.get('/isports-matches', { params }).then(res => res.data),
};

export default apiClient;
