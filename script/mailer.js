/**
 * mailer.js — 使用 Resend 官方 SDK 发送验证邮件到 QQ 邮箱
 * 需要先安装依赖：npm install resend
 */

const { Resend } = require('resend');
const { logger } = require('./logger');

// 初始化 Resend 客户端
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;');  // 可选，应对未使用引号的属性
}
const resend = new Resend(process.env.RESEND_API_KEY);
const MAIL_FROM = process.env.MAIL_FROM; // 如：noreply@yourdomain.com（已在 Resend 验证的域名）
const SIGNATURE = escapeHtml(process.env.EMAIL_SIGNATURE) || 'HotSearch 团队';

/**
 * 发送 6 位数字验证码到指定 QQ 邮箱
 * @param {string} qq      QQ 号
 * @param {string} code    6 位数字验证码
 * @param {string} username 用户名（展示用）
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendVerificationEmail(qq, code, username) {
    if (!process.env.RESEND_API_KEY) {
        throw new Error('环境变量 RESEND_API_KEY 未配置');
    }
    if (!MAIL_FROM) {
        throw new Error('环境变量 MAIL_FROM 未配置');
    }

    const toEmail = `${qq}@qq.com`;

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes">
    <title>验证邮件</title>
</head>
<body style="margin:0; padding:0; background:#eef2f5; font-family: 'PingFang SC', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height:1.5;">
    <div style="max-width:480px; margin:40px auto; background:#ffffff; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,0.05), 0 2px 8px rgba(0,0,0,0.03); overflow:hidden;">
        <div style="padding:32px 32px 16px 32px; text-align:center; border-bottom:1px solid #eef2f6;">
            <h1 style="color:#1e2a3a; margin:0; font-size:40px; font-weight:600; letter-spacing:0.3px;"> HotSearch 账号注册</h1>
        </div>
        <div style="padding:32px 32px 28px 32px;">
            <p style="color:#2c3e4f; font-size:15px; margin:0 0 6px; line-height:1.4;">
                您好，<strong style="color:#1e2a3a; font-weight:600;">${escapeHtml(username)}</strong>
            </p>
            <p style="color:#4a627a; font-size:14px; margin:0 0 28px; line-height:1.5;">
                感谢您注册 HotSearch。请使用以下验证码完成验证：
            </p>
            <div style="background:#fbfcfd; border:1px solid #e2e8f0; border-radius:6px; padding:20px 16px; text-align:center; margin:0 0 28px;">
                <span style="font-size:34px; font-weight:700; letter-spacing:6px; color:#1e2a3a; font-family:'SF Mono', 'Menlo', 'Consolas', monospace;">${escapeHtml(code)}</span>
            </div>
            <p style="color:#6c7e97; font-size:13px; margin:0 0 4px;">
                验证码 <strong style="color:#2c3e4f;">10 分钟内</strong> 有效，请勿泄露给他人。
            </p>
            <p style="color:#8a9bb0; font-size:13px; margin:6px 0 0;">
                如非本人操作，请忽略此邮件。
            </p>
        </div>
        <!-- 底部：左侧系统提示 + 右侧自定义签名，同一行两端对齐 -->
        <div style="background:#f8fafc; padding:18px 32px; border-top:1px solid #eef2f6;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                <span style="color:#98a9c2; font-size:12px; margin:0;">此邮件由系统自动发送，请勿直接回复</span>
                <span style="color:#98a9c2; font-size:12px; margin:0;">${SIGNATURE}</span>
            </div>
        </div>
    </div>
</body>
</html>
    `.trim();

    try {
        const { data, error } = await resend.emails.send({
            from: MAIL_FROM,
            to: [toEmail],
            subject: `【HotSearch】你的注册验证码：${code}`,
            html,
        });

        if (error) {
            logger.error(`Resend 发送失败: ${error.message}`);
            return { success: false, error: error.message };
        }

        logger.info(`验证邮件已发送至 ${toEmail}，ID: ${data.id}`);
        return { success: true };
    } catch (err) {
        logger.error(`sendVerificationEmail 异常: ${err.message}`);
        return { success: false, error: err.message };
    }
}

module.exports = { sendVerificationEmail,escapeHtml };