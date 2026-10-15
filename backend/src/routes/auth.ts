import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from '../models/database';
import { LoginRequest, UserCreateRequest, ApiResponse, LoginResponse, User } from '../types';
import { authenticateToken } from '../middleware/auth';
import { resolveWhitelabelForRequest, WhitelabelResolutionError } from '../services/whitelabel-service';
import { emailService } from '../services/email.service';

const router = Router();

/**
 * 获取客户端 IP 地址
 */
function getClientIp(req: any): string {
    return (
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.headers['x-real-ip'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        ''
    );
}

/**
 * 检查 IP 是否在信任列表中
 */
async function isIpTrusted(userId: number, ip: string): Promise<boolean> {
    const result = await query(
        'SELECT trusted_ips FROM users WHERE id = $1',
        [userId]
    );

    if (result.rows.length === 0) {
        return false;
    }

    const trustedIps = result.rows[0].trusted_ips || [];
    return trustedIps.includes(ip);
}

/**
 * 添加 IP 到信任列表
 */
async function addTrustedIp(userId: number, ip: string): Promise<void> {
    await query(
        `UPDATE users
         SET trusted_ips = array_append(COALESCE(trusted_ips, ARRAY[]::TEXT[]), $1),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND NOT ($1 = ANY(COALESCE(trusted_ips, ARRAY[]::TEXT[])))`,
        [ip, userId]
    );
}

/**
 * 记录登录历史
 */
async function recordLoginHistory(
    userId: number,
    ip: string,
    userAgent: string,
    success: boolean,
    verificationRequired: boolean
): Promise<void> {
    await query(
        `INSERT INTO login_history (user_id, ip_address, user_agent, success, verification_required)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, ip, userAgent, success, verificationRequired]
    );
}

// 用户注册
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, role, parent_id }: UserCreateRequest = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                success: false,
                error: '用户名、邮箱和密码不能为空'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                error: '密码长度至少6位'
            });
        }

        // 默认角色为 staff
        const userRole = role || 'staff';

        // 验证角色有效性
        if (!['admin', 'agent', 'staff'].includes(userRole)) {
            return res.status(400).json({
                success: false,
                error: '无效的角色'
            });
        }

        // 检查用户是否已存在
        const existingUser = await query(
            'SELECT id FROM users WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existingUser.rows.length > 0) {
            return res.status(400).json({
                success: false,
                error: '用户名或邮箱已存在'
            });
        }

        // 如果有 parent_id，验证上级用户存在
        if (parent_id) {
            const parentUser = await query(
                'SELECT id, role FROM users WHERE id = $1',
                [parent_id]
            );

            if (parentUser.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: '上级用户不存在'
                });
            }

            // 只有代理可以创建员工
            if (userRole === 'staff' && parentUser.rows[0].role !== 'agent') {
                return res.status(400).json({
                    success: false,
                    error: '只有代理可以创建员工账号'
                });
            }
        }

        // 注册请求必须先解析白标归属；未知域名直接拒绝，避免默认租户静默吞掉配置错误。
        const whitelabel = await resolveWhitelabelForRequest(req);

        // 加密密码
        const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '10');
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // 计算 agent_id
        let agentId = null;
        if (userRole === 'staff' && parent_id) {
            const parentUser = await query(
                'SELECT id, role FROM users WHERE id = $1',
                [parent_id]
            );
            if (parentUser.rows[0].role === 'agent') {
                agentId = parent_id;
            }
        }

        // 创建用户
        const result = await query(
            'INSERT INTO users (username, email, password_hash, role, parent_id, agent_id, whitelabel_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, username, email, role, parent_id, agent_id, whitelabel_id, created_at, updated_at',
            [username, email, passwordHash, userRole, parent_id || null, agentId, whitelabel.id]
        );

        const user = result.rows[0];

        const token = jwt.sign(
            {
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    parent_id: user.parent_id,
                    agent_id: user.agent_id,
                    whitelabel_id: user.whitelabel_id
                }
            },
            process.env.JWT_SECRET!,
            { expiresIn: '24h' }
        );

        // 只为员工创建默认分组
        if (userRole === 'staff') {
            await query(
                'INSERT INTO groups (user_id, name, description) VALUES ($1, $2, $3)',
                [user.id, '默认分组', '系统自动创建的默认分组']
            );
        }

        res.status(201).json({
            success: true,
            data: {
                user,
                token
            },
            message: '注册成功'
        } as ApiResponse<LoginResponse>);

    } catch (error) {
        console.error('注册错误:', error);
        res.status(500).json({
            success: false,
            error: '注册失败'
        });
    }
});

// 用户登录
router.post('/login', async (req, res) => {
    const safeBody = { ...req.body } as any;
    if (typeof safeBody?.password === 'string') safeBody.password = '***';
    console.log('🔐 登录请求开始，请求体:', safeBody);
    try {
        const { username, password, verificationCode }: LoginRequest & { verificationCode?: string } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: '用户名和密码不能为空'
            });
        }

        // 获取客户端 IP 和 User-Agent
        const clientIp = getClientIp(req);
        const userAgent = req.headers['user-agent'] || '';

        // 查找用户
        const result = await query(
            'SELECT id, username, email, password_hash, role, parent_id, agent_id, whitelabel_id, email_verified, created_at, updated_at FROM users WHERE username = $1',
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                error: '用户名或密码错误'
            });
        }

        const user = result.rows[0];

        // 验证密码
        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            await recordLoginHistory(user.id, clientIp, userAgent, false, false);
            return res.status(401).json({
                success: false,
                error: '用户名或密码错误'
            });
        }

        // 登录域名必须与用户归属一致。旧数据迁移后所有用户都有白标 ID。
        const requestWhitelabel = await resolveWhitelabelForRequest(req);
        if (user.whitelabel_id !== requestWhitelabel.id) {
            await recordLoginHistory(user.id, clientIp, userAgent, false, false);
            return res.status(403).json({
                success: false,
                error: '当前账号不属于该白标站点'
            });
        }

        // 检查是否需要邮箱绑定（首次登录且邮箱未验证）
        // Admin 角色跳过邮箱验证
        if (!user.email_verified && user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: '请先绑定邮箱',
                requireEmailBinding: true,
                userId: user.id,
                email: user.email
            });
        }

        // 检查 IP 是否可信
        // Admin 角色跳过 IP 验证
        const ipTrusted = user.role === 'admin' ? true : await isIpTrusted(user.id, clientIp);

        if (!ipTrusted) {
            // 非常用 IP，需要验证码
            if (!verificationCode) {
                await recordLoginHistory(user.id, clientIp, userAgent, false, true);
                return res.status(403).json({
                    success: false,
                    error: '检测到非常用网络登录，请输入邮箱验证码',
                    requireVerification: true,
                    userId: user.id,
                    email: user.email
                });
            }

            // 验证验证码
            const verifyResult = await emailService.verifyCode(
                user.id,
                user.email,
                verificationCode,
                'login_verification'
            );

            if (!verifyResult.success) {
                await recordLoginHistory(user.id, clientIp, userAgent, false, true);
                return res.status(403).json({
                    success: false,
                    error: verifyResult.message,
                    requireVerification: true,
                    userId: user.id,
                    email: user.email
                });
            }

            // 验证成功，添加 IP 到信任列表
            await addTrustedIp(user.id, clientIp);
        }

        // 生成JWT令牌，包含角色信息
        const token = jwt.sign(
            {
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role,
                    parent_id: user.parent_id,
                    agent_id: user.agent_id,
                    whitelabel_id: user.whitelabel_id
                }
            },
            process.env.JWT_SECRET!,
            { expiresIn: '24h' }
        );

        // 记录登录成功
        await recordLoginHistory(user.id, clientIp, userAgent, true, !ipTrusted);

        // 创建返回的用户对象（不包含password_hash）
        const userResponse = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            parent_id: user.parent_id,
            agent_id: user.agent_id,
            whitelabel_id: user.whitelabel_id,
            email_verified: user.email_verified,
            created_at: user.created_at,
            updated_at: user.updated_at
        };

        res.json({
            success: true,
            data: { user: userResponse, token },
            message: '登录成功'
        } as ApiResponse<LoginResponse>);

    } catch (error) {
        if (error instanceof WhitelabelResolutionError) {
            return res.status(error.status || 400).json({
                success: false,
                error: error.message
            });
        }

        console.error('登录错误:', error);
        res.status(500).json({
            success: false,
            error: '登录失败'
        });
    }
});

// 获取当前用户信息
router.get('/me', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.id;

        const result = await query(
            'SELECT id, username, email, role, parent_id, agent_id, whitelabel_id, created_at, updated_at FROM users WHERE id = $1',
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: '用户不存在'
            });
        }

        res.json({
            success: true,
            data: result.rows[0]
        } as ApiResponse<User>);

    } catch (error) {
        console.error('获取用户信息错误:', error);
        res.status(500).json({
            success: false,
            error: '获取用户信息失败'
        });
    }
});

// 修改密码
router.post('/change-password', authenticateToken, async (req: any, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const userId = req.user.id;

        if (!oldPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                error: '旧密码和新密码不能为空'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                error: '新密码长度至少6位'
            });
        }

        // 获取用户当前密码
        const userResult = await query(
            'SELECT password_hash FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: '用户不存在'
            });
        }

        // 验证旧密码
        const isValidPassword = await bcrypt.compare(oldPassword, userResult.rows[0].password_hash);
        if (!isValidPassword) {
            return res.status(401).json({
                success: false,
                error: '旧密码错误'
            });
        }

        // 加密新密码
        const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '10');
        const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

        // 更新密码
        await query(
            'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [newPasswordHash, userId]
        );

        res.json({
            success: true,
            message: '密码修改成功'
        });

    } catch (error) {
        console.error('修改密码错误:', error);
        res.status(500).json({
            success: false,
            error: '修改密码失败'
        });
    }
});

// 发送邮箱验证码
router.post('/send-verification-code', async (req, res) => {
    try {
        const { userId, email, type } = req.body;

        if (!userId || !email || !type) {
            return res.status(400).json({
                success: false,
                error: '参数不完整'
            });
        }

        if (!['email_binding', 'login_verification'].includes(type)) {
            return res.status(400).json({
                success: false,
                error: '无效的验证类型'
            });
        }

        // 验证用户是否存在
        const userResult = await query(
            'SELECT id, email FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: '用户不存在'
            });
        }

        // 发送验证码
        const result = await emailService.sendVerificationCode(userId, email, type);

        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                code: result.code // 开发环境会返回验证码
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.message
            });
        }
    } catch (error) {
        console.error('发送验证码错误:', error);
        res.status(500).json({
            success: false,
            error: '发送验证码失败'
        });
    }
});

// 绑定邮箱
router.post('/bind-email', async (req, res) => {
    try {
        const { userId, email, verificationCode } = req.body;

        if (!userId || !email || !verificationCode) {
            return res.status(400).json({
                success: false,
                error: '参数不完整'
            });
        }

        // 验证验证码
        const verifyResult = await emailService.verifyCode(
            userId,
            email,
            verificationCode,
            'email_binding'
        );

        if (!verifyResult.success) {
            return res.status(400).json({
                success: false,
                error: verifyResult.message
            });
        }

        // 获取客户端 IP，添加到信任列表
        const clientIp = getClientIp(req);
        await addTrustedIp(userId, clientIp);

        res.json({
            success: true,
            message: '邮箱绑定成功'
        });
    } catch (error) {
        console.error('绑定邮箱错误:', error);
        res.status(500).json({
            success: false,
            error: '绑定邮箱失败'
        });
    }
});

// 获取登录历史
router.get('/login-history', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const { limit = 10 } = req.query;

        const result = await query(
            `SELECT ip_address, user_agent, login_time, success, verification_required
             FROM login_history
             WHERE user_id = $1
             ORDER BY login_time DESC
             LIMIT $2`,
            [userId, parseInt(limit as string)]
        );

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('获取登录历史错误:', error);
        res.status(500).json({
            success: false,
            error: '获取登录历史失败'
        });
    }
});

export { router as authRoutes };
