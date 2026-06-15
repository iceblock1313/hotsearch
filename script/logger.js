const winston = require('winston');
const path = require('path');

const logFile = path.join(process.cwd(), 'service.log');
// 自定义格式：时间戳 + 级别 + 消息
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    })
);

// 创建 logger
const logger = winston.createLogger({
    level: 'info', // 记录所有 info 及以上级别
    format: logFormat,
    transports: [
        // 文件输出（异步追加，不阻塞）
        new winston.transports.File({ filename: logFile }),
        // 控制台输出（用于开发调试）
        new winston.transports.Console()
    ]
});

module.exports = { logger, logFile };