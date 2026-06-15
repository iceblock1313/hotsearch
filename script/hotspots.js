/**
 * hotspots.js — 热搜数据层
 *
 * 数据格式（每条热搜）：
 * {
 *   id:         string  (UUID v4)
 *   text:       string  热搜内容
 *   heat:       number  热度（初始为 0）
 *   createdAt:  number  Unix ms 时间戳
 *   createdBy:  number  user_id（创建者）
 *   expireAt:   number | null  到期 Unix ms；null = 永不过期
 * }
 *
 * 排序规则：heat DESC → createdAt ASC（同热度按创建时间升序，先创建的靠前）
 */

const fs = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');
const { logger } = require('./logger');

// 默认存放在程序根目录的 data/hotspots.json
const HOTSPOTS_FILE = process.env.HOTSPOTS_FILE ||
    path.join(__dirname, 'data', 'hotspots.json');

// ── 文件读写 ───────────────────────────────────────────────────────────────

async function ensureDataDir() {
    const dir = path.dirname(HOTSPOTS_FILE);
    await fs.mkdir(dir, { recursive: true });
}

async function readAll() {
    try {
        const raw = await fs.readFile(HOTSPOTS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

async function writeAll(hotspots) {
    await ensureDataDir();
    await fs.writeFile(HOTSPOTS_FILE, JSON.stringify(hotspots, null, 2), 'utf8');
}

// ── 过期时间计算 ────────────────────────────────────────────────────────────

/**
 * @param {'today'|'week'|'month'|'never'|'custom'} type
 * @param {number|null} customMs  type='custom' 时，距现在的毫秒数（或绝对 ms 时间戳）
 * @returns {number|null}  Unix ms 到期时间，或 null（永不过期）
 */
function calcExpireAt(type, customMs = null) {
    const now = Date.now();
    switch (type) {
        case 'today': {
            // 当天 23:59:59
            const d = new Date();
            d.setHours(23, 59, 59, 999);
            return d.getTime();
        }
        case 'week':
            return now + 7 * 24 * 60 * 60 * 1000;
        case 'month':
            return now + 30 * 24 * 60 * 60 * 1000;
        case 'never':
            return null;
        case 'custom':
            if (!customMs || typeof customMs !== 'number') {
                throw new Error('custom 类型需要提供 customMs（毫秒时间戳）');
            }
            // 支持两种语义：绝对时间戳（>now）或相对毫秒数
            return customMs > now ? customMs : now + customMs;
        default:
            throw new Error(`未知的过期类型: ${type}`);
    }
}

// ── 自动清理 ────────────────────────────────────────────────────────────────

/**
 * 自动清理规则（两条都满足才删除）：
 *   1. 已过期（expireAt !== null && expireAt < now）
 *   2. 热度低于阈值（默认 3）且创建超过 N 天（默认 3 天）
 *
 * 此函数在写操作前调用，保证数据始终干净。
 */
const COLD_HEAT_THRESHOLD = parseInt(process.env.COLD_HEAT_THRESHOLD || '3', 10);
const COLD_AGE_DAYS = parseInt(process.env.COLD_AGE_DAYS || '3', 10);

function filterExpiredAndCold(hotspots) {
    const now = Date.now();
    const coldAgeMs = COLD_AGE_DAYS * 24 * 60 * 60 * 1000;

    const before = hotspots.length;
    const kept = hotspots.filter(h => {
        // 规则 1：过期删除
        if (h.expireAt !== null && h.expireAt < now) return false;
        // 规则 2：老旧冷门删除（热度低 AND 年龄够老）
        const age = now - h.createdAt;
        if (h.heat < COLD_HEAT_THRESHOLD && age > coldAgeMs) return false;
        return true;
    });

    const removed = before - kept.length;
    if (removed > 0) {
        logger.info(`自动清理热搜 ${removed} 条（过期或老旧冷门）`);
    }
    return kept;
}

// ── 排序 ──────────────────────────────────────────────────────────────────

function sortHotspots(hotspots) {
    return [...hotspots].sort((a, b) => {
        if (b.heat !== a.heat) return b.heat - a.heat;   // 热度降序
        return a.createdAt - b.createdAt;                 // 创建时间升序（更早靠前）
    });
}

// ── 公开 API ──────────────────────────────────────────────────────────────

/** 获取全部热搜（已排序，已过滤过期） */
async function getAll() {
    const raw = await readAll();
    const now = Date.now();
    // 查询时只过滤过期，不触发冷门清理（读操作不改文件）
    const active = raw.filter(h => h.expireAt === null || h.expireAt >= now);
    return sortHotspots(active);
}

/**
 * 新建热搜
 * @param {string} text
 * @param {number} userId
 * @param {'today'|'week'|'month'|'never'|'custom'} expireType
 * @param {number|null} customMs
 */
async function createHotspot(text, userId, expireType = 'week', customMs = null) {
    let all = await readAll();
    all = filterExpiredAndCold(all);

    const entry = {
        id: randomUUID(),
        text,
        heat: 0,
        createdAt: Date.now(),
        createdBy: userId,
        expireAt: calcExpireAt(expireType, customMs),
    };
    all.push(entry);
    await writeAll(all);
    return entry;
}

/**
 * 给热搜加热
 * 返回 { success, heat, reason }
 * 业务规则由调用方（路由层）结合 DB 记录判断次数；
 * 此函数只负责更新 heat 字段。
 */
async function addHeat(id) {
    let all = await readAll();
    all = filterExpiredAndCold(all);

    const idx = all.findIndex(h => h.id === id);
    if (idx === -1) return null;

    all[idx].heat += 1;
    await writeAll(all);
    return all[idx];
}

/** 更新热搜文本（仅限管理员或创建者） */
async function updateHotspot(id, text) {
    let all = await readAll();
    all = filterExpiredAndCold(all);

    const idx = all.findIndex(h => h.id === id);
    if (idx === -1) return null;

    all[idx].text = text;
    await writeAll(all);
    return all[idx];
}

/** 删除热搜 */
async function deleteHotspot(id) {
    let all = await readAll();
    const before = all.length;
    all = all.filter(h => h.id !== id);
    if (all.length === before) return false;
    await writeAll(filterExpiredAndCold(all));
    return true;
}

/** 按 id 查找单条（含过期条目，用于加热前检查） */
async function findById(id) {
    const all = await readAll();
    return all.find(h => h.id === id) || null;
}

module.exports = {
    getAll,
    createHotspot,
    addHeat,
    updateHotspot,
    deleteHotspot,
    findById,
    calcExpireAt,
};
