import { Bot } from 'grammy';
import { config } from './config';
import { logger } from './utils/logger';
import { startHandler } from './handlers/start.handler';
import { adminHandler, isMaintenanceModeActive } from './handlers/admin.handler';
import { downloaderHandler } from './handlers/downloader.handler';
import { visionHandler } from './handlers/vision.handler';
import { audioHandler } from './handlers/audio.handler';
import { tempmailHandler, initRealtimeMailWatcher } from './handlers/tempmail.handler';
import { rateLimiterMiddleware } from './middlewares/rateLimiter';
import { pingRedis, redisSAdd, redisGet, redisSet, isRedisConnected } from './services/redis.service';
import { pingSupabase, syncUserToSupabase } from './services/supabase.service';
import { loadUserLanguage, getUserLanguage, loadUserNotificationPreference } from './utils/i18n';
import { getTTSTextCache, TTS_LANGUAGES, loadUserVoiceGender, loadUserVoicePreference } from './services/tts.service';
import { startHealthServer, stopHealthServer } from './services/health.service';

// Process-level unhandled exception catching
process.on('unhandledRejection', (reason: any) => {
    logger.error('PROCESS', 'Unhandled Promise Rejection detected', reason);
});
process.on('uncaughtException', (err: Error) => {
    logger.error('PROCESS', 'Uncaught Exception detected', err);
});

if (!config.BOT_TOKEN) {
    logger.error('CONFIG', 'BOT_TOKEN is missing in environment variables (.env)');
    throw new Error('BOT_TOKEN is missing');
}

const bot = new Bot(config.BOT_TOKEN);

// In-memory cache for throttling Supabase user profile syncs (max once per 6 hours per user)
const syncedUsersMemory = new Map<number, number>();

async function throttleSyncUser(user: { id: number; username?: string; first_name?: string; language_code?: string }) {
    const now = Date.now();
    const lastSynced = syncedUsersMemory.get(user.id);
    if (lastSynced && now - lastSynced < 6 * 3600 * 1000) {
        return;
    }
    syncedUsersMemory.set(user.id, now);
    if (syncedUsersMemory.size > 2000) {
        const oldestKey = syncedUsersMemory.keys().next().value;
        if (oldestKey) syncedUsersMemory.delete(oldestKey);
    }

    if (isRedisConnected()) {
        const redisKey = `user:synced:${user.id}`;
        const alreadySynced = await redisGet(redisKey);
        if (alreadySynced) return;
        await redisSet(redisKey, '1', 6 * 3600).catch(() => {});
    }

    await syncUserToSupabase({
        id: user.id,
        username: user.username,
        firstName: user.first_name,
        language: user.language_code
    }).catch(() => {});
}

// Developer Request Logger Middleware: logs user activity and execution duration
bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const user = ctx.from;
    let actionType = 'unknown';
    let summary = '';

    if (ctx.message?.text) {
        actionType = 'text';
        summary = `"${ctx.message.text.substring(0, 35)}${ctx.message.text.length > 35 ? '...' : ''}"`;
    } else if (ctx.message?.voice) {
        actionType = 'voice';
        summary = `${ctx.message.voice.duration}s voice note`;
    } else if (ctx.message?.photo) {
        actionType = 'photo';
        summary = `${ctx.message.photo.length} sizes`;
    } else if (ctx.callbackQuery) {
        actionType = 'callback';
        summary = ctx.callbackQuery.data || '';
    }

    if (actionType !== 'unknown') {
        logger.logUpdate(updateId, user, actionType, summary);
    }

    if (user?.id) {
        redisSAdd('bot:active_users', user.id).catch(() => {});
        throttleSyncUser(user).catch(() => {});
    }

    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    if (duration > 1500) {
        logger.warn('PERF', `Update #${updateId} took ${duration}ms to process`, { duration, actionType });
    }
});

// Safe Callback Query Middleware: prevents timeout/expired errors from failing updates
bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
        const originalAnswer = ctx.answerCallbackQuery.bind(ctx);
        ctx.answerCallbackQuery = (async (...args: any[]) => {
            try {
                return await (originalAnswer as any)(...args);
            } catch (err: any) {
                if (err?.description?.includes('query is too old') || err?.error_code === 400) {
                    return true;
                }
                throw err;
            }
        }) as any;
    }
    await next();
});

// Rate Limiter: Protects bot from spam, flood, and API quota exhaustion
bot.use(rateLimiterMiddleware({ windowMs: 5000, maxRequests: 6 }));

// User Preferences Middleware: loads persisted preferences from Redis
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId) {
        await Promise.all([
            loadUserLanguage(userId),
            loadUserNotificationPreference(userId),
            loadUserVoiceGender(userId),
            loadUserVoicePreference(userId)
        ]).catch(() => {});
    }
    await next();
});

// Maintenance Mode Middleware: Intercepts non-admins when maintenance mode is active
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || config.ADMIN_IDS.includes(userId)) {
        return next();
    }

    const isMaint = await isMaintenanceModeActive();
    if (isMaint) {
        const isKm = getUserLanguage(userId) === 'km';
        return ctx.reply(
            isKm
                ? '🔧 <b>ប្រព័ន្ធកំពុងដំណើរការថែទាំ (Maintenance Mode)</b>\n\n<i>Admin កំពុងធ្វើបច្ចុប្បន្នភាពប្រព័ន្ធ Bot ដើម្បីបង្កើនល្បឿន និងសុវត្ថិភាព។ សូមមេត្តារង់ចាំបន្តិច!</i>'
                : '🔧 <b>System Under Maintenance</b>\n\n<i>Our administrators are updating the bot to improve performance and security. Please check back shortly!</i>',
            { parse_mode: 'HTML' }
        );
    }

    return next();
});

// Register handlers
bot.use(startHandler);
bot.use(tempmailHandler);
bot.use(adminHandler);
bot.use(downloaderHandler);
bot.use(visionHandler);
bot.use(audioHandler);

// Inline Query Handler: Allows sending cached voice notes into any chat inline as REAL VOICE
bot.on('inline_query', async (ctx) => {
    try {
        const query = ctx.inlineQuery.query.trim();
        const token = query.startsWith('v_') ? query.substring(2) : query;
        const item = await getTTSTextCache(token);

        if (item && item.voiceFileId) {
            const cfg = TTS_LANGUAGES[item.lang] || TTS_LANGUAGES['km'];
            const clean = item.text
                .replace(/https?:\/\/\S+/g, '')
                .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
                .trim();
            const snippet = clean.length > 70 ? clean.substring(0, 70) + '...' : clean;

            await ctx.answerInlineQuery([
                {
                    type: 'voice',
                    id: token,
                    voice_file_id: item.voiceFileId,
                    title: `🔊 ${cfg.flag} ${cfg.nameKm} / ${cfg.nativeName}`,
                    caption: `${cfg.flag} <b>${cfg.nameKm} (${cfg.nativeName}) - Neural Voice ✨</b>\n<i>"${snippet}"</i>`,
                    parse_mode: 'HTML'
                }
            ], { cache_time: 10, is_personal: true });
            return;
        }

        await ctx.answerInlineQuery([], { cache_time: 2, is_personal: true });
    } catch (e) {
        logger.error('INLINE_QUERY', 'Failed to answer inline query', e);
    }
});

// Initialize background services
initRealtimeMailWatcher(bot);

// Global error handling
bot.catch((err) => {
    const e: any = err.error;
    if (
        e?.description?.includes('query is too old') || 
        e?.description?.includes('message is not modified')
    ) {
        return; // Silently ignore expired queries and identical edits
    }
    const ctx = err.ctx;
    logger.error('GRAMMY', `Error while handling update #${ctx.update.update_id}`, e, {
        userId: ctx.from?.id,
        username: ctx.from?.username,
        chatId: ctx.chat?.id,
        updateId: ctx.update.update_id
    });
});

// ==========================================
// HIGH-CONCURRENCY MULTI-USER UPDATE RUNNER
// ==========================================
// Enables simultaneous, non-blocking parallel processing across multiple chats
// while maintaining strict sequential ordering within each individual chat.

async function startConcurrentBot() {
    await bot.init();
    logger.success('BOT', `Bot @${bot.botInfo.username} started successfully in Concurrent Multi-User Mode! 🚀`);
    
    // Start production health and uptime monitoring HTTP server
    startHealthServer(bot.botInfo.username);

    const redisStatus = await pingRedis();
    if (redisStatus.connected) {
        logger.success('REDIS', `Redis cloud connection active (latency: ~${redisStatus.latencyMs}ms)`);
    } else {
        logger.warn('REDIS', `Redis offline: ${redisStatus.error}`);
    }

    const supabaseStatus = await pingSupabase();
    if (supabaseStatus.connected) {
        logger.success('SUPABASE', `Supabase Cloud PostgreSQL connected (latency: ~${supabaseStatus.latencyMs}ms)`);
    } else {
        logger.warn('SUPABASE', `Supabase connection issue: ${supabaseStatus.error || 'unreachable'}`);
    }

    logger.info('COMPONENTS', `All modular handlers (Chat, Voice, Vision OCR, Downloader, TempMail Realtime, Admin, Redis Cache, Supabase DB) active.`);

    try {
        await bot.api.setMyCommands([
            { command: 'start', description: '🚀 បើកម៉ឺនុយមេ (Main Menu)' },
            { command: 'chat', description: '🤖 សន្ទនាជាមួយ AI (Gemini AI Chat)' },
            { command: 'tts', description: '🔊 បំប្លែងអក្សរទៅជាសំឡេង (Direct TTS)' },
            { command: 'status', description: '⚡ ស្ថានភាពមុខងារ (Component Status)' },
            { command: 'tempmail', description: '📧 អ៊ីមែលបណ្តោះអាសន្ន (Temp Mail)' },
            { command: 'download', description: '📥 ទាញយកវីដេអូ (TikTok, YT, FB, IG)' },
            { command: 'clean', description: '🧹 សម្អាតសារក្នុងឆាត (Clean Chat)' },
            { command: 'donate', description: '☕ ឧបត្ថម្ភ (Donation & KHQR)' },
            { command: 'help', description: '💡 ជំនួយ & ការណែនាំ (Help Guide)' },
            { command: 'admin', description: '👑 ផ្ទាំងគ្រប់គ្រង (Admin Dashboard)' },
        ]);
        logger.success('MENU', 'Bot command menu registered successfully.');
    } catch (e) {
        logger.warn('MENU', 'Could not register bot commands', e);
    }

    // Per-chat promise chains for non-blocking concurrent multi-user execution
    const chatQueues = new Map<number, Promise<void>>();
    let offset = 0;
    let isRunning = true;

    const stopBot = () => {
        if (!isRunning) return;
        isRunning = false;
        logger.info('BOT', 'Stopping concurrent bot polling...');
        stopHealthServer();
    };
    process.once('SIGINT', stopBot);
    process.once('SIGTERM', stopBot);

    while (isRunning) {
        try {
            const updates = await bot.api.getUpdates({
                offset,
                timeout: 30,
                allowed_updates: ['message', 'callback_query', 'inline_query']
            });

            for (const update of updates) {
                offset = update.update_id + 1;

                // Derive chat identifier (or fallback to update_id for unassociated updates)
                const chatId = update.message?.chat?.id ||
                               update.callback_query?.message?.chat?.id ||
                               update.inline_query?.from?.id ||
                               update.update_id;

                const prevQueue = chatQueues.get(chatId) || Promise.resolve();

                // Dispatch concurrently across different chats!
                const currentTask = prevQueue.then(async () => {
                    try {
                        await bot.handleUpdate(update);
                    } catch (err: any) {
                        logger.error('CONCURRENT_RUNNER', `Error processing update #${update.update_id}`, err);
                    }
                }).finally(() => {
                    if (chatQueues.get(chatId) === currentTask) {
                        chatQueues.delete(chatId);
                    }
                });

                chatQueues.set(chatId, currentTask);
            }
        } catch (err: any) {
            if (!isRunning) break;
            const errMsg = err?.message || String(err);
            const isTransientNetwork = err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET' || errMsg.includes('timeout') || errMsg.includes('network');
            if (!isTransientNetwork) {
                logger.error('POLLING', 'Polling loop encountered an error, reconnecting in 1.5s...', err);
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    }
}

startConcurrentBot().catch((err) => {
    logger.error('BOT_FATAL', 'Fatal error during bot initialization', err);
    process.exit(1);
});
