import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/permission';
import {
    WhitelabelResolutionError,
    assignUsersToWhitelabel,
    createWhitelabel,
    listWhitelabelUsers,
    listWhitelabels,
    updateWhitelabel,
} from '../services/whitelabel-service';
import {
    SelectionMappingError,
    getMappingSettings,
    listMappingAuditLogs,
    updateMappingSettings,
} from '../services/selection-mapping-service';

const router = Router();
router.use(authenticateToken, requireAdmin);

const handleError = (res: any, error: any) => {
    if (error instanceof WhitelabelResolutionError || error instanceof SelectionMappingError) {
        return res.status(error.status || 400).json({
            success: false,
            error: error.message,
        });
    }
    throw error;
};

router.get('/', async (req: any, res: any) => {
    try {
        const data = await listWhitelabels();
        res.json({ success: true, data });
    } catch (error) {
        handleError(res, error);
    }
});

router.post('/', async (req: any, res: any) => {
    try {
        const { name, domain, owner_user_id } = req.body || {};
        const data = await createWhitelabel({ name, domain, owner_user_id });
        res.status(201).json({ success: true, data, message: '白标站点创建成功' });
    } catch (error) {
        if (error instanceof WhitelabelResolutionError) {
            return res.status(error.status || 400).json({ success: false, error: error.message });
        }
        console.error('创建白标站点失败:', error);
        res.status(500).json({ success: false, error: '创建白标站点失败', details: (error as any)?.message });
    }
});

router.put('/:id', async (req: any, res: any) => {
    try {
        const id = Number(req.params.id);
        const { name, domain, status, owner_user_id } = req.body || {};
        const data = await updateWhitelabel(id, { name, domain, status, owner_user_id });
        res.json({ success: true, data, message: '白标站点更新成功' });
    } catch (error) {
        if (error instanceof WhitelabelResolutionError) {
            return res.status(error.status || 400).json({ success: false, error: error.message });
        }
        console.error('更新白标站点失败:', error);
        res.status(500).json({ success: false, error: '更新白标站点失败', details: (error as any)?.message });
    }
});

router.get('/:id/users', async (req: any, res: any) => {
    try {
        const id = Number(req.params.id);
        const data = await listWhitelabelUsers(id);
        res.json({ success: true, data });
    } catch (error) {
        handleError(res, error);
    }
});

router.post('/:id/users', async (req: any, res: any) => {
    try {
        const id = Number(req.params.id);
        const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
        const assigned = await assignUsersToWhitelabel(id, userIds);
        res.json({ success: true, data: { assigned }, message: '用户归属已更新' });
    } catch (error) {
        if (error instanceof WhitelabelResolutionError) {
            return res.status(error.status || 400).json({ success: false, error: error.message });
        }
        console.error('更新用户归属失败:', error);
        res.status(500).json({ success: false, error: '更新用户归属失败', details: (error as any)?.message });
    }
});

router.get('/:id/mapping', async (req: any, res: any) => {
    try {
        const id = Number(req.params.id);
        const data = await getMappingSettings(id);
        res.json({ success: true, data });
    } catch (error) {
        handleError(res, error);
    }
});

router.put('/:id/mapping', async (req: any, res: any) => {
    try {
        const id = Number(req.params.id);
        const { mode, enabled, reason } = req.body || {};
        const result = await updateMappingSettings({
            whitelabelId: id,
            operatorUserId: req.user!.id,
            mode,
            enabled,
            reason,
        });
        res.json({
            success: true,
            data: result.settings,
            message: result.changed ? `映射配置已切换到版本 ${result.settings.version}` : '映射配置无变化',
        });
    } catch (error) {
        if (error instanceof SelectionMappingError || error instanceof WhitelabelResolutionError) {
            return res.status(error.status || 400).json({ success: false, error: error.message });
        }
        console.error('切换映射配置失败:', error);
        res.status(500).json({ success: false, error: '切换映射配置失败', details: (error as any)?.message });
    }
});

router.get('/:id/mapping/audit', async (req: any, res: any) => {
    try {
        const id = Number(req.params.id);
        const limit = Number(req.query.limit || 100);
        const data = await listMappingAuditLogs(id, limit);
        res.json({ success: true, data });
    } catch (error) {
        handleError(res, error);
    }
});

export { router as whitelabelRoutes };
