/**
 * hotspotsRouter.js — 热搜 API 路由
 *
 * GET    /api/hotspots           — 获取全部热搜（已排序）
 * POST   /api/hotspots           — 新建热搜
 * PUT    /api/hotspots/:id       — 修改热搜文本
 * DELETE /api/hotspots/:id       — 删除热搜
 * POST   /api/hotspots/:id/heat  — 给热搜加热（每人每天最多 3 次）
 */

const express = require('express');
const router = express.Router();

const {
    getAll,
    createHotspot,
    addHeat,
    updateHotspot,
    deleteHotspot,
    findById,
} = require('./hotspots');

const {
    getHeatCountToday,
    recordHeat,
    hasHeatedToday,
} = require('./db');

const { logger } = require('./logger');

const MAX_HEAT_PER_DAY = parseInt(process.env.MAX_HEAT_PER_DAY || '3', 10);

// ── 工具 ──────────────────────────────────────────────────────────────────

function todayStr() {
    // 本地日期 YYYY-MM-DD（按服务器时区）
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── GET /api/hotspots ──────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const hotspots = await getAll();
        res.json(hotspots);
    } catch (err) {
        logger.error(`GET /api/hotspots 异常: ${err.stack || err}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// ── POST /api/hotspots ─────────────────────────────────────────────────────

router.post('/', async (req, res) => {
    const { text, expireType = 'week', customMs = null } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: '热搜内容不能为空' });
    }
    if (text.trim().length > 100) {
        return res.status(400).json({ error: '热搜内容不能超过 100 字' });
    }

    const validExpireTypes = ['today', 'week', 'month', 'never', 'custom'];
    if (!validExpireTypes.includes(expireType)) {
        return res.status(400).json({ error: `expireType 无效，可选值：${validExpireTypes.join('、')}` });
    }
    if (expireType === 'custom' && (!customMs || typeof customMs !== 'number')) {
        return res.status(400).json({ error: 'expireType 为 custom 时须提供 customMs（毫秒时间戳）' });
    }

    try {
        const entry = await createHotspot(
            text.trim(),
            req.session.userId,
            expireType,
            customMs,
        );
        logger.info(`新建热搜: id=${entry.id} text="${entry.text}" by userId=${req.session.userId}`);
        res.status(201).json(entry);
    } catch (err) {
        logger.error(`POST /api/hotspots 异常: ${err.stack || err}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// ── PUT /api/hotspots/:id ──────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { text } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: '热搜内容不能为空' });
    }

    try {
        const updated = await updateHotspot(id, text.trim());
        if (!updated) {
            return res.status(404).json({ error: '热搜不存在' });
        }
        res.json(updated);
    } catch (err) {
        logger.error(`PUT /api/hotspots/${id} 异常: ${err.stack || err}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// ── DELETE /api/hotspots/:id ───────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const ok = await deleteHotspot(id);
        if (!ok) {
            return res.status(404).json({ error: '热搜不存在' });
        }
        res.json({ success: true });
    } catch (err) {
        logger.error(`DELETE /api/hotspots/${id} 异常: ${err.stack || err}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

// ── POST /api/hotspots/:id/heat ────────────────────────────────────────────

router.post('/:id/heat', async (req, res) => {
    const { id } = req.params;
    const userId = req.session.userId;
    const today = todayStr();

    try {
        // 检查条目是否存在
        const existing = await findById(id);
        if (!existing) {
            return res.status(404).json({ error: '热搜不存在或已过期' });
        }

        // 检查是否已对该条目加热过（同一条每天只算一次）
        if (hasHeatedToday(userId, id, today)) {
            return res.status(429).json({
                error: '你今天已经给这条热搜加热过了',
                heat: existing.heat,
            });
        }

        // 检查今日全局加热次数
        const count = getHeatCountToday(userId, today);
        if (count >= MAX_HEAT_PER_DAY) {
            return res.status(429).json({
                error: `每天最多加热 ${MAX_HEAT_PER_DAY} 次，明天再来吧`,
                todayCount: count,
            });
        }

        // 执行加热
        const updated = await addHeat(id);
        if (!updated) {
            return res.status(404).json({ error: '热搜不存在或已过期' });
        }

        // 记录日志（IGNORE 防重复）
        recordHeat(userId, id, today);

        res.json({ success: true, heat: updated.heat, todayCount: count + 1 });
    } catch (err) {
        logger.error(`POST /api/hotspots/${id}/heat 异常: ${err.stack || err}`);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

module.exports = router;
