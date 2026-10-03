import { MiddlewareFn, Context, InlineKeyboard } from 'grammy';
import { config } from '../config';
import { getUserLanguage } from '../utils/i18n';
import { logger } from '../utils/logger';
import { redisGet, redisSet, redisDel, redisIncr, isRedisConnected } from '../services/redis.service';

interface RateLimitRecord {
    count: number;
    firstRequestTime: number;
    violations: number;
    blockedUntil?: number;
    lastWarningMessageId?: number;
    isDownloading?: boolean;
}

// In-memory fallback sliding window store
const userRequestMap = new Map<number, RateLimitRecord>();

// Clean up stale users periodically every 3 minutes
setInterval(() => {
    const now = Date.now();
    for (const [userId, record] of userRequestMap.entries()) {
        if (now - record.firstRequestTime > 120000 && !record.isDownloading && (!record.blockedUntil || record.blockedUntil < now)) {
            userRequestMap.delete(userId);
        }
    }
}, 3 * 60 * 1000);

export interface RateLimiterOptions {
    windowMs?: number;        // Window duration in ms (default: 5 seconds)
    maxRequests?: number;     // Max allowed requests per window (default: 6)
}

/**
 * Distributed rate limiter with automated anti-flood cooldown and Redis persistence.
 */
export const rateLimiterMiddleware = (options: RateLimiterOptions = {}): MiddlewareFn<Context> => {
    const windowMs = options.windowMs ?? 5000;
    const maxRequests = options.maxRequests ?? 6;
    const windowSec = Math.ceil(windowMs / 1000);

    return async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId) return next();

        // Bypass rate limiting for bot administrators
        if (config.ADMIN_IDS.includes(userId)) {
            return next();
        }

        const now = Date.now();
        const isKm = getUserLanguage(userId) === 'km';

        // 1. Check if user is currently in automated temporary cooldown (blocked for flood spam)
        let isBlocked = false;
        let blockRemainingSec = 0;

        if (isRedisConnected()) {
            const blockTtl = await redisGet<number>(`ratelimit:cooldown:${userId}`);
            if (blockTtl && blockTtl > now) {
                isBlocked = true;
                blockRemainingSec = Math.ceil((blockTtl - now) / 1000);
            }
        } else {
            const memRecord = userRequestMap.get(userId);
            if (memRecord?.blockedUntil && memRecord.blockedUntil > now) {
                isBlocked = true;
                blockRemainingSec = Math.ceil((memRecord.blockedUntil - now) / 1000);
            }
        }

        if (isBlocked) {
            if (ctx.callbackQuery) {
                try {
                    await ctx.answerCallbackQuery({
                        text: isKm
                            ? `⛔ ត្រូវបានផ្អាកបណ្តោះអាសន្ន! សូមរង់ចាំ ${blockRemainingSec} វិនាទី!`
                            : `⛔ Temporary cooldown active! Please wait ${blockRemainingSec}s!`,
                        show_alert: true
                    });
                } catch (e) {}
                return;
            }
            // For regular messages, silently drop or warn if not already warned
            return;
        }

        // 2. Compute current request count in sliding window
        let requestCount = 1;
        let isExceeded = false;
        let timeLeft = 1;

        if (isRedisConnected()) {
            const key = `ratelimit:user:${userId}`;
            const count = await redisIncr(key, windowSec);
            requestCount = count ?? 1;

            if (requestCount > maxRequests) {
                isExceeded = true;
                timeLeft = windowSec;

                // If user exceeds limit by 3x (e.g. 18+ rapid requests in 5s), trigger 45s cooldown
                if (requestCount > maxRequests * 3) {
                    await redisSet(`ratelimit:cooldown:${userId}`, now + 45000, 45);
                    logger.warn('SECURITY_FLOOD', `User ${userId} placed in 45s cooldown for heavy flood spam`);
                }
            }
        } else {
            // In-memory fallback
            let record = userRequestMap.get(userId);
            if (!record || now - record.firstRequestTime > windowMs) {
                record = {
                    count: 1,
                    firstRequestTime: now,
                    violations: record?.violations || 0,
                    isDownloading: record?.isDownloading
                };
                userRequestMap.set(userId, record);
            } else {
                record.count++;
                if (record.count > maxRequests) {
                    isExceeded = true;
                    record.violations++;
                    timeLeft = Math.ceil((windowMs - (now - record.firstRequestTime)) / 1000);

                    if (record.violations >= 3 || record.count > maxRequests * 3) {
                        record.blockedUntil = now + 45000;
                        logger.warn('SECURITY_FLOOD', `User ${userId} placed in 45s memory cooldown for heavy flood spam`);
                    }
                }
            }
        }

        // 3. Handle exceeded limit
        if (isExceeded) {
            logger.warn('RATE_LIMIT', `User ${userId} exceeded rate limit (${requestCount}/${maxRequests})`);

            if (ctx.callbackQuery) {
                try {
                    await ctx.answerCallbackQuery({
                        text: isKm 
                            ? `⏳ សូមមេត្តារង់ចាំ ${timeLeft} វិនាទីទៀត មុននឹងចុចបន្ត!` 
                            : `⏳ Please slow down! Wait ${timeLeft}s before tapping again!`,
                        show_alert: true
                    });
                } catch (e) {}
                return;
            }

            try {
                const memRecord = userRequestMap.get(userId);
                if (memRecord?.lastWarningMessageId && ctx.chat) {
                    ctx.api.deleteMessage(ctx.chat.id, memRecord.lastWarningMessageId).catch(() => {});
                }

                const closeBtn = new InlineKeyboard().text('🗑️ លុប (Dismiss)', 'delete_this_msg');
                const warningMsg = await ctx.reply(
                    isKm 
                        ? `⏳ <b>សូមមេត្តារង់ចាំបន្តិច! (Please Slow Down)</b>\n<i>លោកអ្នកកំពុងផ្ញើសារញាប់ពេក។ សូមរង់ចាំ ${timeLeft} វិនាទីទៀត មុននឹងបន្ត...</i>` 
                        : `⏳ <b>Please Slow Down!</b>\n<i>You are sending requests too quickly. Please wait ${timeLeft}s before continuing...</i>`,
                    { parse_mode: 'HTML', reply_markup: closeBtn }
                );

                if (memRecord) {
                    memRecord.lastWarningMessageId = warningMsg.message_id;
                }

                // Auto-delete warning after 4 seconds
                setTimeout(() => {
                    if (ctx.chat && warningMsg.message_id) {
                        ctx.api.deleteMessage(ctx.chat.id, warningMsg.message_id).catch(() => {});
                    }
                }, 4000);
            } catch (e) {}

            return; // Halt down-stream execution
        }

        return next();
    };
};

/**
 * Feature-specific rate limit check (e.g. heavy operations like OCR, Media Download, TTS)
 */
export async function checkFeatureRateLimit(
    userId: number,
    feature: 'vision' | 'tts' | 'download',
    limitPerMin: number
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
    if (config.ADMIN_IDS.includes(userId)) {
        return { allowed: true };
    }

    if (isRedisConnected()) {
        const key = `ratelimit:feat:${feature}:${userId}`;
        const count = await redisIncr(key, 60);
        if (count && count > limitPerMin) {
            return { allowed: false, retryAfterSec: 45 };
        }
        return { allowed: true };
    }

    return { allowed: true };
}

// Helper for active download tracking
export function setUserDownloading(userId: number, downloading: boolean) {
    const record = userRequestMap.get(userId);
    if (record) {
        record.isDownloading = downloading;
    } else {
        userRequestMap.set(userId, { count: 0, firstRequestTime: Date.now(), violations: 0, isDownloading: downloading });
    }

    if (downloading) {
        redisSet(`user:downloading:${userId}`, '1', 180).catch(() => {});
    } else {
        redisDel(`user:downloading:${userId}`).catch(() => {});
    }
}

export function isUserDownloading(userId: number): boolean {
    return !!userRequestMap.get(userId)?.isDownloading;
}

export async function isUserDownloadingAsync(userId: number): Promise<boolean> {
    if (userRequestMap.get(userId)?.isDownloading) return true;
    const redisVal = await redisGet<string>(`user:downloading:${userId}`);
    return String(redisVal) === '1';
}
