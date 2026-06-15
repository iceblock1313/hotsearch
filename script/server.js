/**
 * server.js — 主入口
 *
 * 变更记录（相比原版本）：
 *   - 热搜存储：txt → data/hotspots.json（默认根目录）
 *   - 新增注册/登录系统（SQLite + bcrypt）
 *   - 新增热度系统（每人每天限 3 次）
 *   - 新增热搜过期 & 自动清理
 *   - 管理页面路由：/ → /dashboard
 *   - 邮件服务：Resend API
 */

const { spawn } = require('child_process');
const { logger, logFile } = require('./logger');

// ── 全局错误捕获 ─────────────────────────────────────────────────────────

function notifyError() {
    logger.on('finish', () => {
        const notepad = spawn('notepad', [logFile], {
            detached: true,
            stdio: 'ignore',
        });
        notepad.unref();
        process.exit(1);
    });
    logger.end();
}

process.on('unhandledRejection', (reason) => {
    logger.error(`未捕获的异步错误: ${reason?.stack || reason}`);
});
process.on('uncaughtException', (reason) => {
    logger.error(`未捕获的异常: ${reason?.stack || reason}`);
    notifyError();
});

// ── 主函数 ───────────────────────────────────────────────────────────────

function main() {
    const express = require('express');
    const session = require('express-session');
    const rateLimit = require('express-rate-limit');
    const SQLiteStore = require('connect-sqlite3')(session);
    const path = require('path');

    require('dotenv').config({ quiet: true });

    // ── 前置校验环境变量 ─────────────────────────────────────────────────
    const PASSWORD = process.env.PASSWORD;
    if (!PASSWORD) {
        throw new Error('启动失败：请在 .env 中设置 PASSWORD（注册访问码）');
    }
    const SESSION_SECRET = process.env.SESSION_SECRET;
    if (!SESSION_SECRET) {
        throw new Error('启动失败：请在 .env 中设置 SESSION_SECRET（会话加密密钥）');
    }
    if (!process.env.RESEND_API_KEY) {
        throw new Error('启动失败：请在 .env 中设置 RESEND_API_KEY（Resend API 密钥）');
    }
    if (!process.env.MAIL_FROM) {
        throw new Error('启动失败：请在 .env 中设置 MAIL_FROM（发件人邮箱）');
    }
    const TRUSTED_PROXY_HEADER = process.env.TRUSTED_PROXY_HEADER;
    const TRUSTED_PROXY_IPS = process.env.TRUSTED_PROXY_IPS?.split(',').map(ip => ip.trim()).filter(ip => ip);
    if (TRUSTED_PROXY_HEADER && !TRUSTED_PROXY_IPS?.length) {
        throw new Error('启动失败：设置了 TRUSTED_PROXY_HEADER 但未配置 TRUSTED_PROXY_IPS');
    }
    if (!TRUSTED_PROXY_HEADER && TRUSTED_PROXY_IPS?.length) {
        throw new Error('启动失败：设置了 TRUSTED_PROXY_IPS 但未配置 TRUSTED_PROXY_HEADER');
    }

    // ── 初始化数据库 ─────────────────────────────────────────────────────
    const { cleanExpiredVerifications } = require('./db');
    cleanExpiredVerifications(); // 清理启动时遗留的过期验证码

    const app = express();
    const PORT = process.env.PORT || 3000;

    // ── 信任代理 ─────────────────────────────────────────────────────────
    const trustProxy = process.env.TRUST_PROXY === 'true';
    if (trustProxy) {
        logger.info('已启用信任代理模式（适用于内网穿透/反向代理）。');
        logger.warn('⚠️  错误配置（无代理时开启）：用户可伪造 IP 绕过限流！');
    } else {
        logger.info('未启用信任代理模式（适用于直接暴露公网）。');
        logger.warn('⚠️  错误配置（有代理时关闭）：所有请求 IP 相同，限流可能集体误伤！');
    }
    app.set('trust proxy', trustProxy);

    // ── 速率限制 ─────────────────────────────────────────────────────────
    const globalLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        message: { message: '请求过于频繁，请稍后再试' },
        validate: { trustProxy: false },
    });
    app.use(globalLimiter);

    const loginLimiter = rateLimit({
        windowMs: 5 * 60 * 1000,
        max: 5,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, message: '密码尝试过于频繁，请稍后再试' },
        validate: { trustProxy: false },
    });
    // 同时限制登录和注册接口
    app.use('/api/auth/login', loginLimiter);
    app.use('/api/auth/register', loginLimiter);

    // ── Session ──────────────────────────────────────────────────────────
    app.use(session({
        store: new SQLiteStore({ db: 'sessions.db', dir: './' }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
            httpOnly: true,
            secure: false, // HTTP 环境为 false；HTTPS 时改为 true
        },
    }));

    // ── Body 解析 ────────────────────────────────────────────────────────
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, _res, next) => {
        if (req.body === undefined) req.body = {};
        next();
    });

    // ── 静态资源 ─────────────────────────────────────────────────────────
    app.use(express.static(path.join(__dirname, '..', 'public')));
    app.use('/font', express.static(path.join(__dirname, '..', 'font')));

    // ── 日志中间件 ───────────────────────────────────────────────────────
    function getRealIP(req) {

        const remoteAddr = req.socket.remoteAddress;
        if(TRUSTED_PROXY_HEADER){

        }
        const isLocal = isLocalIP(remoteAddr);

        if (isLocal && req.headers['x-forwarded-for']) {
            // 本地请求且存在 X-Forwarded-For，取第一个IP（真实客户端）
            const forwarded = req.headers['x-forwarded-for'];
            return forwarded.split(',')[0].trim();
        }
        // 其他情况：使用直接连接IP
        return remoteAddr;
    }
    function isLocalIP(ip) {
        return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
    function checkLocalIP(req) {
        const xFor = req.headers['x-forwarded-for'];
        const xReal = req.headers['x-real-ip'];
        return !xFor && !xReal && isLocalIP(req.socket.remoteAddress);
    }

    app.use((req, _res, next) => {
        const ip = getRealIP(req);
        const local = checkLocalIP(req);
        logger.info(
            `${req.method} ${req.url} - IP: ${ip} - LoggedIn: ${req.session.loggedIn || false} - local: ${local}`
        );
        next();
    });

    // ── 登录保护中间件 ───────────────────────────────────────────────────
    function requireLogin(req, res, next) {
        if (!req.session.loggedIn) {
            if (req.path.startsWith('/api/') || req.xhr) {
                return res.status(401).json({ error: '未登录，请先登录' });
            }
            return res.redirect('/');
        }
        next();
    }

    // ── 页面路由 ─────────────────────────────────────────────────────────

    // 根路由：未登录 → 登录页；已登录 → 重定向到 /dashboard
    app.get('/', (req, res) => {
        const isLocal = checkLocalIP(req);
        if (req.session.loggedIn || isLocal) {
            if (!req.session.loggedIn) req.session.loggedIn = true;
            return res.redirect('/dashboard');
        }
        res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
    });

    // 管理面板（原 /，现 /dashboard）
    app.get('/dashboard', requireLogin, (_req, res) => {
        res.sendFile(path.join(__dirname, '..', 'admin', 'admin.html'));
    });

    // 注册页（无需登录）
    app.get('/register', (_req, res) => {
        res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
    });

    // 旧 /logout GET（兼容保留）
    app.get('/logout', (req, res) => {
        req.session.destroy(() => res.redirect('/'));
    });

    // ── API 路由 ─────────────────────────────────────────────────────────

    // 认证相关（不需要 requireLogin）
    app.use('/api/auth', require('./auth'));

    // 热搜相关（需要登录）
    app.use('/api/hotspots', requireLogin, require('./hotspotsRouter'));

    // ── 404 / 错误处理 ───────────────────────────────────────────────────
    app.use((_req, res) => {
        res.status(404).json({ error: '资源不存在' });
    });

    // 内部错误
    app.use((err, _req, res, _next) => {
        logger.error(err.stack || err);
        res.status(500).json({ error: '服务器内部错误' });
    });

    // ── 启动 ─────────────────────────────────────────────────────────────
    app.listen(PORT, '127.0.0.1', () => {
        logger.info(`服务运行在 http://localhost:${PORT}`);
        logger.info(`管理面板: http://localhost:${PORT}/dashboard`);
        logger.info(`热搜文件: ${process.env.HOTSPOTS_FILE || '（根目录）data/hotspots.json'}`);
        logger.info(`热搜冷门清理阈值: 热度 < ${process.env.COLD_HEAT_THRESHOLD || 3}，超过 ${process.env.COLD_AGE_DAYS || 3} 天`);
        logger.info(`每人每天最大加热次数: ${process.env.MAX_HEAT_PER_DAY || 3}`);
        logger.info(`进程ID: ${process.pid}`);
    });
}

// ── 启动入口 ─────────────────────────────────────────────────────────────

try {
    main();
} catch (err) {
    logger.error(`主函数执行出错: ${err.stack || err}`);
    notifyError();
}
