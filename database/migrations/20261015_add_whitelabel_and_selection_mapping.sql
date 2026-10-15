-- 租户 / 白标站点与下注选择映射层
-- 目标：
-- 1) 用户按白标归属隔离登录与下注；
-- 2) 注单同时保存“展示选择”和“实际执行选择”；
-- 3) 后台开关切换带版本号和审计记录。

CREATE TABLE IF NOT EXISTS whitelabels (
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

-- 首次部署时创建本地默认租户。迁移只执行一次；这里保留 ON CONFLICT 以便失败重放时安全。
INSERT INTO whitelabels (id, name, domain, status, is_default)
VALUES (1, 'Default Local', 'local.test', 'active', TRUE)
ON CONFLICT (id) DO NOTHING;

SELECT setval(
    pg_get_serial_sequence('whitelabels', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM whitelabels), 1),
    TRUE
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'whitelabel_id'
    ) THEN
        ALTER TABLE users
            ADD COLUMN whitelabel_id INTEGER
            REFERENCES whitelabels(id) ON DELETE SET NULL;
    END IF;
END
$$;

UPDATE users
SET whitelabel_id = 1
WHERE whitelabel_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelabels_single_default
    ON whitelabels (is_default) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_users_whitelabel_id ON users (whitelabel_id);

CREATE TABLE IF NOT EXISTS selection_mapping_settings (
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

CREATE TABLE IF NOT EXISTS selection_mapping_audit_logs (
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

CREATE INDEX IF NOT EXISTS idx_selection_mapping_audit_whitelabel_created
    ON selection_mapping_audit_logs (whitelabel_id, created_at DESC);

INSERT INTO selection_mapping_settings (whitelabel_id, mapping_mode, enabled, version)
SELECT id, 'identity', FALSE, 1 FROM whitelabels
ON CONFLICT (whitelabel_id) DO NOTHING;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'whitelabel_id'
    ) THEN
        ALTER TABLE bets
            ADD COLUMN whitelabel_id INTEGER REFERENCES whitelabels(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'displayed_market_side'
    ) THEN
        ALTER TABLE bets ADD COLUMN displayed_market_side VARCHAR(16);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'executed_market_side'
    ) THEN
        ALTER TABLE bets ADD COLUMN executed_market_side VARCHAR(16);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'displayed_market_rtype'
    ) THEN
        ALTER TABLE bets ADD COLUMN displayed_market_rtype VARCHAR(32);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'executed_market_rtype'
    ) THEN
        ALTER TABLE bets ADD COLUMN executed_market_rtype VARCHAR(32);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'displayed_market_chose_team'
    ) THEN
        ALTER TABLE bets ADD COLUMN displayed_market_chose_team CHAR(1);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'executed_market_chose_team'
    ) THEN
        ALTER TABLE bets ADD COLUMN executed_market_chose_team CHAR(1);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'mapping_mode'
    ) THEN
        ALTER TABLE bets ADD COLUMN mapping_mode VARCHAR(16);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'mapping_version'
    ) THEN
        ALTER TABLE bets ADD COLUMN mapping_version BIGINT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bets' AND column_name = 'mapping_applied'
    ) THEN
        ALTER TABLE bets ADD COLUMN mapping_applied BOOLEAN;
    END IF;
END
$$;

-- 旧注单回填为 identity：market_side 继续作为展示值，执行值与展示值一致。
UPDATE bets b
SET whitelabel_id = u.whitelabel_id,
    displayed_market_side = b.market_side,
    executed_market_side = b.market_side,
    mapping_mode = 'identity',
    mapping_version = 1,
    mapping_applied = FALSE
FROM users u
WHERE b.user_id = u.id AND b.mapping_version IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'bets_mapping_mode_check'
    ) THEN
        ALTER TABLE bets
            ADD CONSTRAINT bets_mapping_mode_check
            CHECK (mapping_mode IS NULL OR mapping_mode IN ('identity', 'inverse'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_bets_whitelabel_created
    ON bets (whitelabel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bets_mapping_version
    ON bets (mapping_version);
