import { Composer, Context, InlineKeyboard, InputFile } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { pingRedis, isRedisConnected, redisGet, redisSet, redisDel, redisSCard, redisSMembers } from '../services/redis.service';
import {
    pingSupabase,
    getSupabaseSubscribersCount,
    getAllSupabaseSubscriberIds,
    isSupabaseConfigured,
    fetchSupabaseSummary,
    fetchRecentConversations,
    fetchUserFullProfile,
    fetchDonationsAnalytics,
    fetchAllSupabaseUsers,
    SupabaseRegisteredUser
} from '../services/supabase.service';
import {
    FEATURES,
    FeatureKey,
    isFeatureEnabled,
    toggleFeature,
    getAllFeaturesStatus
} from '../services/features.service';
import {
    getCustomWelcomeConfig,
    setCustomWelcomePhoto,
    setCustomWelcomeCaption,
    resetCustomWelcome,
    getDefaultWelcomeCaption,
    formatWelcomeCaption,
    getAdminState,
    setAdminState
} from '../services/welcome.service';
import { getMainMenuKeyboard } from './start.handler';
import { escapeHtml } from '../utils/telegram-format';
import fs from 'fs';
import path from 'path';

export const adminHandler = new Composer();

// In-memory fallback for maintenance mode
let localMaintenanceMode = false;

export async function isMaintenanceModeActive(): Promise<boolean> {
    if (isRedisConnected()) {
        const val = await redisGet<string>('bot:maintenance_mode');
        return String(val) === '1';
    }
    return localMaintenanceMode;
}

export async function setMaintenanceMode(active: boolean): Promise<void> {
    localMaintenanceMode = active;
    if (isRedisConnected()) {
        if (active) {
            await redisSet('bot:maintenance_mode', '1');
        } else {
            await redisDel('bot:maintenance_mode');
        }
    }
}

// Admin authorization check
export const isAdmin = (ctx: Context): boolean => {
    return !!ctx.from?.id && config.ADMIN_IDS.includes(ctx.from.id);
};

// Formats uptime into a readable string
function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${days > 0 ? `${days}d ` : ''}${hours > 0 ? `${hours}h ` : ''}${mins}m ${secs}s`;
}

// Helper to inspect cache folder statistics
function getCacheFolderStats(): { count: number; sizeMb: string } {
    const downloadsDir = path.resolve(__dirname, '../../downloads');
    let count = 0;
    let bytes = 0;

    if (fs.existsSync(downloadsDir)) {
        try {
            const files = fs.readdirSync(downloadsDir);
            count = files.length;
            for (const file of files) {
                try {
                    const stat = fs.statSync(path.join(downloadsDir, file));
                    bytes += stat.size;
                } catch (e) {}
            }
        } catch (e) {}
    }

    return { count, sizeMb: (bytes / 1024 / 1024).toFixed(2) };
}

/**
 * Builds the interactive Admin Control Center dashboard
 */
async function buildAdminDashboard() {
    const mem = process.memoryUsage();
    const heapUsedMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
    const uptime = formatUptime(process.uptime());

    const cacheStats = getCacheFolderStats();
    const isMaint = await isMaintenanceModeActive();
    const maintBadge = isMaint ? '🔴 ACTIVE [Locked]' : '🟢 INACTIVE [Public]';
    const maintBtnLabel = isMaint ? '🔧 របៀបថែទាំ: [🔴 បើក]' : '🔧 របៀបថែទាំ: [🟢 បិទ]';

    const redisPing = await pingRedis();
    const redisBadge = redisPing.connected 
        ? `🟢 <code>CONNECTED [~${redisPing.latencyMs}ms]</code>` 
        : `🔴 <code>OFFLINE</code>`;

    const supabasePing = await pingSupabase();
    const supabaseBadge = supabasePing.connected
        ? `🟢 <code>CONNECTED [~${supabasePing.latencyMs}ms]</code>`
        : `🔴 <code>${supabasePing.error || 'OFFLINE'}</code>`;

    const totalUsers = isRedisConnected() ? await redisSCard('bot:active_users') : 0;
    const supabaseSubscribers = await getSupabaseSubscribersCount();

    const welcomeConfig = await getCustomWelcomeConfig();
    const welcomeBadge = welcomeConfig.enabled
        ? (welcomeConfig.photoFileId ? '🖼️ <code>[Photo + Caption]</code>' : '✍️ <code>[Text Only]</code>')
        : '🟢 <code>[Default Bilingual]</code>';

    const text = 
        `👑 <b>Admin Master Control Center</b> 👑\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 <b>Bot Engine:</b> <b>@sddaDCbOT</b> 🟢 <code>[ONLINE]</code>\n` +
        `⚡ <b>ដំណើរការបន្ត (Uptime):</b> <code>${uptime}</code>\n` +
        `💾 <b>RAM (Heap / RSS):</b> <code>${heapUsedMb} MB / ${rssMb} MB</code>\n` +
        `🗄️ <b>Redis Cloud:</b> ${redisBadge}\n` +
        `⚡ <b>Supabase DB:</b> ${supabaseBadge}\n` +
        `👥 <b>អ្នកប្រើប្រាស់ (Users):</b> <code>${totalUsers} (Redis) | ${supabaseSubscribers} (Supabase)</code>\n` +
        `🖼️ <b>សារស្វាគមន៍ (Welcome):</b> ${welcomeBadge}\n` +
        `🔧 <b>របៀបថែទាំ (Maintenance):</b> ${maintBadge}\n` +
        `📦 <b>Media Cache:</b> <code>${cacheStats.count} files (${cacheStats.sizeMb} MB)</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>ជ្រើសរើសមុខងារគ្រប់គ្រងប្រព័ន្ធខាងក្រោម៖</i>`;

    const keyboard = new InlineKeyboard()
        .text('📊 ព័ត៌មានប្រព័ន្ធ (Telemetry)', 'admin_telemetry')
        .text('🧪 សាកល្បង Ping', 'admin_ping_test')
        .row()
        .text('⚡ ទិន្នន័យ Supabase DB', 'admin_supabase')
        .text('☕ ឧបត្ថម្ភ (Donations)', 'admin_donations')
        .row()
        .text('🧩 បើក/បិទមុខងារ (Modules)', 'admin_modules')
        .text('💬 សន្ទនា AI (Dialogues)', 'admin_conversations')
        .row()
        .text('👥 អ្នកប្រើប្រាស់ (Users)', 'admin_users')
        .text('🔍 ស្វែងរកអ្នកប្រើ (Lookup)', 'admin_user_lookup')
        .row()
        .text('📢 ផ្សាយដំណឹង (Broadcast)', 'admin_broadcast')
        .text('🖼️ សារស្វាគមន៍ (Welcome Msg)', 'admin_welcome')
        .row()
        .text('📜 កំណត់ហេតុ (Logs)', 'admin_logs')
        .text('📥 ទាញយក Log File', 'admin_download_logs')
        .row()
        .text(`🧹 សម្អាត Cache (${cacheStats.sizeMb}MB)`, 'admin_purge')
        .text(maintBtnLabel, 'admin_toggle_maint')
        .row()
        .text('🔄 Refresh Dashboard', 'admin_main');

    return { text, keyboard };
}

/**
 * Builds the interactive Welcome Message Management View
 */
async function buildWelcomeManagerView() {
    const config = await getCustomWelcomeConfig();
    const isCustom = config.enabled;
    const modeBadge = isCustom
        ? (config.photoFileId ? '🖼️ <b>រូបភាព + Caption (Photo & Caption)</b>' : '✍️ <b>អត្ថបទសុទ្ធ (Text Only)</b>')
        : '🟢 <b>សារលំនាំដើមប្រព័ន្ធ (Default Bilingual)</b>';

    const rawCaption = config.caption || getDefaultWelcomeCaption();
    const captionSnippet = rawCaption.length > 250 ? rawCaption.substring(0, 250) + '...' : rawCaption;

    const photoInfo = config.photoFileId
        ? `<code>${config.photoFileId.substring(0, 24)}...</code> ✅`
        : '<i>(មិនទាន់បានដាក់រូបភាពនៅឡើយទេ)</i>';

    const text =
        `🖼️ <b>មជ្ឈមណ្ឌលគ្រប់គ្រងសារស្វាគមន៍ (Welcome Message Center)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ <b>ស្ថានភាពបច្ចុប្បន្ន៖</b> ${modeBadge}\n` +
        `📸 <b>រូបភាព (Welcome Photo)៖</b> ${photoInfo}\n` +
        `🕒 <b>ធ្វើបច្ចុប្បន្នភាព៖</b> <code>${config.updatedAt ? new Date(config.updatedAt).toLocaleString() : 'Default'}</code>\n\n` +
        `📝 <b>ខ្លឹមសារ Caption បច្ចុប្បន្ន៖</b>\n` +
        `<blockquote>${captionSnippet.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</blockquote>\n\n` +
        `💡 <b>Placeholders គាំទ្រ៖</b>\n` +
        `• <code>{name}</code> : ឈ្មោះដំបូងរបស់អ្នកប្រើ (First Name)\n` +
        `• <code>{username}</code> : Username (@username)\n` +
        `• <code>{id}</code> : Telegram User ID\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>ជ្រើសរើសសកម្មភាពដើម្បីកែសម្រួលសារស្វាគមន៍៖</i>`;

    const keyboard = new InlineKeyboard()
        .text('📸 កំណត់រូបភាព & Caption', 'admin_set_welcome_photo')
        .row()
        .text('✍️ កែសម្រួលតែ Caption', 'admin_set_welcome_caption')
        .text('👀 មើលគំរូជាក់ស្តែង (Preview)', 'admin_preview_welcome')
        .row()
        .text('🔄 ត្រឡប់ទៅ Default', 'admin_reset_welcome')
        .text('🔙 Back to Dashboard', 'admin_main');

    return { text, keyboard };
}

// Command /admin entry point
adminHandler.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) {
        logger.warn('ADMIN_SECURITY', `Unauthorized access attempt to /admin by user ${ctx.from?.id} (@${ctx.from?.username || 'unknown'})`);
        return ctx.reply('⛔ <b>Access Denied:</b> You do not have administrator permissions.', { parse_mode: 'HTML' });
    }

    const { text, keyboard } = await buildAdminDashboard();
    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Admin Dashboard Main View Callback
adminHandler.callbackQuery('admin_main', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const { text, keyboard } = await buildAdminDashboard();
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// System & Bot Telemetry Callback
adminHandler.callbackQuery('admin_telemetry', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const mem = process.memoryUsage();
    const heapUsedMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const heapTotalMb = (mem.heapTotal / 1024 / 1024).toFixed(1);
    const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
    const externalMb = (mem.external / 1024 / 1024).toFixed(1);
    const uptime = formatUptime(process.uptime());
    const cacheStats = getCacheFolderStats();

    const telemetryText = 
        `📊 <b>System & Component Live Telemetry</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 <b>Bot Engine:</b> @sddaDCbOT 🟢 <code>ONLINE [● ● ●]</code>\n` +
        `⚙️ <b>Node.js Version:</b> <code>${process.version}</code> (${process.arch} / ${process.platform})\n` +
        `⏱️ <b>Uptime:</b> <code>${uptime}</code>\n` +
        `💾 <b>Memory Breakdown:</b>\n` +
        `   • Heap Used: <code>${heapUsedMb} MB</code>\n` +
        `   • Heap Total: <code>${heapTotalMb} MB</code>\n` +
        `   • RSS Memory: <code>${rssMb} MB</code>\n` +
        `   • External C++: <code>${externalMb} MB</code>\n\n` +
        `🧩 <b>Modules Status:</b>\n` +
        `   • 🧠 Gemini 3.6 Flash: 🟢 <code>ACTIVE</code>\n` +
        `   • 🔊 Edge Neural TTS 96k: 🟢 <code>ACTIVE (10 Languages: KM, EN, ZH, KO, JA, HI, MS, ID, FIL, AR)</code>\n` +
        `   • 📸 Vision OCR OCR: 🟢 <code>ACTIVE</code>\n` +
        `   • 📥 Media Downloader: 🟢 <code>ACTIVE (H.264/AAC Ultra-Speed)</code>\n` +
        `   • 📧 TempMail Realtime: 🟢 <code>ACTIVE (4s Pulse ⚡)</code>\n` +
        `   • 🗄️ Redis Cloud Cache: 🟢 <code>ACTIVE</code>\n` +
        `   • ⚡ Supabase Cloud PostgreSQL: 🟢 <code>ACTIVE (Subscribers, History, Prefs)</code>\n\n` +
        `📦 <b>Cache Storage:</b> <code>${cacheStats.count} files (${cacheStats.sizeMb} MB)</code>\n` +
        `👑 <b>Authorized Admins:</b> <code>${config.ADMIN_IDS.join(', ')}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━`;

    const backKeyboard = new InlineKeyboard()
        .text('🔄 Refresh Telemetry', 'admin_telemetry')
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(telemetryText, {
        parse_mode: 'HTML',
        reply_markup: backKeyboard
    });
});

// Live Ping Latency Test Callback
adminHandler.callbackQuery('admin_ping_test', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'កំពុងតេស្ត Ping... 🧪' });

    // 1. Telegram API Latency
    const tgStart = Date.now();
    let tgLatency = 0;
    let tgOk = false;
    try {
        await ctx.api.getMe();
        tgLatency = Date.now() - tgStart;
        tgOk = true;
    } catch (e) {}

    // 2. Redis Cloud Latency
    const redisRes = await pingRedis();

    // 3. Supabase Cloud Latency
    const supabaseRes = await pingSupabase();

    // 4. File System I/O Latency
    const fsStart = Date.now();
    try {
        const testFile = path.resolve(__dirname, '../../downloads/.ping_test');
        fs.writeFileSync(testFile, 'ping');
        fs.unlinkSync(testFile);
    } catch (e) {}
    const fsLatency = Date.now() - fsStart;

    const tgBadge = tgOk ? (tgLatency < 100 ? '🟢' : '🟡') : '🔴';
    const redisBadge = redisRes.connected ? ((redisRes.latencyMs || 0) < 50 ? '🟢' : '🟡') : '🔴';
    const supabaseBadge = supabaseRes.connected ? ((supabaseRes.latencyMs || 0) < 150 ? '🟢' : '🟡') : '🔴';
    const fsBadge = fsLatency < 10 ? '🟢' : '🟡';

    const pingReport = 
        `🧪 <b>Live Latency & Network Diagnostics</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📡 <b>Telegram Bot API:</b> ${tgBadge} <code>${tgOk ? `${tgLatency}ms` : 'FAILED'}</code>\n` +
        `🗄️ <b>Redis Cloud Server:</b> ${redisBadge} <code>${redisRes.connected ? `~${redisRes.latencyMs}ms` : 'OFFLINE'}</code>\n` +
        `⚡ <b>Supabase Cloud DB:</b> ${supabaseBadge} <code>${supabaseRes.connected ? `~${supabaseRes.latencyMs}ms` : 'OFFLINE'}</code>\n` +
        `💾 <b>Local Disk I/O:</b> ${fsBadge} <code>${fsLatency}ms</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 <i>ពេលវេលាឆ្លើយតបកាន់តែទាប (ក្រោម 100ms) បង្ហាញថាប្រព័ន្ធដំណើរការលឿនរហ័សល្អបំផុត!</i>`;

    const keyboard = new InlineKeyboard()
        .text('🧪 សាកល្បងម្តងទៀត (Re-test)', 'admin_ping_test')
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(pingReport, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Live Supabase Database Analytics & Viewer
adminHandler.callbackQuery('admin_supabase', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'កំពុងទាញយកទិន្នន័យពី Supabase... ⚡' });

    const ping = await pingSupabase();
    const summary = await fetchSupabaseSummary();

    if (!summary) {
        return ctx.editMessageText('❌ មិនអាចទាញយកទិន្នន័យពី Supabase Cloud បានទេ។', {
            reply_markup: new InlineKeyboard().text('🔙 Back to Dashboard', 'admin_main')
        });
    }

    const recentUsersList = summary.recentUsers.map((u, i) => {
        const name = escapeHtml(u.firstName || u.username || 'User');
        const handle = u.username ? `@${escapeHtml(u.username)}` : `ID: ${u.userId}`;
        const time = u.lastActive ? new Date(u.lastActive).toLocaleDateString() : 'N/A';
        return `   ${i + 1}. <b>${name}</b> (${handle}) [<code>${time}</code>]`;
    }).join('\n');

    const recentDonationsList = summary.recentDonations.length > 0
        ? summary.recentDonations.map((d, i) => {
            const donorName = escapeHtml(d.fullName || 'Anonymous');
            return `   ${i + 1}. <b>${donorName}</b>: <code>$${d.amount} ${escapeHtml(d.currency)}</code> (${escapeHtml(d.status)}) [<code>${new Date(d.createdAt).toLocaleDateString()}</code>]`;
        }).join('\n')
        : '   <i>(មិនទាន់មានការឧបត្ថម្ភនៅឡើយទេ)</i>';

    const text =
        `⚡ <b>ទិន្នន័យផ្ទាល់ពី Supabase Cloud PostgreSQL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📡 <b>Connection Status:</b> 🟢 <code>CONNECTED [~${ping.latencyMs}ms]</code>\n` +
        `👥 <b>គណនីបានចុះឈ្មោះ (Total Users):</b> <code>${summary.totalUsers} registered</code>\n` +
        `💬 <b>ប្រវត្តិសន្ទនា (AI Dialogues):</b> <code>${summary.totalConversations} messages</code>\n` +
        `☕ <b>ចំនួនឧបត្ថម្ភ (Donations Log):</b> <code>${summary.totalDonations} transactions</code>\n\n` +
        `🕒 <b>អ្នកប្រើប្រាស់សកម្មចុងក្រោយ (Recent Active):</b>\n${recentUsersList}\n\n` +
        `💝 <b>ការឧបត្ថម្ភចុងក្រោយ (Recent Donations):</b>\n${recentDonationsList}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 <i>រាល់ទិន្នន័យទាំងអស់ត្រូវបាន Sync និងការពារសុវត្ថិភាពក្នុង Supabase Cloud Database!</i>`;

    const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Supabase Data', 'admin_supabase')
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// /supabase Command Handler
adminHandler.command('supabase', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ <b>Access Denied:</b> You do not have administrator permissions.', { parse_mode: 'HTML' });
    }

    const waitMsg = await ctx.reply('⚡ <i>កំពុងទាញយកទិន្នន័យពី Supabase Cloud Database...</i>', { parse_mode: 'HTML' });
    const ping = await pingSupabase();
    const summary = await fetchSupabaseSummary();

    if (!summary) {
        return ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, '❌ មិនអាចទាញយកទិន្នន័យពី Supabase Cloud បានទេ។');
    }

    const recentUsersList = summary.recentUsers.map((u, i) => {
        const name = escapeHtml(u.firstName || u.username || 'User');
        const handle = u.username ? `@${escapeHtml(u.username)}` : `ID: ${u.userId}`;
        const time = u.lastActive ? new Date(u.lastActive).toLocaleDateString() : 'N/A';
        return `   ${i + 1}. <b>${name}</b> (${handle}) [<code>${time}</code>]`;
    }).join('\n');

    const recentDonationsList = summary.recentDonations.length > 0
        ? summary.recentDonations.map((d, i) => {
            const donorName = escapeHtml(d.fullName || 'Anonymous');
            return `   ${i + 1}. <b>${donorName}</b>: <code>$${d.amount} ${escapeHtml(d.currency)}</code> (${escapeHtml(d.status)})`;
        }).join('\n')
        : '   <i>(មិនទាន់មាន)</i>';

    const text =
        `⚡ <b>របាយការណ៍ Supabase Cloud Database</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📡 <b>Connection Status:</b> 🟢 <code>CONNECTED [~${ping.latencyMs}ms]</code>\n` +
        `👥 <b>គណនីបានចុះឈ្មោះ (Total Users):</b> <code>${summary.totalUsers} registered</code>\n` +
        `💬 <b>ប្រវត្តិសន្ទនា (AI Dialogues):</b> <code>${summary.totalConversations} messages</code>\n` +
        `☕ <b>ចំនួនឧបត្ថម្ភ (Donations Log):</b> <code>${summary.totalDonations} transactions</code>\n\n` +
        `🕒 <b>អ្នកប្រើប្រាស់សកម្មចុងក្រោយ (Recent Active):</b>\n${recentUsersList}\n\n` +
        `💝 <b>ការឧបត្ថម្ភចុងក្រោយ (Recent Donations):</b>\n${recentDonationsList}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━`;

    await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 Admin Dashboard', 'admin_main')
    });
});

// ==========================================
// 1. Donations Hub Callback
// ==========================================
adminHandler.callbackQuery('admin_donations', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'កំពុងទាញយកទិន្នន័យឧបត្ថម្ភ... ☕' });

    const analytics = await fetchDonationsAnalytics();
    if (!analytics) {
        return ctx.editMessageText('❌ មិនអាចទាញយកទិន្នន័យឧបត្ថម្ភពី Supabase បានទេ។', {
            reply_markup: new InlineKeyboard().text('🔙 Back to Dashboard', 'admin_main')
        });
    }

    const items = analytics.donations.map((d, i) => {
        const donorName = d.fullName || d.username || 'Anonymous';
        const tierIcon = d.tier === 'milktea' ? '🧋' : (d.tier === 'coffee' ? '☕' : '💖');
        const dateStr = d.createdAt ? new Date(d.createdAt).toLocaleDateString() : 'N/A';
        const noteStr = d.note ? `\n      ↳ <i>"${escapeHtml(d.note)}"</i>` : '';
        return `<b>${i + 1}. ${tierIcon} ${escapeHtml(donorName)}</b>: <code>$${d.amount.toFixed(2)} ${d.currency}</code> (${d.status})\n   📅 <code>${dateStr}</code>${noteStr}`;
    }).join('\n\n');

    const text =
        `☕ <b>មជ្ឈមណ្ឌលគ្រប់គ្រងការឧបត្ថម្ភ (Donations Hub)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>ថវិកាទទួលបានសរុប (Total Revenue):</b> <code>$${analytics.totalRevenue.toFixed(2)} USD</code>\n` +
        `✅ <b>ប្រតិបត្តិការជោគជ័យ (Completed):</b> <code>${analytics.completedCount}</code>\n` +
        `⏳ <b>ប្រតិបត្តិការរង់ចាំ (Pending):</b> <code>${analytics.pendingCount}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 <b>បញ្ជីប្រតិបត្តិការចុងក្រោយ (Recent Donors):</b>\n\n` +
        (items || '<i>(មិនទាន់មានទិន្នន័យនៅឡើយទេ)</i>');

    const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Donations', 'admin_donations')
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// ==========================================
// 2. Module Controls & Toggles
// ==========================================
async function buildModulesView() {
    const statuses = await getAllFeaturesStatus();
    const getBadge = (enabled: boolean) => enabled ? '🟢 បើក (ON)' : '🔴 បិទ (OFF)';

    const text =
        `🧩 <b>មជ្ឈមណ្ឌលបើក/បិទមុខងារ Bot (Module Controls)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 <i>លោកអ្នកអាចចុចប៊ូតុងខាងក្រោមដើម្បីបើក ឬបិទមុខងារនីមួយៗភ្លាមៗ។ នៅពេលមុខងារណាមួយត្រូវបានបិទ សមាជិកទូទៅនឹងទទួលបានសារជូនដំណឹងថាប្រព័ន្ធកំពុងថែទាំ។</i>\n\n` +
        `🤖 <b>AI Chat:</b> ${getBadge(statuses.chat)}\n` +
        `🔊 <b>Neural TTS:</b> ${getBadge(statuses.tts)}\n` +
        `📥 <b>Media Downloader:</b> ${getBadge(statuses.downloader)}\n` +
        `📧 <b>TempMail Realtime:</b> ${getBadge(statuses.tempmail)}\n` +
        `📸 <b>Vision OCR:</b> ${getBadge(statuses.vision)}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━`;

    const keyboard = new InlineKeyboard()
        .text(`🤖 AI Chat: [${statuses.chat ? '🟢 ON' : '🔴 OFF'}]`, 'admin_toggle_feat:chat')
        .row()
        .text(`🔊 Neural TTS: [${statuses.tts ? '🟢 ON' : '🔴 OFF'}]`, 'admin_toggle_feat:tts')
        .row()
        .text(`📥 Downloader: [${statuses.downloader ? '🟢 ON' : '🔴 OFF'}]`, 'admin_toggle_feat:downloader')
        .row()
        .text(`📧 TempMail: [${statuses.tempmail ? '🟢 ON' : '🔴 OFF'}]`, 'admin_toggle_feat:tempmail')
        .row()
        .text(`📸 Vision OCR: [${statuses.vision ? '🟢 ON' : '🔴 OFF'}]`, 'admin_toggle_feat:vision')
        .row()
        .text('🔙 Back to Dashboard', 'admin_main');

    return { text, keyboard };
}

adminHandler.callbackQuery('admin_modules', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const { text, keyboard } = await buildModulesView();
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

adminHandler.callbackQuery(/^admin_toggle_feat:(chat|tts|downloader|tempmail|vision)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    const featKey = ctx.match[1] as FeatureKey;
    const nextState = await toggleFeature(featKey, ctx.from?.id);

    await ctx.answerCallbackQuery({
        text: `${FEATURES[featKey].icon} ${FEATURES[featKey].nameEn} ត្រូវបាន ${nextState ? 'បើក (ON)' : 'បិទ (OFF)'}!`,
        show_alert: true
    });

    const { text, keyboard } = await buildModulesView();
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// ==========================================
// 3. AI Dialogues Explorer Callback
// ==========================================
adminHandler.callbackQuery('admin_conversations', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'កំពុងទាញយកប្រវត្តិសន្ទនា... 💬' });

    const convs = await fetchRecentConversations(6);
    if (!convs || convs.length === 0) {
        return ctx.editMessageText('❌ មិនមានប្រវត្តិសន្ទនាក្នុង Supabase នៅឡើយទេ។', {
            reply_markup: new InlineKeyboard().text('🔙 Back to Dashboard', 'admin_main')
        });
    }

    const items = convs.map((c) => {
        const icon = c.role === 'user' ? '👤 <b>User</b>' : '🤖 <b>Gemini</b>';
        const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleTimeString('km-KH', { hour: '2-digit', minute: '2-digit' }) : '';
        const snippet = c.content.length > 150 ? c.content.substring(0, 150) + '...' : c.content;
        return `${icon} (<code>${c.userId}</code> | ${dateStr}):\n<i>"${escapeHtml(snippet)}"</i>`;
    }).join('\n\n');

    const text =
        `💬 <b>ប្រវត្តិសន្ទនា AI ចុងក្រោយ (Live AI Dialogues Explorer)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        items + '\n\n' +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 <i>Admin អាចវាយ <code>/history [User_ID]</code> ដើម្បីមើលប្រវត្តិសន្ទនារបស់អ្នកប្រើជាក់លាក់ណាម្នាក់!</i>`;

    const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Dialogues', 'admin_conversations')
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// ==========================================
// 4. User Lookup Center & Search Command
// ==========================================
adminHandler.callbackQuery('admin_user_lookup', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const text =
        `🔍 <b>មជ្ឈមណ្ឌលស្វែងរកអ្នកប្រើប្រាស់ (User Lookup Center)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `លោកអ្នកអាចស្វែងរកព័ត៌មានលម្អិតរបស់អ្នកប្រើប្រាស់ណាម្នាក់ដោយប្រើ Command ខាងក្រោម៖\n\n` +
        `👉 <code>/user [User_ID]</code>\n\n` +
        `💡 <b>ឧទាហរណ៍៖</b>\n` +
        `<code>/user 1272791365</code>\n\n` +
        `📝 <b>ព័ត៌មានដែលនឹងបង្ហាញ៖</b>\n` +
        `• ឈ្មោះ និង Telegram Username\n` +
        `• ស្ថានភាព Subscriber និង កាលបរិច្ឆេទសកម្ម\n` +
        `• ចំណូលចិត្តសំឡេង (Male/Female) & ម៉ូឌែល TTS\n` +
        `• ចំនួនសារសន្ទនា AI ក្នុង Supabase\n` +
        `• ចំនួនថវិកាដែលបានឧបត្ថម្ភ (Donations)\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━`;

    const keyboard = new InlineKeyboard()
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// /user <userId> Command Handler
adminHandler.command('user', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Access Denied.');

    const targetIdStr = ctx.match?.trim();
    if (!targetIdStr || !/^\d+$/.test(targetIdStr)) {
        return ctx.reply('⚠️ <b>សូមបញ្ជាក់ Telegram User ID!</b>\n\nទម្រង់៖ <code>/user 123456789</code>', { parse_mode: 'HTML' });
    }

    const targetId = parseInt(targetIdStr, 10);
    const waitMsg = await ctx.reply(`🔍 <i>កំពុងស្វែងរកទិន្នន័យអ្នកប្រើ ID <code>${targetId}</code>...</i>`, { parse_mode: 'HTML' });

    const profile = await fetchUserFullProfile(targetId);
    if (!profile) {
        return ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, `❌ រកមិនឃើញទិន្នន័យសម្រាប់ User ID <code>${targetId}</code> នៅក្នុង Database ទេ។`, { parse_mode: 'HTML' });
    }

    const name = profile.firstName || 'Unknown';
    const handle = profile.username ? `@${profile.username}` : 'No username';
    const subBadge = profile.isSubscriber ? '✅ Subscriber' : '⚪ Free User';
    const lastActiveStr = profile.lastActive ? new Date(profile.lastActive).toLocaleString() : 'N/A';
    const createdStr = profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : 'N/A';

    const text =
        `👤 <b>ប្រវត្តិរូបអ្នកប្រើប្រាស់ (User Profile)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🆔 <b>User ID:</b> <code>${profile.userId}</code>\n` +
        `👤 <b>ឈ្មោះ:</b> <b>${escapeHtml(name)}</b> (${handle})\n` +
        `🏅 <b>ស្ថានភាព:</b> ${subBadge}\n` +
        `🎙️ <b>ចំណូលចិត្តសំឡេង:</b> <code>${profile.gender || 'female'}</code> (${profile.ttsModel || 'auto'})\n` +
        `🕒 <b>សកម្មចុងក្រោយ:</b> <code>${lastActiveStr}</code>\n` +
        `📅 <b>ចុះឈ្មោះដំបូង:</b> <code>${createdStr}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💬 <b>សារសន្ទនា AI សរុប:</b> <code>${profile.dialogueCount} messages</code>\n` +
        `☕ <b>ឧបត្ថម្ភសរុប:</b> <code>${profile.donationCount} ដង ($${profile.totalDonated.toFixed(2)} USD)</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 <i>ផ្ញើសារផ្ទាល់៖</i> <code>/msg ${profile.userId} [សារ]</code>\n` +
        `👉 <i>មើលការសន្ទនា៖</i> <code>/history ${profile.userId}</code>`;

    const keyboard = new InlineKeyboard()
        .text('💬 មើលការសន្ទនា (History)', `admin_user_conv:${profile.userId}`)
        .row()
        .text('🔙 Admin Dashboard', 'admin_main');

    await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// /history <userId> Command Handler
adminHandler.command('history', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Access Denied.');

    const targetIdStr = ctx.match?.trim();
    if (!targetIdStr || !/^\d+$/.test(targetIdStr)) {
        return ctx.reply('⚠️ <b>សូមបញ្ជាក់ Telegram User ID!</b>\n\nទម្រង់៖ <code>/history 123456789</code>', { parse_mode: 'HTML' });
    }

    const targetId = parseInt(targetIdStr, 10);
    const convs = await fetchRecentConversations(8, targetId);

    if (convs.length === 0) {
        return ctx.reply(`❌ រកមិនឃើញប្រវត្តិសន្ទនាសម្រាប់ User ID <code>${targetId}</code> ទេ។`, { parse_mode: 'HTML' });
    }

    const items = convs.map((c) => {
        const icon = c.role === 'user' ? '👤 <b>User</b>' : '🤖 <b>AI</b>';
        const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : '';
        const snippet = c.content.length > 200 ? c.content.substring(0, 200) + '...' : c.content;
        return `${icon} (<code>${dateStr}</code>):\n<i>"${escapeHtml(snippet)}"</i>`;
    }).join('\n\n');

    const text =
        `💬 <b>ប្រវត្តិសន្ទនារបស់ User ID:</b> <code>${targetId}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        items;

    await ctx.reply(text, { parse_mode: 'HTML' });
});

// View User Dialogues Callback
adminHandler.callbackQuery(/^admin_user_conv:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    const targetId = parseInt(ctx.match[1], 10);
    await ctx.answerCallbackQuery();

    const convs = await fetchRecentConversations(8, targetId);
    if (convs.length === 0) {
        return ctx.reply(`❌ រកមិនឃើញប្រវត្តិសន្ទនាសម្រាប់ User ID <code>${targetId}</code> ទេ។`, { parse_mode: 'HTML' });
    }

    const items = convs.map((c) => {
        const icon = c.role === 'user' ? '👤 <b>User</b>' : '🤖 <b>AI</b>';
        const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : '';
        const snippet = c.content.length > 200 ? c.content.substring(0, 200) + '...' : c.content;
        return `${icon} (<code>${dateStr}</code>):\n<i>"${escapeHtml(snippet)}"</i>`;
    }).join('\n\n');

    const text =
        `💬 <b>ប្រវត្តិសន្ទនារបស់ User ID:</b> <code>${targetId}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        items;

    await ctx.reply(text, { parse_mode: 'HTML' });
});

// ==========================================
// 5. Direct Message Command (/msg <userId> <text>)
// ==========================================
adminHandler.command('msg', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Access Denied.');

    const args = ctx.match?.trim();
    if (!args) {
        return ctx.reply(
            '⚠️ <b>ទម្រង់ផ្ញើសារផ្ទាល់ទៅកាន់អ្នកប្រើប្រាស់៖</b>\n' +
            '<code>/msg [User_ID] [សារដែលចង់ផ្ញើ]</code>\n\n' +
            '💡 <b>ឧទាហរណ៍៖</b>\n' +
            '<code>/msg 1272791365 ជំរាបសួរ! អរគុណសម្រាប់ការប្រើប្រាស់ Bot របស់យើងខ្ញុំ។</code>',
            { parse_mode: 'HTML' }
        );
    }

    const firstSpace = args.indexOf(' ');
    if (firstSpace === -1) {
        return ctx.reply('⚠️ សូមបញ្ចូលសារដែលត្រូវផ្ញើផងដែរ!');
    }

    const targetIdStr = args.substring(0, firstSpace).trim();
    const content = args.substring(firstSpace + 1).trim();

    if (!/^\d+$/.test(targetIdStr) || !content) {
        return ctx.reply('⚠️ User ID ត្រូវតែជាលេខ និងសារមិនអាចទទេបានឡើយ!');
    }

    const targetId = parseInt(targetIdStr, 10);

    const formattedMessage =
        `🔔 <b>សារផ្លូវការពី Administrator</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        escapeHtml(content) + '\n' +
        `━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
        await ctx.api.sendMessage(targetId, formattedMessage, { parse_mode: 'HTML' });
        await ctx.reply(
            `✅ <b>បានផ្ញើសារដោយជោគជ័យ!</b>\n` +
            `👤 ទៅកាន់ User ID: <code>${targetId}</code>\n` +
            `📝 សារ៖ <i>"${escapeHtml(content)}"</i>`,
            { parse_mode: 'HTML' }
        );
    } catch (err: any) {
        logger.error('ADMIN_MSG', `Failed to send direct message to ${targetId}`, err);
        await ctx.reply(`❌ មិនអាចផ្ញើសារបានទេ៖ ${err.message} (អ្នកប្រើប្រាស់អាចបាន Block Bot)`);
    }
});

interface EnrichedUserItem {
    userId: number;
    username?: string;
    firstName?: string;
    createdAt?: string;
    lastActive?: string;
    source: 'supabase' | 'redis' | 'both';
    isAdmin: boolean;
}

/**
 * Builds the interactive User Base & Audience Analytics view with Supabase and Redis data.
 */
async function buildUserAnalyticsView(ctx: any, page = 0) {
    const supabaseUsers = await fetchAllSupabaseUsers();
    const redisUsers = isRedisConnected() ? await redisSMembers('bot:active_users') : [];
    
    const userMap = new Map<number, EnrichedUserItem>();

    // 1. Populate from Supabase
    for (const su of supabaseUsers) {
        userMap.set(su.userId, {
            userId: su.userId,
            username: su.username,
            firstName: su.firstName,
            createdAt: su.createdAt,
            lastActive: su.lastActive,
            source: 'supabase',
            isAdmin: config.ADMIN_IDS.includes(su.userId)
        });
    }

    // 2. Populate / merge from Redis
    for (const rId of redisUsers) {
        const id = parseInt(rId, 10);
        if (Number.isSafeInteger(id) && id > 0) {
            const existing = userMap.get(id);
            if (existing) {
                existing.source = 'both';
            } else {
                userMap.set(id, {
                    userId: id,
                    source: 'redis',
                    isAdmin: config.ADMIN_IDS.includes(id)
                });
            }
        }
    }

    // 3. Ensure admins are present
    for (const aId of config.ADMIN_IDS) {
        if (!userMap.has(aId)) {
            userMap.set(aId, {
                userId: aId,
                source: 'redis',
                isAdmin: true
            });
        }
    }

    const allUsers = Array.from(userMap.values());

    // 4. Enrich missing user names from Telegram API in parallel (up to 20 users)
    const enrichTargets = allUsers.filter(u => !u.firstName && !u.username).slice(0, 20);
    if (enrichTargets.length > 0 && ctx.api) {
        await Promise.allSettled(
            enrichTargets.map(async (u) => {
                try {
                    const chat = await ctx.api.getChat(u.userId);
                    if (chat) {
                        u.firstName = chat.first_name || u.firstName;
                        u.username = chat.username || u.username;
                    }
                } catch (e) {}
            })
        );
    }

    // 5. Sort: Admins first, then by joined date descending, then ID descending
    allUsers.sort((a, b) => {
        if (a.isAdmin && !b.isAdmin) return -1;
        if (!a.isAdmin && b.isAdmin) return 1;
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (timeA !== timeB) return timeB - timeA;
        return b.userId - a.userId;
    });

    const totalAudience = allUsers.length;
    const supabaseCount = allUsers.filter(u => u.source === 'supabase' || u.source === 'both').length;
    const redisCount = allUsers.filter(u => u.source === 'redis' || u.source === 'both').length;
    const adminCount = allUsers.filter(u => u.isAdmin).length;

    // 6. Pagination
    const pageSize = 5;
    const totalPages = Math.ceil(totalAudience / pageSize) || 1;
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const pageUsers = allUsers.slice(safePage * pageSize, (safePage + 1) * pageSize);

    // 7. Format user cards
    let userListFormatted = '';
    if (allUsers.length === 0) {
        userListFormatted = '<i>⚠️ មិនទាន់មានទិន្នន័យអ្នកប្រើប្រាស់នៅក្នុង Database នៅឡើយទេ។</i>\n';
    } else {
        userListFormatted = pageUsers.map((u, i) => {
            const rank = safePage * pageSize + i + 1;
            const name = escapeHtml(u.firstName || 'Telegram User');
            const handle = u.username ? `@${escapeHtml(u.username)}` : '<i>(គ្មាន @username)</i>';
            const roleBadge = u.isAdmin ? '👑 <b>[Super Admin]</b>' : '👤 <b>[User]</b>';
            const sourceBadge = u.source === 'both'
                ? '🟢 <code>Supabase + Redis</code>'
                : (u.source === 'supabase' ? '⚡ <code>Supabase Cloud</code>' : '🗄️ <code>Redis Active</code>');
            
            let dateStr = 'ថ្មីៗនេះ (Recent)';
            if (u.createdAt) {
                try {
                    const d = new Date(u.createdAt);
                    dateStr = d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
                } catch (e) {}
            }

            return (
                `<b>${rank}. ${name}</b> (${handle}) ${roleBadge}\n` +
                `   • 🆔 <b>User ID:</b> <code>${u.userId}</code>\n` +
                `   • 📡 <b>ប្រព័ន្ធរក្សាទុក:</b> ${sourceBadge}\n` +
                `   • 📅 <b>ចុះឈ្មោះ/សកម្ម:</b> <code>${dateStr}</code>\n` +
                `   • ⚡ <i>ពាក្យបញ្ជាផ្ទាល់:</i> <code>/user ${u.userId}</code> | <code>/msg ${u.userId} [សារ]</code>`
            );
        }).join('\n\n');
    }

    const text =
        `👥 <b>User Base & Audience Analytics (Supabase + Redis)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 <b>ចំនួនអ្នកប្រើប្រាស់សរុប (Total Audience):</b> <code>${totalAudience} នាក់</code>\n` +
        `⚡ <b>Supabase Cloud Subscribers:</b> <code>${supabaseCount}</code>\n` +
        `🗄️ <b>Redis Real-Time Active:</b> <code>${redisCount}</code>\n` +
        `👑 <b>Administrators:</b> <code>${adminCount}</code>\n` +
        `💾 <b>ស្ថានភាពទិន្នន័យ (Storage):</b> 🟢 <code>Cloud Synced Dual-Store</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 <b>បញ្ជីអ្នកប្រើប្រាស់ (All Users - ទំព័រ ${safePage + 1}/${totalPages})៖</b>\n\n` +
        `${userListFormatted}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 <i>ចុចលើឈ្មោះអ្នកប្រើប្រាស់ខាងក្រោម ដើម្បីមើលប្រវត្តិរូប និងសារសន្ទនា AI ភ្លាមៗ!</i>`;

    const keyboard = new InlineKeyboard();

    // 1-Tap inspect buttons (2 per row)
    for (let i = 0; i < pageUsers.length; i += 2) {
        const u1 = pageUsers[i];
        const u2 = pageUsers[i + 1];
        const label1 = `👤 ${u1.firstName || u1.userId} ${u1.isAdmin ? '👑' : ''}`;
        keyboard.text(label1.substring(0, 20), `admin_user_inspect:${u1.userId}`);
        if (u2) {
            const label2 = `👤 ${u2.firstName || u2.userId} ${u2.isAdmin ? '👑' : ''}`;
            keyboard.text(label2.substring(0, 20), `admin_user_inspect:${u2.userId}`);
        }
        keyboard.row();
    }

    // Pagination Row
    if (totalPages > 1) {
        if (safePage > 0) {
            keyboard.text('◀️ ថយក្រោយ', `admin_users_page:${safePage - 1}`);
        }
        keyboard.text(`📄 ${safePage + 1}/${totalPages}`, 'noop');
        if (safePage < totalPages - 1) {
            keyboard.text('បន្ទាប់ ▶️', `admin_users_page:${safePage + 1}`);
        }
        keyboard.row();
    }

    keyboard
        .text('🔄 ផ្ទុកឡើងវិញ (Refresh)', `admin_users_page:${safePage}`)
        .text('📢 ផ្សាយដំណឹង (Broadcast)', 'admin_broadcast')
        .row()
        .text('🔙 Back to Dashboard', 'admin_main');

    return { text, keyboard };
}

// User Analytics Callback (Entry point from Dashboard)
adminHandler.callbackQuery('admin_users', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const { text, keyboard } = await buildUserAnalyticsView(ctx, 0);
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// User Analytics Pagination Callback
adminHandler.callbackQuery(/^admin_users_page:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const page = parseInt(ctx.match[1], 10) || 0;
    const { text, keyboard } = await buildUserAnalyticsView(ctx, page);
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// 1-Tap inspect user callback from User Analytics list
adminHandler.callbackQuery(/^admin_user_inspect:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const targetId = parseInt(ctx.match[1], 10);
    const profile = await fetchUserFullProfile(targetId);

    let name = 'Telegram User';
    let handle = 'No username';

    try {
        const chat = await ctx.api.getChat(targetId);
        if (chat) {
            name = chat.first_name || name;
            handle = chat.username ? `@${chat.username}` : handle;
        }
    } catch (e) {}

    if (profile?.firstName) name = profile.firstName;
    if (profile?.username) handle = `@${profile.username}`;

    const subBadge = (profile?.isSubscriber || true) ? '✅ Supabase Subscriber' : '⚪ Free User';
    const lastActiveStr = profile?.lastActive ? new Date(profile.lastActive).toLocaleString() : 'N/A';
    const createdStr = profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString() : 'N/A';

    const text =
        `👤 <b>ប្រវត្តិរូបអ្នកប្រើប្រាស់ (User Profile)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🆔 <b>User ID:</b> <code>${targetId}</code>\n` +
        `👤 <b>ឈ្មោះ:</b> <b>${escapeHtml(name)}</b> (${escapeHtml(handle)})\n` +
        `🏅 <b>ស្ថានភាព:</b> ${subBadge}\n` +
        `🎙️ <b>ចំណូលចិត្តសំឡេង:</b> <code>${profile?.gender || 'female'}</code> (${profile?.ttsModel || 'auto'})\n` +
        `🕒 <b>សកម្មចុងក្រោយ:</b> <code>${lastActiveStr}</code>\n` +
        `📅 <b>ចុះឈ្មោះដំបូង:</b> <code>${createdStr}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💬 <b>សារសន្ទនា AI សរុប:</b> <code>${profile?.dialogueCount || 0} messages</code>\n` +
        `☕ <b>ឧបត្ថម្ភសរុប:</b> <code>${profile?.donationCount || 0} ដង ($${(profile?.totalDonated || 0).toFixed(2)} USD)</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 <i>ផ្ញើសារផ្ទាល់៖</i> <code>/msg ${targetId} [សារ]</code>\n` +
        `👉 <i>មើលការសន្ទនា៖</i> <code>/history ${targetId}</code>`;

    const keyboard = new InlineKeyboard()
        .text('💬 មើលការសន្ទនា (History)', `admin_user_conv:${targetId}`)
        .row()
        .text('👥 ត្រឡប់ទៅបញ្ជី Users', 'admin_users')
        .text('🔙 Admin Dashboard', 'admin_main');

    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// /users Command Handler
adminHandler.command('users', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ <b>Access Denied:</b> You do not have administrator permissions.', { parse_mode: 'HTML' });
    }
    const { text, keyboard } = await buildUserAnalyticsView(ctx, 0);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

// Inactive page counter button callback
adminHandler.callbackQuery('noop', async (ctx) => {
    await ctx.answerCallbackQuery();
});

// Broadcast Announcement Guide Callback
adminHandler.callbackQuery('admin_broadcast', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const redisUsers = isRedisConnected() ? await redisSMembers('bot:active_users') : [];
    const supabaseUserIds = await getAllSupabaseSubscriberIds();
    const combinedIds = Array.from(new Set([
        ...redisUsers.map(id => parseInt(id, 10)),
        ...supabaseUserIds
    ])).filter(id => Number.isSafeInteger(id) && id > 0);

    const text = 
        `📢 <b>Broadcast Announcement Center</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>ចំនួនអ្នកទទួលសរុប (Combined Audience):</b> <code>${combinedIds.length} users</code>\n` +
        `   • Redis Active: <code>${redisUsers.length}</code>\n` +
        `   • Supabase Subscribers: <code>${supabaseUserIds.length}</code>\n\n` +
        `📝 <b>របៀបប្រើប្រាស់មុខងារ Broadcast៖</b>\n` +
        `សូមសរសេរ Command ខាងក្រោមដើម្បីផ្ញើសារជូនដំណឹងទៅកាន់អ្នកប្រើប្រាស់ទាំងអស់៖\n\n` +
        `👉 <code>/broadcast [សាររបស់អ្នកនៅទីនេះ]</code>\n\n` +
        `💡 <b>ឧទាហរណ៍៖</b>\n` +
        `<code>/broadcast 🌟 ជំរាបសួរ! Bot បានអាប់ដេតមុខងារថ្មី ដូចជាបំប្លែងសំឡេងមនុស្សពិតៗ និងស្កេន OCR កាន់តែរហ័ស!</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━`;

    const backKeyboard = new InlineKeyboard()
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: backKeyboard
    });
});

// /broadcast <message> Command Handler
adminHandler.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ <b>Access Denied:</b> You do not have administrator permissions.', { parse_mode: 'HTML' });
    }

    const message = ctx.match?.trim();
    if (!message) {
        return ctx.reply(
            '⚠️ <b>សូមបញ្ជាក់សារដែលត្រូវផ្សាយ!</b>\n\n' +
            'ទម្រង់៖ <code>/broadcast [សារដែលចង់ផ្ញើ]</code>', 
            { parse_mode: 'HTML' }
        );
    }

    const redisUsers = isRedisConnected() ? await redisSMembers('bot:active_users') : [];
    const supabaseUserIds = await getAllSupabaseSubscriberIds();
    const combinedIds = Array.from(new Set([
        ...redisUsers.map(id => parseInt(id, 10)),
        ...supabaseUserIds
    ])).filter(id => Number.isSafeInteger(id) && id > 0);

    if (combinedIds.length === 0) {
        return ctx.reply('⚠️ រកមិនឃើញអ្នកប្រើប្រាស់នៅក្នុងបញ្ជីនៅឡើយទេ។');
    }

    const progressMsg = await ctx.reply(
        `📢 <b>កំពុងចាប់ផ្តើមផ្សាយដំណឹង...</b>\n` +
        `👥 អ្នកទទួលសរុប (Combined Audience)៖ <code>${combinedIds.length}</code> នាក់`,
        { parse_mode: 'HTML' }
    );

    let sentCount = 0;
    let failCount = 0;
    let processed = 0;

    for (const targetId of combinedIds) {
        try {
            try {
                await ctx.api.sendMessage(targetId, message, { parse_mode: 'HTML' });
            } catch (htmlErr: any) {
                if (htmlErr?.parameters?.retry_after) {
                    await new Promise(r => setTimeout(r, (htmlErr.parameters.retry_after + 1) * 1000));
                }
                // If HTML parse fails, fallback to sending plain text so broadcast succeeds
                await ctx.api.sendMessage(targetId, message);
            }
            sentCount++;
        } catch (err: any) {
            if (err?.parameters?.retry_after) {
                await new Promise(r => setTimeout(r, (err.parameters.retry_after + 1) * 1000));
                try {
                    await ctx.api.sendMessage(targetId, message);
                    sentCount++;
                } catch {
                    failCount++;
                }
            } else {
                failCount++;
            }
        }

        processed++;
        if (processed % 20 === 0 && processed < combinedIds.length) {
            await ctx.api.editMessageText(
                ctx.chat.id,
                progressMsg.message_id,
                `📢 <b>កំពុងផ្សាយដំណឹង... (${Math.round((processed / combinedIds.length) * 100)}%)</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👥 អ្នកទទួលសរុប៖ <code>${combinedIds.length}</code> នាក់\n` +
                `📤 បានផ្ញើ៖ <code>${sentCount}</code>\n` +
                `⚠️ បរាជ័យ៖ <code>${failCount}</code>`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }

        // Gentle delay to respect Telegram 30 msg/sec broadcast limit
        await new Promise(r => setTimeout(r, 45));
    }

    await ctx.api.editMessageText(
        ctx.chat.id,
        progressMsg.message_id,
        `✅ <b>ការផ្សាយដំណឹងបានបញ្ចប់ជោគជ័យ!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📤 បានផ្ញើជោគជ័យ៖ <code>${sentCount}</code> នាក់\n` +
        `⚠️ បរាជ័យ (Block/Delete)៖ <code>${failCount}</code> នាក់\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'HTML' }
    );
});

// Toggle Maintenance Mode Callback
adminHandler.callbackQuery('admin_toggle_maint', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });

    const current = await isMaintenanceModeActive();
    const nextState = !current;
    await setMaintenanceMode(nextState);

    await ctx.answerCallbackQuery({
        text: nextState ? '🔧 របៀបថែទាំត្រូវបានបើក (ON)!' : '🟢 របៀបថែទាំត្រូវបានបិទ (OFF)!',
        show_alert: true
    });

    const { text, keyboard } = await buildAdminDashboard();
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Purge Media Cache Callback
adminHandler.callbackQuery('admin_purge', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });

    const downloadsDir = path.resolve(__dirname, '../../downloads');
    let deletedCount = 0;
    let freedBytes = 0;
    const now = Date.now();
    const MIN_AGE_MS = 2 * 60 * 1000; // Keep files younger than 2 mins to prevent deleting active downloads

    if (fs.existsSync(downloadsDir)) {
        try {
            const files = fs.readdirSync(downloadsDir);
            for (const file of files) {
                try {
                    const filePath = path.join(downloadsDir, file);
                    const stat = fs.statSync(filePath);
                    if (now - stat.mtimeMs > MIN_AGE_MS) {
                        freedBytes += stat.size;
                        fs.unlinkSync(filePath);
                        deletedCount++;
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    const freedMb = (freedBytes / 1024 / 1024).toFixed(2);
    await ctx.answerCallbackQuery({ 
        text: `បានសម្អាតឯកសារ ${deletedCount} files (រួចទំហំ ${freedMb} MB)! 🧹`, 
        show_alert: true 
    });

    const { text, keyboard } = await buildAdminDashboard();
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Developer Logs Callback
adminHandler.callbackQuery('admin_logs', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const errors = logger.getRecentErrors();
    const stats = logger.getLogFileStats();

    let text = `📜 <b>Developer Error & Bug Inspector</b>\n` +
               `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
               `• <b>Recent Errors in Memory:</b> <code>${stats.errorCountInMemory}</code>\n` +
               `• <b>Server Log File:</b> <code>logs/server.log (${stats.serverLogMb} MB)</code>\n` +
               `• <b>Error Log File:</b> <code>logs/error.log (${stats.errorLogMb} MB)</code>\n` +
               `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (errors.length === 0) {
        text += `✨ <i>No errors recorded in memory! All components operating smoothly.</i>\n`;
    } else {
        text += `<b>Last ${Math.min(errors.length, 5)} Error Event(s):</b>\n`;
        errors.slice(0, 5).forEach((err, idx) => {
            const time = err.timestamp.split(' ')[1] || err.timestamp;
            const cleanMsg = err.message.replace(/</g, '&lt;').replace(/>/g, '&gt;').substring(0, 95);
            text += `\n${idx + 1}️⃣ [${time}] <b>[${err.tag}]</b>\n   <code>${cleanMsg}</code>\n`;
        });
    }

    const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Logs', 'admin_logs')
        .text('🧹 Clear Memory', 'admin_clear_logs')
        .row()
        .text('📥 Download error.log', 'admin_download_logs')
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

// Clear Logs Memory Callback
adminHandler.callbackQuery('admin_clear_logs', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    logger.clearErrors();
    await ctx.answerCallbackQuery({ text: 'Error memory buffer cleared! 🧹', show_alert: true });

    const stats = logger.getLogFileStats();
    const text = 
        `📜 <b>Developer Error & Bug Inspector</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `• <b>Recent Errors in Memory:</b> <code>0</code>\n` +
        `• <b>Server Log File:</b> <code>logs/server.log (${stats.serverLogMb} MB)</code>\n` +
        `• <b>Error Log File:</b> <code>logs/error.log (${stats.errorLogMb} MB)</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `✨ <i>Error memory buffer cleared! All components operating smoothly.</i>\n`;

    const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Logs', 'admin_logs')
        .text('🔙 Back to Dashboard', 'admin_main');

    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

// Download Log File directly in Telegram
adminHandler.callbackQuery('admin_download_logs', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'កំពុងរៀបចំឯកសារ Log... 📥' });

    const logsDir = path.resolve(__dirname, '../../logs');
    const errorLogPath = path.join(logsDir, 'error.log');
    const serverLogPath = path.join(logsDir, 'server.log');

    const targetFile = fs.existsSync(errorLogPath) && fs.statSync(errorLogPath).size > 0 
        ? errorLogPath 
        : (fs.existsSync(serverLogPath) ? serverLogPath : null);

    if (!targetFile) {
        return ctx.reply('ℹ️ Log file is currently empty or has not been created yet.');
    }

    const closeBtn = new InlineKeyboard().text('🗑️ លុបសារ (Delete)', 'delete_this_msg');
    await ctx.replyWithDocument(new InputFile(targetFile, path.basename(targetFile)), {
        caption: `📥 <b>Developer Log File:</b> <code>${path.basename(targetFile)}</code>\n\n<i>Generated securely for admin inspection.</i>`,
        parse_mode: 'HTML',
        reply_markup: closeBtn
    });
});

// ==========================================
// Welcome Message Management Callbacks & Handlers
// ==========================================

// Welcome Center Main Callback
adminHandler.callbackQuery('admin_welcome', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    const { text, keyboard } = await buildWelcomeManagerView();
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Set Welcome Photo & Caption Callback: enters awaiting photo state
adminHandler.callbackQuery('admin_set_welcome_photo', async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAdmin(ctx) || !userId) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    await setAdminState(userId, 'awaiting_welcome_photo');

    const cancelKeyboard = new InlineKeyboard()
        .text('❌ បោះបង់ (Cancel)', 'admin_cancel_state');

    await ctx.editMessageText(
        `📸 <b>កំណត់រូបភាព & Caption សម្រាប់សារស្វាគមន៍</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `សូមផ្ញើ <b>រូបភាព (Photo)</b> មួយសន្លឹក រួមជាមួយ <b>Caption</b> មកកាន់ទីនេះ។\n\n` +
        `💡 <i>Placeholders ដែលអាចប្រើក្នុង Caption៖</i>\n` +
        `• <code>{name}</code> : ឈ្មោះដំបូងរបស់អ្នកប្រើប្រាស់\n` +
        `• <code>{username}</code> : Username (@username)\n` +
        `• <code>{id}</code> : Telegram User ID\n\n` +
        `<i>(ប្រសិនបើមិនដាក់ Caption ប្រព័ន្ធនឹងប្រើប្រាស់ Caption លំនាំដើម)</i>`,
        {
            parse_mode: 'HTML',
            reply_markup: cancelKeyboard
        }
    );
});

// Set Welcome Caption Only Callback: enters awaiting caption state
adminHandler.callbackQuery('admin_set_welcome_caption', async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAdmin(ctx) || !userId) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery();

    await setAdminState(userId, 'awaiting_welcome_caption');

    const cancelKeyboard = new InlineKeyboard()
        .text('❌ បោះបង់ (Cancel)', 'admin_cancel_state');

    await ctx.editMessageText(
        `✍️ <b>កែសម្រួលតែ Caption សម្រាប់សារស្វាគមន៍</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `សូមសរសេរ និងផ្ញើសារអត្ថបទ Caption ថ្មីមកកាន់ទីនេះ (គាំទ្រ HTML Tags)៖\n\n` +
        `💡 <i>Placeholders ដែលអាចប្រើបាន៖</i>\n` +
        `• <code>{name}</code> : ឈ្មោះរបស់អ្នកប្រើប្រាស់\n` +
        `• <code>{username}</code> : Username (@username)\n` +
        `• <code>{id}</code> : Telegram User ID`,
        {
            parse_mode: 'HTML',
            reply_markup: cancelKeyboard
        }
    );
});

// Cancel Admin State Callback
adminHandler.callbackQuery('admin_cancel_state', async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAdmin(ctx) || !userId) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await setAdminState(userId, null);
    await ctx.answerCallbackQuery({ text: 'បានបោះបង់ការបញ្ចូល! ❌' });

    const { text, keyboard } = await buildWelcomeManagerView();
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Reset Welcome Message to Default Callback
adminHandler.callbackQuery('admin_reset_welcome', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });

    await resetCustomWelcome();
    await ctx.answerCallbackQuery({
        text: '🔄 សារស្វាគមន៍ត្រូវបានកំណត់ទៅ Default ដើមវិញរួចរាល់!',
        show_alert: true
    });

    const { text, keyboard } = await buildWelcomeManagerView();
    await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Preview Welcome Message Callback (Shows exactly what users see on /start)
adminHandler.callbackQuery('admin_preview_welcome', async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAdmin(ctx) || !userId) return ctx.answerCallbackQuery({ text: 'Unauthorized', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'កំពុងបង្កើតគំរូ Preview... 👀' });

    const config = await getCustomWelcomeConfig();
    const rawCaption = config.caption || getDefaultWelcomeCaption();
    const formattedCaption = formatWelcomeCaption(rawCaption, {
        firstName: ctx.from?.first_name || 'Admin',
        username: ctx.from?.username,
        id: userId
    });

    if (config.photoFileId) {
        try {
            await ctx.replyWithPhoto(config.photoFileId, {
                caption: formattedCaption,
                parse_mode: 'HTML',
                reply_markup: getMainMenuKeyboard(userId)
            });
        } catch (e) {
            await ctx.reply(formattedCaption, {
                parse_mode: 'HTML',
                reply_markup: getMainMenuKeyboard(userId)
            });
        }
    } else {
        await ctx.reply(formattedCaption, {
            parse_mode: 'HTML',
            reply_markup: getMainMenuKeyboard(userId)
        });
    }

    const backMenu = new InlineKeyboard()
        .text('🔙 ត្រឡប់ទៅ Welcome Settings', 'admin_welcome')
        .text('🗑️ លុបសារនេះ', 'delete_this_msg');

    await ctx.reply(
        `ℹ️ <i>នេះជាគំរូជាក់ស្តែងដែលអ្នកប្រើប្រាស់នឹងទទួលបាននៅពេលចុច <b>/start</b>។</i>`,
        {
            parse_mode: 'HTML',
            reply_markup: backMenu
        }
    );
});

// Intercept photo upload when admin is awaiting welcome photo
adminHandler.on('message:photo', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!isAdmin(ctx) || !userId) return next();

    const state = await getAdminState(userId);
    if (state === 'awaiting_welcome_photo') {
        const photos = ctx.message.photo;
        const bestPhoto = photos[photos.length - 1];
        const caption = ctx.message.caption;

        await setCustomWelcomePhoto(bestPhoto.file_id, caption);
        await setAdminState(userId, null);

        const keyboard = new InlineKeyboard()
            .text('👀 មើលគំរូជាក់ស្តែង (Preview)', 'admin_preview_welcome')
            .text('🔙 Welcome Settings', 'admin_welcome');

        return ctx.reply(
            `✅ <b>បានកំណត់រូបភាព & Caption សារស្វាគមន៍ជោគជ័យ!</b> 🖼️\n\n` +
            `<i>រាល់ពេលដែលអ្នកប្រើប្រាស់វាយ /start ប្រព័ន្ធនឹងផ្ញើរូបភាពនេះជាមួយ Caption ថ្មីនេះភ្លាមៗ។</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    }

    return next();
});

// Intercept text input when admin is awaiting welcome caption
adminHandler.on('message:text', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!isAdmin(ctx) || !userId) return next();

    const state = await getAdminState(userId);
    if (state === 'awaiting_welcome_caption') {
        const text = ctx.message.text.trim();
        if (text.startsWith('/cancel')) {
            await setAdminState(userId, null);
            return ctx.reply('❌ បានបោះបង់ការកែសម្រួល Caption។');
        }

        await setCustomWelcomeCaption(text);
        await setAdminState(userId, null);

        const keyboard = new InlineKeyboard()
            .text('👀 មើលគំរូជាក់ស្តែង (Preview)', 'admin_preview_welcome')
            .text('🔙 Welcome Settings', 'admin_welcome');

        return ctx.reply(
            `✅ <b>បានកែសម្រួល Caption សារស្វាគមន៍ជោគជ័យ!</b> ✍️\n\n` +
            `<i>រាល់ពេលដែលអ្នកប្រើប្រាស់វាយ /start ប្រព័ន្ធនឹងបង្ហាញ Caption ថ្មីនេះ។</i>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    }

    return next();
});

// Command /setwelcome: Convenient shortcut to update welcome caption or photo
adminHandler.command('setwelcome', async (ctx) => {
    if (!isAdmin(ctx)) {
        return ctx.reply('⛔ <b>Access Denied:</b> You do not have administrator permissions.', { parse_mode: 'HTML' });
    }

    // Check if replying to a photo
    const replyMsg = ctx.message?.reply_to_message;
    if (replyMsg && 'photo' in replyMsg && replyMsg.photo && replyMsg.photo.length > 0) {
        const bestPhoto = replyMsg.photo[replyMsg.photo.length - 1];
        const caption = ctx.match?.trim() || replyMsg.caption || undefined;

        await setCustomWelcomePhoto(bestPhoto.file_id, caption);

        const keyboard = new InlineKeyboard()
            .text('👀 មើលគំរូជាក់ស្តែង (Preview)', 'admin_preview_welcome')
            .text('🔙 Welcome Settings', 'admin_welcome');

        return ctx.reply(
            `✅ <b>បានកំណត់រូបភាព និង Caption ពីសារ Reply ជោគជ័យ!</b> 🖼️`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    }

    const caption = ctx.match?.trim();
    if (caption) {
        await setCustomWelcomeCaption(caption);

        const keyboard = new InlineKeyboard()
            .text('👀 មើលគំរូជាក់ស្តែង (Preview)', 'admin_preview_welcome')
            .text('🔙 Welcome Settings', 'admin_welcome');

        return ctx.reply(
            `✅ <b>បានកែសម្រួល Caption សារស្វាគមន៍ជោគជ័យ!</b> ✍️`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    }

    // If no text, open Welcome Manager
    const { text: welcomeText, keyboard: welcomeKb } = await buildWelcomeManagerView();
    await ctx.reply(welcomeText, {
        parse_mode: 'HTML',
        reply_markup: welcomeKb
    });
});
