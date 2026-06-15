/**
 * db.js — SQLite 数据库初始化与操作封装
 * 表结构：
 *   users          — 注册用户
 *   pending_verifications — 待验证的注册请求（含验证码）
 *   heat_logs      — 每日加热记录（防刷）
 */

const Database = require('better-sqlite3');
const path = require('path');
const { logger } = require('./logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'app.db');

let _db = null;

function getDb() {
    if (_db) return _db;
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');   // 提升并发读写性能
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
    logger.info(`SQLite 数据库已连接: ${DB_PATH}`);
    return _db;
}

function initSchema(db) {
    db.exec(`
        -- 已注册用户
        CREATE TABLE IF NOT EXISTS users (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            qq          TEXT    NOT NULL UNIQUE,   -- QQ号（唯一标识）
            username    TEXT    NOT NULL UNIQUE,   -- 用户名（可与QQ不同）
            password    TEXT    NOT NULL,          -- bcrypt 哈希
            created_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- 待注册验证（验证码 10 分钟有效）
        CREATE TABLE IF NOT EXISTS pending_verifications (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            qq          TEXT    NOT NULL,
            username    TEXT    NOT NULL,
            password    TEXT    NOT NULL,          -- bcrypt 哈希（提前算好，验证后直接写入）
            code        TEXT    NOT NULL,          -- 6 位数字验证码
            expires_at  INTEGER NOT NULL,          -- Unix 时间戳（秒）
            created_at  INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- 加热日志（防止同一用户每天超过3次）
        CREATE TABLE IF NOT EXISTS heat_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            hotspot_id  TEXT    NOT NULL,          -- 热搜条目 UUID
            date        TEXT    NOT NULL,          -- YYYY-MM-DD（服务器本地日期）
            UNIQUE(user_id, hotspot_id, date)      -- 每人每条每天只计一次
        );

        -- 索引：快速查某用户某天的加热次数
        CREATE INDEX IF NOT EXISTS idx_heat_logs_user_date
            ON heat_logs(user_id, date);
    `);
}

// ── Users ──────────────────────────────────────────────────────────────────

function findUserByQQ(qq) {
    return getDb().prepare('SELECT * FROM users WHERE qq = ?').get(qq);
}

function findUserById(id) {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function createUser({ qq, username, password }) {
    return getDb()
        .prepare('INSERT INTO users (qq, username, password) VALUES (?, ?, ?)')
        .run(qq, username, password);
}

// ── Pending Verifications ──────────────────────────────────────────────────

/** 删除该 QQ 的旧验证记录，再插入新的 */
function upsertPendingVerification({ qq, username, password, code, expiresAt }) {
    const db = getDb();
    db.prepare('DELETE FROM pending_verifications WHERE qq = ?').run(qq);
    db.prepare(`
        INSERT INTO pending_verifications (qq, username, password, code, expires_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(qq, username, password, code, expiresAt);
}

function findPendingByQQ(qq) {
    return getDb()
        .prepare('SELECT * FROM pending_verifications WHERE qq = ? ORDER BY id DESC LIMIT 1')
        .get(qq);
}

function deletePendingByQQ(qq) {
    return getDb().prepare('DELETE FROM pending_verifications WHERE qq = ?').run(qq);
}

/** 定期清理过期的待验证记录（可在启动时调用一次） */
function cleanExpiredVerifications() {
    const now = Math.floor(Date.now() / 1000);
    const info = getDb()
        .prepare('DELETE FROM pending_verifications WHERE expires_at < ?')
        .run(now);
    if (info.changes > 0) {
        logger.info(`清理过期验证记录 ${info.changes} 条`);
    }
}

// ── Heat Logs ──────────────────────────────────────────────────────────────

/** 返回该用户今天已加热次数 */
function getHeatCountToday(userId, date) {
    const row = getDb()
        .prepare('SELECT COUNT(*) as cnt FROM heat_logs WHERE user_id = ? AND date = ?')
        .get(userId, date);
    return row ? row.cnt : 0;
}

/** 记录一次加热；若已存在（唯一约束）则忽略 */
function recordHeat(userId, hotspotId, date) {
    try {
        getDb()
            .prepare('INSERT OR IGNORE INTO heat_logs (user_id, hotspot_id, date) VALUES (?, ?, ?)')
            .run(userId, hotspotId, date);
        return true;
    } catch (e) {
        logger.error(`记录加热失败: ${e.message}`);
        return false;
    }
}

/** 检查用户今天是否已加热过该条目 */
function hasHeatedToday(userId, hotspotId, date) {
    const row = getDb()
        .prepare('SELECT 1 FROM heat_logs WHERE user_id = ? AND hotspot_id = ? AND date = ?')
        .get(userId, hotspotId, date);
    return !!row;
}

module.exports = {
    getDb,
    // users
    findUserByQQ,
    findUserById,
    createUser,
    // pending
    upsertPendingVerification,
    findPendingByQQ,
    deletePendingByQQ,
    cleanExpiredVerifications,
    // heat
    getHeatCountToday,
    recordHeat,
    hasHeatedToday,
};
