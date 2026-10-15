-- 添加初始化类型字段到 crown_accounts 表
-- 用于标识账号的初始化方式
-- 日期：2025-10-27

-- 添加 init_type 字段
ALTER TABLE crown_accounts ADD COLUMN IF NOT EXISTS init_type VARCHAR(20) DEFAULT 'full';

-- 字段说明：
-- 'none': 不需要初始化（账号密码都不改）
-- 'password_only': 只需要改密码
-- 'full': 需要改账号和密码（完整初始化）

COMMENT ON COLUMN crown_accounts.init_type IS '初始化类型：none-不初始化, password_only-仅改密码, full-完整初始化';

-- 更新现有数据的 init_type
-- 如果已经有 initialized_username，说明已经完整初始化过
UPDATE crown_accounts
SET init_type = 'full'
WHERE initialized_username IS NOT NULL AND initialized_username != '';

-- 如果没有 initialized_username 但有 original_username，说明可能是只改密码
UPDATE crown_accounts
SET init_type = 'password_only'
WHERE (initialized_username IS NULL OR initialized_username = '')
  AND original_username IS NOT NULL
  AND original_username != '';

-- 其他情况默认为 full（保持向后兼容）
