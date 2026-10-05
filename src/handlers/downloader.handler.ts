import { Composer, InputFile, InlineKeyboard } from 'grammy';
import { downloadMedia, downloadAudio } from '../services/downloader.service';
import { setUserDownloading, isUserDownloading } from '../middlewares/rateLimiter';
import { getTranslation, getUserLanguage } from '../utils/i18n';
import { getSubmenuBackKeyboard } from './start.handler';
import { logger } from '../utils/logger';
import { config } from '../config';
import { isFeatureEnabled } from '../services/features.service';
import { downloadLimiter } from '../utils/concurrency';
import fs from 'fs';
import path from 'path';

export const downloaderHandler = new Composer();

// Enhanced downloader regex matching various media links including short links
const urlRegex = /(https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:tiktok\.com|douyin\.com|youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|threads\.net|twitter\.com|x\.com|pinterest\.com|pin\.it)[^\s]+)/i;

export function getMediaPlatformBadge(url: string): { name: string; emoji: string } {
    const lower = (url || '').toLowerCase();
    if (lower.includes('tiktok.com') || lower.includes('douyin.com')) return { name: 'TikTok', emoji: '🎵' };
    if (lower.includes('youtube.com') || lower.includes('youtu.be')) return { name: 'YouTube', emoji: '▶️' };
    if (lower.includes('instagram.com') || lower.includes('threads.net')) return { name: 'Instagram', emoji: '📸' };
    if (lower.includes('facebook.com') || lower.includes('fb.watch') || lower.includes('fb.com')) return { name: 'Facebook', emoji: '📘' };
    if (lower.includes('twitter.com') || lower.includes('x.com')) return { name: 'X / Twitter', emoji: '🐦' };
    if (lower.includes('pinterest.com') || lower.includes('pin.it')) return { name: 'Pinterest', emoji: '📌' };
    return { name: 'Media', emoji: '🎬' };
}

interface PendingDownload {
    url: string;
    userMsgId?: number;
    timestamp: number;
}
const pendingDownloads = new Map<string, PendingDownload>();

// Periodically clean up old pending download tokens (older than 10 mins)
setInterval(() => {
    const now = Date.now();
    for (const [token, item] of pendingDownloads.entries()) {
        if (now - item.timestamp > 10 * 60 * 1000) {
            pendingDownloads.delete(token);
        }
    }
}, 5 * 60 * 1000);

export const sendDownloaderGuide = async (ctx: any) => {
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';

    const isEnabled = await isFeatureEnabled('downloader');
    if (!isEnabled) {
        return ctx.reply(
            isKm
                ? '⚠️ <b>មុខងារទាញយកវីដេអូត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                : '⚠️ <b>Media Downloader is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
            { parse_mode: 'HTML' }
        );
    }

    const t = getTranslation(userId);
    
    // Clean up user's trigger message if possible
    try {
        if (ctx.message?.message_id) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
        }
    } catch (e) {}

    await ctx.reply(
        `<b>${t.dl_guide_title}</b>\n\n${t.dl_guide_body}`,
        { 
            parse_mode: 'HTML',
            reply_markup: getSubmenuBackKeyboard(userId)
        }
    );
};

downloaderHandler.command('download', sendDownloaderGuide);
downloaderHandler.hears(['📥 ទាញយកវីដេអូ', '📥 Media Downloader', '📥 ទាញយក'], sendDownloaderGuide);

// Callback to delete temporary / result messages for clean chat
downloaderHandler.callbackQuery('delete_this_msg', async (ctx) => {
    try {
        await ctx.answerCallbackQuery({ text: 'បានលុបសារ! 🗑️' });
    } catch (e) {}
    try {
        await ctx.deleteMessage();
    } catch (e) {}
});

// Media link listener: prompts user to choose between Video HD or MP3 Audio
downloaderHandler.hears(urlRegex, async (ctx) => {
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    const rawUrl = ctx.match[1];
    const url = rawUrl.replace(/[),.!?>;:]+$/, '');
    const userMsgId = ctx.message?.message_id;

    const isEnabled = await isFeatureEnabled('downloader');
    if (!isEnabled) {
        return ctx.reply(
            isKm
                ? '⚠️ <b>មុខងារទាញយកវីដេអូត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                : '⚠️ <b>Media Downloader is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
            { parse_mode: 'HTML' }
        );
    }

    if (userId && isUserDownloading(userId)) {
        await ctx.reply(
            isKm 
                ? '⏳ <b>កំពុងទាញយកមេឌាមួយរួចហើយ!</b>\n<i>សូមមេត្តារង់ចាំឱ្យការទាញយកបច្ចុប្បន្នបញ្ចប់សិន។</i>' 
                : '⏳ <b>A download is already in progress!</b>\n<i>Please wait for the current download to finish.</i>',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const platform = getMediaPlatformBadge(url);
    const token = Math.random().toString(36).substring(2, 8);
    pendingDownloads.set(token, { url, userMsgId, timestamp: Date.now() });

    const menu = new InlineKeyboard()
        .text(isKm ? '🎬 វីដេអូ (Video HD)' : '🎬 Video HD', `dl_vid:${token}`)
        .text(isKm ? '🎵 ចម្រៀង (MP3 Audio)' : '🎵 MP3 Audio', `dl_aud:${token}`).row()
        .text(isKm ? '❌ បោះបង់ (Cancel)' : '❌ Cancel', 'delete_this_msg');

    await ctx.reply(
        isKm 
            ? `${platform.emoji} <b>រកឃើញតំណភ្ជាប់ ${platform.name}! (${platform.name} Link Detected)</b>\n\n<i>ជ្រើសរើសទម្រង់ដែលអ្នកចង់ទាញយក៖</i>` 
            : `${platform.emoji} <b>${platform.name} Link Detected!</b>\n\n<i>Choose download format:</i>`,
        {
            parse_mode: 'HTML',
            reply_markup: menu,
            reply_parameters: userMsgId ? { message_id: userMsgId } : undefined
        }
    );
});

// Callback to process chosen format (Video HD vs MP3 Audio)
downloaderHandler.callbackQuery(/^dl_(vid|aud):([a-z0-9]+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    const t = getTranslation(userId);
    const type = ctx.match[1]; // 'vid' or 'aud'
    const token = ctx.match[2];

    const pending = pendingDownloads.get(token);
    if (!pending) {
        await ctx.answerCallbackQuery({ text: isKm ? 'តំណភ្ជាប់នេះផុតកំណត់ហើយ!' : 'Link expired. Please send link again.', show_alert: true });
        return;
    }

    if (userId && isUserDownloading(userId)) {
        await ctx.answerCallbackQuery({ text: isKm ? 'កំពុងដំណើរការការទាញយកមួយផ្សេងទៀត...' : 'Another download is in progress...', show_alert: true });
        return;
    }

    // Immediately consume token and strip buttons to prevent double-clicks
    pendingDownloads.delete(token);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

    const url = pending.url;
    const userMsgId = pending.userMsgId;
    if (userId) setUserDownloading(userId, true);

    await ctx.answerCallbackQuery({ 
        text: type === 'vid' ? (isKm ? 'កំពុងចាប់ផ្តើមទាញយកវីដេអូ HD... 🎬' : 'Starting HD Video download... 🎬') : (isKm ? 'កំពុងទាញយក និងបំប្លែង MP3... 🎵' : 'Extracting MP3 Audio... 🎵') 
    });

    const isVideo = type === 'vid';
    const progressMsgId = ctx.callbackQuery.message?.message_id;

    if (progressMsgId) {
        await ctx.editMessageText(
            isVideo
                ? (isKm ? '🎬 <b>[ ▰▱▱▱▱ 20% ]</b> <i>រកឃើញតំណភ្ជាប់! កំពុងវិភាគ និងទាក់ទងម៉ាស៊ីនបម្រើ...</i>' : '🎬 <b>[ ▰▱▱▱▱ 20% ]</b> <i>Found link! Connecting to media server...</i>')
                : (isKm ? '🎵 <b>[ ▰▱▱▱▱ 20% ]</b> <i>រកឃើញតំណភ្ជាប់! កំពុងទាក់ទងម៉ាស៊ីនបម្រើទាញយកសំឡេង...</i>' : '🎵 <b>[ ▰▱▱▱▱ 20% ]</b> <i>Found link! Extracting audio stream...</i>'),
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }

    // Keep Telegram chatAction active during entire download & upload (Telegram action expires after 5s)
    const chatAction = isVideo ? 'upload_video' : 'upload_document';
    try {
        await ctx.replyWithChatAction(chatAction);
    } catch (e) {}

    const chatActionHeartbeat = setInterval(() => {
        ctx.replyWithChatAction(chatAction).catch(() => {});
    }, 4000);

    const progressTimer = setTimeout(async () => {
        try {
            if (progressMsgId && ctx.chat) {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    progressMsgId,
                    isVideo
                        ? (isKm ? '⚡ <b>[ ▰▰▰▱▱ 65% ]</b> <i>កំពុងទាញយក និងផ្គុំវីដេអូ HD (MP4)...</i>' : '⚡ <b>[ ▰▰▰▱▱ 65% ]</b> <i>Downloading and merging HD video stream...</i>')
                        : (isKm ? '⚡ <b>[ ▰▰▰▱▱ 65% ]</b> <i>កំពុងទាញយក និងបំប្លែងទៅជា MP3 គុណភាពខ្ពស់...</i>' : '⚡ <b>[ ▰▰▰▱▱ 65% ]</b> <i>Downloading and encoding high-quality MP3...</i>'),
                    { parse_mode: 'HTML' }
                );
            }
        } catch (e) {}
    }, 1200);

    let releaseSlot: (() => void) | null = null;
    try {
        if (downloadLimiter.active >= 3) {
            if (progressMsgId && ctx.chat) {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    progressMsgId,
                    isKm 
                        ? `⏳ <b>[ ▰▱▱▱▱ 15% ]</b> <i>ម៉ាស៊ីនបម្រើកំពុងទាញយកមេឌាពេញសមត្ថភាព។ ស្ថិតក្នុងជួររង់ចាំទី ${downloadLimiter.waiting + 1}... វានឹងចាប់ផ្តើមដោយស្វ័យប្រវត្តិ!</i>`
                        : `⏳ <b>[ ▰▱▱▱▱ 15% ]</b> <i>Download server at capacity. In queue position #${downloadLimiter.waiting + 1}... Starting automatically!</i>`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }
        }

        releaseSlot = await downloadLimiter.acquire();
        const dlResult = isVideo ? await downloadMedia(url) : await downloadAudio(url);
        clearTimeout(progressTimer);

        const filePath = dlResult ? (typeof dlResult === 'string' ? dlResult : dlResult.filePath) : null;
        const thumbnailPath = dlResult && typeof dlResult === 'object' ? dlResult.thumbnailPath : undefined;
        const mediaTitle = dlResult && typeof dlResult === 'object' ? dlResult.title : undefined;
        const mediaArtist = dlResult && typeof dlResult === 'object' ? dlResult.artist : undefined;
        const mediaDuration = dlResult && typeof dlResult === 'object' ? dlResult.duration : undefined;

        if (filePath && fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            const fileSizeMb = (stats.size / 1024 / 1024).toFixed(1);

            // 50MB safeguard
            if (stats.size > 49.5 * 1024 * 1024) {
                logger.warn('DOWNLOADER', `File size (${fileSizeMb}MB) exceeds 50MB limit`, { url });
                const closeBtn = new InlineKeyboard().text('🗑️ លុបសារ (Delete)', 'delete_this_msg');
                if (progressMsgId && ctx.chat) {
                    await ctx.api.editMessageText(
                        ctx.chat.id,
                        progressMsgId,
                        isKm 
                            ? `🥺 <b>ឯកសារមានទំហំធំពេក (${fileSizeMb} MB)៖</b>\n<i>Telegram Bot API កំណត់ឱ្យផ្ញើឯកសារត្រឹម 50 MB ប៉ុណ្ណោះ។</i>` 
                            : `🥺 <b>File is too large (${fileSizeMb} MB):</b>\n<i>Telegram Bot API limits uploads to 50 MB.</i>`,
                        { parse_mode: 'HTML', reply_markup: closeBtn }
                    ).catch(() => {});

                    setTimeout(() => {
                        if (ctx.chat && progressMsgId) {
                            ctx.api.deleteMessage(ctx.chat.id, progressMsgId).catch(() => {});
                        }
                    }, 15000);
                }
                try { fs.unlinkSync(filePath); } catch (e) {}
                if (thumbnailPath && fs.existsSync(thumbnailPath)) {
                    try { fs.unlinkSync(thumbnailPath); } catch (e) {}
                }
                return;
            }

            if (progressMsgId && ctx.chat) {
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    progressMsgId,
                    isKm 
                        ? `📤 <b>[ ▰▰▰▰▰ 100% ]</b> <i>ទាញយកជោគជ័យ! កំពុងផ្ញើឯកសារ (${fileSizeMb} MB)...</i>` 
                        : `📤 <b>[ ▰▰▰▰▰ 100% ]</b> <i>Download complete! Sending file (${fileSizeMb} MB)...</i>`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }

            const platform = getMediaPlatformBadge(url);
            const cleanFileName = isVideo ? `${platform.name}_Video.mp4` : `${platform.name}_Audio.mp3`;
            let sendSuccess = false;
            const docKeyboard = new InlineKeyboard().url(isKm ? '📥 ទាញយក (Download)' : '📥 Download', url);

            const safeTitle = mediaTitle ? mediaTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 100) : null;
            const safeArtist = mediaArtist ? mediaArtist.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 60) : null;

            let mediaCaption = isVideo
                ? `${platform.emoji} <b>${platform.name} - ${isKm ? 'វីដេអូ HD' : 'HD Video'}</b>`
                : `${platform.emoji} <b>${platform.name} - ${isKm ? 'ចម្រៀង MP3' : 'MP3 Audio'}</b>`;

            if (safeTitle) {
                mediaCaption += `\n📌 <b>${isKm ? 'ចំណងជើង' : 'Title'}:</b> <code>${safeTitle}</code>`;
            }
            if (safeArtist) {
                mediaCaption += `\n👤 <b>${isKm ? 'អ្នកបង្កើត' : 'Artist'}:</b> <code>${safeArtist}</code>`;
            }
            mediaCaption += `\n📦 <b>${isKm ? 'ទំហំ' : 'Size'}:</b> ${fileSizeMb} MB`;

            // 1. Send as native Video player if user chose Video
            if (isVideo) {
                try {
                    const videoOptions: any = {
                        caption: mediaCaption,
                        parse_mode: 'HTML',
                        reply_markup: docKeyboard,
                        reply_parameters: userMsgId ? { message_id: userMsgId } : undefined,
                        supports_streaming: true
                    };
                    if (mediaDuration && mediaDuration > 0) {
                        videoOptions.duration = Math.round(mediaDuration);
                    }
                    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
                        videoOptions.thumbnail = new InputFile(thumbnailPath);
                    }

                    await ctx.replyWithVideo(new InputFile(filePath, cleanFileName), videoOptions);
                    sendSuccess = true;
                    logger.success('DOWNLOADER', `Video stream sent to user ${userId}: ${cleanFileName} (${fileSizeMb} MB)`);
                } catch (vErr) {
                    logger.warn('DOWNLOADER', 'replyWithVideo failed, falling back to document upload', vErr);
                }
            } else {
                // 2. Send as Telegram Audio Player if user chose MP3 Audio
                try {
                    const audioOptions: any = {
                        caption: mediaCaption,
                        parse_mode: 'HTML',
                        reply_markup: docKeyboard,
                        reply_parameters: userMsgId ? { message_id: userMsgId } : undefined
                    };
                    if (safeTitle) audioOptions.title = safeTitle.slice(0, 80);
                    if (safeArtist) audioOptions.performer = safeArtist.slice(0, 50);
                    if (mediaDuration && mediaDuration > 0) {
                        audioOptions.duration = Math.round(mediaDuration);
                    }
                    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
                        audioOptions.thumbnail = new InputFile(thumbnailPath);
                    }

                    await ctx.replyWithAudio(new InputFile(filePath, cleanFileName), audioOptions);
                    sendSuccess = true;
                    logger.success('DOWNLOADER', `MP3 Audio sent to user ${userId}: ${cleanFileName} (${fileSizeMb} MB)`);
                } catch (audioErr) {
                    logger.warn('DOWNLOADER', 'replyWithAudio failed, falling back to document upload', audioErr);
                }
            }

            // 3. Fallback to Document if primary media format failed
            if (!sendSuccess) {
                await ctx.replyWithDocument(new InputFile(filePath, cleanFileName), {
                    caption: mediaCaption,
                    parse_mode: 'HTML',
                    reply_markup: docKeyboard,
                    reply_parameters: userMsgId ? { message_id: userMsgId } : undefined
                });
                sendSuccess = true;
                logger.success('DOWNLOADER', `Document file fallback sent to user ${userId}: ${cleanFileName} (${fileSizeMb} MB)`);
            }

            // Clean chat: Delete progress message and original user link message
            if (sendSuccess && ctx.chat) {
                if (progressMsgId) {
                    ctx.api.deleteMessage(ctx.chat.id, progressMsgId).catch(() => {});
                }
                if (userMsgId) {
                    ctx.api.deleteMessage(ctx.chat.id, userMsgId).catch(() => {});
                }
            }

            // Clean up downloaded file & thumbnail safely
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) {}
            }
            if (thumbnailPath && fs.existsSync(thumbnailPath)) {
                try { fs.unlinkSync(thumbnailPath); } catch (e) {}
            }
        } else {
            const closeBtn = new InlineKeyboard().text('🗑️ លុបសារ (Delete)', 'delete_this_msg');
            if (progressMsgId && ctx.chat) {
                await ctx.api.editMessageText(ctx.chat.id, progressMsgId, t.dl_failed, { reply_markup: closeBtn }).catch(() => {});
                setTimeout(() => {
                    if (ctx.chat && progressMsgId) {
                        ctx.api.deleteMessage(ctx.chat.id, progressMsgId).catch(() => {});
                    }
                }, 12000);
            }
        }
    } catch (error: any) {
        clearTimeout(progressTimer);
        logger.error('DOWNLOADER', 'Downloader callback execution failed', error, { url, userId });
        const closeBtn = new InlineKeyboard().text('🗑️ លុបសារ (Delete)', 'delete_this_msg');
        if (progressMsgId && ctx.chat) {
            await ctx.api.editMessageText(
                ctx.chat.id,
                progressMsgId,
                isKm 
                    ? `🥺 <b>ការទាញយកមិនបានសម្រេច៖</b>\n<i>សូមពិនិត្យមើលតំណភ្ជាប់ ឬវីដេអូអាចជាវីដេអូឯកជន (Private) ឬលើសទំហំកំណត់ 50MB។</i>` 
                    : `🥺 <b>Download failed:</b>\n<i>Please check the link. The media might be private, restricted, or over 50MB.</i>`,
                { parse_mode: 'HTML', reply_markup: closeBtn }
            ).catch(() => {});
            setTimeout(() => {
                if (ctx.chat && progressMsgId) {
                    ctx.api.deleteMessage(ctx.chat.id, progressMsgId).catch(() => {});
                }
            }, 15000);
        }
    } finally {
        if (releaseSlot) releaseSlot();
        clearInterval(chatActionHeartbeat);
        if (userId) setUserDownloading(userId, false);
        pendingDownloads.delete(token);
    }
});
