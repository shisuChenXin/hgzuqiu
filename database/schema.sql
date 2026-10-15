-- 智投系统数据库设计
-- 基于参考截图的完整功能需求

-- 用户表
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    -- 角色与层级（后端依赖）
    role VARCHAR(20) NOT NULL DEFAULT 'staff',
    parent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 白标 / OEM 租户表
CREATE TABLE whitelabels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    domain VARCHAR(255) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users
    ADD COLUMN whitelabel_id INTEGER REFERENCES whitelabels(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX uq_whitelabels_single_default ON whitelabels (is_default) WHERE is_default;
CREATE INDEX idx_users_whitelabel_id ON users (whitelabel_id);

INSERT INTO whitelabels (id, name, domain, status, is_default)
VALUES (1, 'Default Local', 'local.test', 'active', TRUE);
SELECT setval(
    pg_get_serial_sequence('whitelabels', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM whitelabels), 1),
    TRUE
);

-- 租户级下注选择映射配置与审计
CREATE TABLE selection_mapping_settings (
    id SERIAL PRIMARY KEY,
    whitelabel_id INTEGER NOT NULL UNIQUE
        REFERENCES whitelabels(id) ON DELETE CASCADE,
    mapping_mode VARCHAR(16) NOT NULL DEFAULT 'identity'
        CHECK (mapping_mode IN ('identity', 'inverse')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    version BIGINT NOT NULL DEFAULT 1,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE selection_mapping_audit_logs (
    id SERIAL PRIMARY KEY,
    whitelabel_id INTEGER NOT NULL
        REFERENCES whitelabels(id) ON DELETE CASCADE,
    from_mode VARCHAR(16) NOT NULL,
    to_mode VARCHAR(16) NOT NULL,
    from_enabled BOOLEAN NOT NULL,
    to_enabled BOOLEAN NOT NULL,
    from_version BIGINT NOT NULL,
    to_version BIGINT NOT NULL,
    operator_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_selection_mapping_audit_whitelabel_created
    ON selection_mapping_audit_logs (whitelabel_id, created_at DESC);

INSERT INTO selection_mapping_settings (whitelabel_id, mapping_mode, enabled, version)
SELECT id, 'identity', FALSE, 1 FROM whitelabels;

-- 分组表
CREATE TABLE groups (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 皇冠账号表 (基于参考截图的字段)
CREATE TABLE crown_accounts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,

    -- 基本信息
    username VARCHAR(100) NOT NULL,
    password VARCHAR(255) NOT NULL,
    passcode VARCHAR(20), -- 四位简易登录密碼
    display_name VARCHAR(100), -- 显示名称，如: G1aokloz (cfax5g2hoz)
    original_username VARCHAR(100), -- 原始账号（首次登录时的账号）
    initialized_username VARCHAR(100), -- 修改后的账号（初始化后使用的账号）

    -- 平台信息
    platform VARCHAR(50) DEFAULT '皇冠',
    game_type VARCHAR(50) DEFAULT '足球', -- 足球、篮球等
    source VARCHAR(50) DEFAULT '自有', -- 来源：自有、共享
    share_count INTEGER DEFAULT 0, -- 分享数

    -- 财务信息
    currency VARCHAR(10) DEFAULT 'CNY', -- 币种
    discount DECIMAL(3,2) DEFAULT 1.00, -- 折扣：0.8, 0.85, 1.0
    note VARCHAR(50), -- 备注：高、中、低
    balance DECIMAL(15,2) DEFAULT 0, -- 余额
    credit DECIMAL(15,2) DEFAULT 0, -- 信用额度
    stop_profit_limit DECIMAL(15,2) DEFAULT 0, -- 止盈金额

    -- 设备信息
    device_type VARCHAR(50), -- iPhone 14, iPhone 15, iPhone 11
    user_agent TEXT, -- 用户代理字符串

    -- 代理信息
    proxy_enabled BOOLEAN DEFAULT false,
    proxy_type VARCHAR(10), -- http, socks5
    proxy_host VARCHAR(255),
    proxy_port INTEGER,
    proxy_username VARCHAR(100),
    proxy_password VARCHAR(255),

    -- 归属信息
    agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    use_for_fetch BOOLEAN DEFAULT false, -- 是否用于赛事抓取

    -- 限额设置 (基于参考截图)
    football_prematch_limit DECIMAL(15,2) DEFAULT 100000, -- 足球赛前限额
    football_live_limit DECIMAL(15,2) DEFAULT 100000, -- 足球滚球限额
    basketball_prematch_limit DECIMAL(15,2) DEFAULT 100000, -- 篮球赛前限额
    basketball_live_limit DECIMAL(15,2) DEFAULT 100000, -- 篮球滚球限额

    -- 状态管理
    is_enabled BOOLEAN DEFAULT true, -- 启用状态
    is_online BOOLEAN DEFAULT false, -- 在线状态
    last_login_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active', -- active, disabled, error
    error_message TEXT,

    -- API 会话信息（用于纯 API 登录方式）
    api_uid VARCHAR(255), -- 皇冠 API 返回的用户 UID
    api_login_time BIGINT, -- API 登录时间戳（毫秒）
    api_cookies TEXT, -- API 登录后的 Cookie

    -- 时间戳
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 赛事信息表
CREATE TABLE matches (
    id SERIAL PRIMARY KEY,
    match_id VARCHAR(100) UNIQUE NOT NULL, -- 官网比赛ID

    -- 基本信息
    league_name VARCHAR(200) NOT NULL, -- 联赛名称
    home_team VARCHAR(100) NOT NULL, -- 主队
    away_team VARCHAR(100) NOT NULL, -- 客队
    match_time TIMESTAMP NOT NULL, -- 比赛时间

    -- 比赛状态
    status VARCHAR(20) DEFAULT 'scheduled', -- scheduled, live, finished, cancelled
    current_score VARCHAR(20), -- 当前比分，如: 3-0
    match_period VARCHAR(20), -- 比赛阶段，如: 2H*89:41
    markets JSONB, -- 盘口/赔率原始结构
    last_synced_at TIMESTAMP, -- 最近一次从官网同步时间

    -- 赔率信息 (基于参考截图的玩法)
    odds_home_win DECIMAL(5,2), -- 主胜赔率
    odds_draw DECIMAL(5,2), -- 平局赔率
    odds_away_win DECIMAL(5,2), -- 客胜赔率
    odds_handicap DECIMAL(5,2), -- 让球赔率
    odds_over DECIMAL(5,2), -- 大球赔率
    odds_under DECIMAL(5,2), -- 小球赔率

    -- 半场赔率
    odds_home_win_half DECIMAL(5,2), -- 半场主胜
    odds_draw_half DECIMAL(5,2), -- 半场平局
    odds_away_win_half DECIMAL(5,2), -- 半场客胜
    odds_handicap_half DECIMAL(5,2), -- 半场让球
    odds_over_half DECIMAL(5,2), -- 半场大球
    odds_under_half DECIMAL(5,2), -- 半场小球

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 下注记录表 (对应参考截图的票单功能)
CREATE TABLE bets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    account_id INTEGER NOT NULL REFERENCES crown_accounts(id),
    match_id INTEGER NOT NULL REFERENCES matches(id),

    -- 下注信息
    bet_type VARCHAR(50) NOT NULL, -- 投注类型：独赢、让球、大小球等
    bet_option VARCHAR(100) NOT NULL, -- 具体选项，如：[盘前]全场主队-0.5@0.88
    bet_amount DECIMAL(15,2) NOT NULL, -- 投注金额
    odds DECIMAL(5,2) NOT NULL, -- 投注时的赔率
    min_odds DECIMAL(6,3), -- 下注时用户设置的最低赔率
    official_odds DECIMAL(6,3), -- 皇冠返回的真实赔率
    market_category VARCHAR(32), -- 盘口类别：moneyline / handicap / overunder
    market_scope VARCHAR(16), -- 盘口范围：full / half
    market_side VARCHAR(16), -- 用户展示的下注方向：home/away/draw/over/under
    whitelabel_id INTEGER REFERENCES whitelabels(id) ON DELETE SET NULL,
    displayed_market_side VARCHAR(16), -- 用户看到的下注方向
    executed_market_side VARCHAR(16), -- 实际提交到上游的下注方向
    displayed_market_rtype VARCHAR(32), -- 用户看到的终端 API 侧位
    executed_market_rtype VARCHAR(32), -- 实际提交到上游的终端 API 侧位
    displayed_market_chose_team CHAR(1), -- 用户看到的 H/C/N
    executed_market_chose_team CHAR(1), -- 实际提交到上游的 H/C/N
    mapping_mode VARCHAR(16) CHECK (mapping_mode IS NULL OR mapping_mode IN ('identity', 'inverse')),
    mapping_version BIGINT,
    mapping_applied BOOLEAN,
    market_line VARCHAR(50), -- 对应盘口行数值，如 -0.5 或 2.5/3
    market_index INTEGER, -- 前端选择的盘口行索引

    -- 下注设置 (基于参考截图的下注弹窗)
    single_limit DECIMAL(15,2), -- 单笔限额
    interval_seconds INTEGER DEFAULT 3, -- 间隔时间(秒)
    quantity INTEGER DEFAULT 1, -- 数量

    -- 状态和结果
    status VARCHAR(20) DEFAULT 'pending', -- pending, confirmed, cancelled, settled
    result VARCHAR(20), -- win, lose, draw, cancelled
    payout DECIMAL(15,2) DEFAULT 0, -- 派彩金额
    profit_loss DECIMAL(15,2) DEFAULT 0, -- 盈亏
    virtual_bet_amount DECIMAL(15,2), -- 虚拟金额
    virtual_profit_loss DECIMAL(15,2), -- 虚拟盈亏
    result_score VARCHAR(50), -- 结算比分，例如 1-3
    result_text VARCHAR(255), -- 结算文本

    -- 官网信息
    official_bet_id VARCHAR(100), -- 官网下注单号
    confirmed_at TIMESTAMP, -- 确认时间
    settled_at TIMESTAMP, -- 结算时间
    error_message TEXT, -- 失败原因/取消原因（用于显示“失败”提示）

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 金币流水表 (基于参考截图的金币管理)
CREATE TABLE coin_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    account_id INTEGER REFERENCES crown_accounts(id), -- 可能为空的全局操作
    bet_id INTEGER REFERENCES bets(id), -- 关联的下注记录

    -- 流水信息
    transaction_id VARCHAR(100) UNIQUE NOT NULL, -- 流水号，如：ZMZOrXUdaDksA88pzCnFN
    transaction_type VARCHAR(50) NOT NULL, -- 类型：消耗、返还、转账、收款
    description TEXT, -- 描述，如：cb1995959票单[GsC_wTyX2LmiZYm_Eo3]消耗

    -- 金额变化
    amount DECIMAL(15,2) NOT NULL, -- 变动金额，正数为收入，负数为支出
    balance_before DECIMAL(15,2) NOT NULL, -- 变动前余额
    balance_after DECIMAL(15,2) NOT NULL, -- 变动后余额

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 系统设置表
CREATE TABLE settings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, setting_key)
);

-- 创建索引
CREATE INDEX idx_crown_accounts_user_id ON crown_accounts(user_id);
CREATE INDEX idx_crown_accounts_group_id ON crown_accounts(group_id);
CREATE INDEX idx_crown_accounts_status ON crown_accounts(status);
CREATE INDEX idx_crown_accounts_agent_id ON crown_accounts(agent_id);
CREATE INDEX idx_crown_accounts_use_for_fetch ON crown_accounts(use_for_fetch);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_match_time ON matches(match_time);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_parent_id ON users(parent_id);
CREATE INDEX idx_users_agent_id ON users(agent_id);
CREATE INDEX idx_bets_user_id ON bets(user_id);
CREATE INDEX idx_bets_account_id ON bets(account_id);
CREATE INDEX idx_bets_status ON bets(status);
CREATE INDEX idx_bets_created_at ON bets(created_at);
CREATE INDEX idx_bets_whitelabel_created ON bets(whitelabel_id, created_at DESC);
CREATE INDEX idx_bets_mapping_version ON bets(mapping_version);
CREATE INDEX idx_coin_transactions_user_id ON coin_transactions(user_id);
CREATE INDEX idx_coin_transactions_created_at ON coin_transactions(created_at);

-- 比赛名称映射表（联赛）
CREATE TABLE league_aliases (
    id SERIAL PRIMARY KEY,
    canonical_key VARCHAR(120) NOT NULL UNIQUE,
    name_en VARCHAR(200),
    name_zh_cn VARCHAR(200),
    name_zh_tw VARCHAR(200),
    aliases JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 比赛名称映射表（球队）
CREATE TABLE team_aliases (
    id SERIAL PRIMARY KEY,
    canonical_key VARCHAR(120) NOT NULL UNIQUE,
    name_en VARCHAR(200),
    name_zh_cn VARCHAR(200),
    name_zh_tw VARCHAR(200),
    aliases JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_league_aliases_canonical_key ON league_aliases(canonical_key);
CREATE INDEX idx_team_aliases_canonical_key ON team_aliases(canonical_key);

-- 插入默认数据
INSERT INTO users (username, email, password_hash, role) VALUES
('admin', 'admin@example.com', '$2b$10$placeholder_hash', 'admin');

INSERT INTO groups (user_id, name, description) VALUES
(1, '默认分组', '系统默认创建的分组');
