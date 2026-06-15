/**
 * auth.js — 注册 / 登录 / 登出路由
 *
 * POST /api/auth/register/init   — 发送验证码（第一步）
 * POST /api/auth/register/verify — 验证码 + 访问码校验，完成注册（第二步）
 * POST /api/auth/login           — 用 QQ + 密码登录
 * POST /api/auth/logout          — 登出
 * GET  /api/auth/me              — 当前登录信息
 */

const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

const {
    findUserByQQ,
    createUser,
    upsertPendingVerification,
    findPendingByQQ,
    deletePendingByQQ,
} = require('./db');
const { sendVerificationEmail } = require('./mailer');
const { logger } = require('./logger');

const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d]).{8,30}$/;
const QQ_REGEX = /^[1-9][0-9]{4,10}$/;
const BCRYPT_ROUNDS = 12;

// ── 工具 ──────────────────────────────────────────────────────────────────

function gen6DigitCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

// ── 注册第一步：校验参数 → 发送验证码 ────────────────────────────────────

router.post('/register/init', async (req, res) => {
    const { qq, username: usernameRaw, password, accessCode } = req.body || {};
    const username = (usernameRaw || '').trim(); // 先 trim 再校验长度

    // 参数校验
    if (!qq || !QQ_REGEX.test(qq)) {
        return res.status(400).json({ success: false, message: 'QQ 号格式不正确（5-11位数字）' });
    }
    if (!username || username.length < 2 || username.length > 20) {
        return res.status(400).json({ success: false, message: '用户名长度需在 2-20 字符之间' });
    }
    if (!password || !PASSWORD_REGEX.test(password)) {
        return res.status(400).json({
            success: false,
            message: '密码至少 8 位，且须包含大写字母、小写字母、数字和特殊字符',
        });
    }

    // 访问码（环境变量 PASSWORD）
    const ACCESS_CODE = process.env.PASSWORD;
    if (!accessCode || accessCode !== ACCESS_CODE) {
        return res.status(403).json({ success: false, message: '访问码不正确，请联系管理员索要' });
    }

    // QQ 是否已注册
    if (findUserByQQ(qq)) {
        return res.status(409).json({ success: false, message: '该 QQ 号已被注册' });
    }

    try {
        // 提前哈希密码（避免验证码验证时阻塞）
        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const code = gen6DigitCode();
        const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60; // 10 分钟

        upsertPendingVerification({
            qq,
            username: username,
            password: hash,
            code,
            expiresAt,
        });

        const result = await sendVerificationEmail(qq, code, username);
        if (!result.success) {
            return res.status(502).json({ success: false, message: `邮件发送失败：${result.error}` });
        }

        res.json({ success: true, message: `验证码已发至 ${qq}@qq.com，10 分钟内有效` });
    } catch (err) {
        logger.error(`register/init 异常: ${err.stack || err}`);
        res.status(500).json({ success: false, message: '服务器内部错误' });
    }
});

// ── 注册第二步：验证码校验 → 写入用户表 ──────────────────────────────────

router.post('/register/verify', async (req, res) => {
    const { qq, code } = req.body || {};

    if (!qq || !code) {
        return res.status(400).json({ success: false, message: '参数不完整' });
    }

    const pending = findPendingByQQ(qq);
    if (!pending) {
        return res.status(404).json({ success: false, message: '未找到注册申请，请重新发送验证码' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (pending.expires_at < now) {
        deletePendingByQQ(qq);
        return res.status(410).json({ success: false, message: '验证码已过期，请重新注册' });
    }

    if (pending.code !== String(code).trim()) {
        return res.status(401).json({ success: false, message: '验证码错误' });
    }

    // 再次检查是否已被抢注
    if (findUserByQQ(qq)) {
        deletePendingByQQ(qq);
        return res.status(409).json({ success: false, message: '该 QQ 号已被注册' });
    }

    try {
        createUser({ qq, username: pending.username, password: pending.password });
        deletePendingByQQ(qq);

        logger.info(`新用户注册成功: QQ=${qq} username=${pending.username}`);
        res.json({ success: true, message: '注册成功，请登录' });
    } catch (err) {
        // username 唯一冲突
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(409).json({ success: false, message: '用户名已被占用，请更换后重新注册' });
        }
        logger.error(`register/verify 写入失败: ${err.stack || err}`);
        res.status(500).json({ success: false, message: '服务器内部错误' });
    }
});

// ── 登录 ──────────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
    const { qq, password } = req.body || {};

    if (!qq || !password) {
        return res.status(400).json({ success: false, message: '请填写 QQ 号和密码' });
    }

    const user = findUserByQQ(qq);
    if (!user) {
        return res.status(401).json({ success: false, message: 'QQ 号或密码错误' });
    }

    try {
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ success: false, message: 'QQ 号或密码错误' });
        }

        req.session.loggedIn = true;
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.qq = user.qq;

        logger.info(`用户登录: QQ=${qq} username=${user.username}`);
        res.json({ success: true, username: user.username });
    } catch (err) {
        logger.error(`login 异常: ${err.stack || err}`);
        res.status(500).json({ success: false, message: '服务器内部错误' });
    }
});

// ── 登出 ──────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// ── 当前用户信息 ───────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
    if (!req.session.loggedIn) {
        return res.status(401).json({ loggedIn: false });
    }
    res.json({
        loggedIn: true,
        userId: req.session.userId,
        username: req.session.username,
        qq: req.session.qq,
    });
});

module.exports = router;
