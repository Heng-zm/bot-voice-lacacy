import { Composer, InlineKeyboard, InputFile } from 'grammy';
import {
    generateNeuralTTS,
    generateTTS,
    detectLanguage,
    getUserVoicePreference,
    getUserVoiceGender,
    setUserVoiceGender,
    getUserVoiceSpeed,
    setUserVoiceSpeed,
    createTTSToken,
    saveTTSTextCache,
    getTTSTextCache,
    updateTTSVoiceFileId,
    VoiceGender,
    SupportedTTSLanguage,
    TTS_LANGUAGES,
    normalizeLanguageCode
} from '../services/tts.service';
import { generateResponse, transcribeAudio } from '../services/gemini.service';
import { config } from '../config';
import { getTranslation, getUserLanguage } from '../utils/i18n';
import { logger } from '../utils/logger';
import { startProcessingAnimation, safeEditMessage } from '../utils/animation';
import { escapeHtml, decodeHtmlEntities, formatTelegramHtml, sendOrEditAiResponse } from '../utils/telegram-format';
import { checkFeatureRateLimit } from '../middlewares/rateLimiter';
import { saveConversationToSupabase } from '../services/supabase.service';
import { isFeatureEnabled } from '../services/features.service';
import fs from 'fs';
import path from 'path';
import https from 'https';

export const audioHandler = new Composer();

function cleanSnippet(rawText?: string, maxLen = 100): string {
    if (!rawText) return '';
    const clean = rawText
        .replace(/https?:\/\/\S+/g, '')
        .replace(/@\w+/g, '')
        .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, '')
        .replace(/[*_`#~\[\]()<>•\-\–\—]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return '';
    if (clean.length <= maxLen) return clean;
    const truncated = clean.substring(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.7) {
        return truncated.substring(0, lastSpace) + '...';
    }
    return truncated + '...';
}

/**
 * Returns formatted caption for synthesized audio with bot voice tag
 */
export function getTTSCaption(_lang?: SupportedTTSLanguage, _gender?: VoiceGender, _isKm?: boolean): string {
    return '@voicekhaibot';
}

/**
 * Main action keyboard for voice note: provides Male/Female voice switch and Voice Speed buttons
 */
export function getTTSVoiceKeyboard(token: string, currentLang?: SupportedTTSLanguage, isKm = true): InlineKeyboard {
    return new InlineKeyboard()
        .text(isKm ? '👨 សម្លេងប្រុស' : '👨 Male Voice', `tts_v:male:${token}`)
        .text(isKm ? '👩 សម្លេងស្រី' : '👩 Female Voice', `tts_v:female:${token}`)
        .row()
        .text(isKm ? '⚡ ល្បឿនសម្លេង' : '⚡ Voice Speed', `tts_speed:${token}`);
}

/**
 * Speed selection keyboard: 0.75x, 1.0x, 1.25x, 1.5x
 */
export function getTTSSpeedPickerKeyboard(token: string, isKm = true, currentSpeed = '1.0x'): InlineKeyboard {
    const s075 = currentSpeed === '0.75x' ? '✅ 🐢 0.75x' : '🐢 0.75x';
    const s100 = currentSpeed === '1.0x' ? '✅ 🟢 1.0x' : '🟢 1.0x';
    const s125 = currentSpeed === '1.25x' ? '✅ ⚡ 1.25x' : '⚡ 1.25x';
    const s150 = currentSpeed === '1.5x' ? '✅ 🚀 1.5x' : '🚀 1.5x';

    return new InlineKeyboard()
        .text(s075, `tts_s:0.75x:${token}`)
        .text(s100, `tts_s:1.0x:${token}`)
        .row()
        .text(s125, `tts_s:1.25x:${token}`)
        .text(s150, `tts_s:1.5x:${token}`)
        .row()
        .text(isKm ? '🔙 ត្រឡប់ក្រោយ' : '🔙 Back', `tts_back:${token}`);
}

/**
 * 1-Tap Action keyboard for AI chat responses: returns undefined to keep AI chat clean without extra buttons
 */
export function getAiResponseKeyboard(isKm: boolean): InlineKeyboard | undefined {
    return undefined;
}

/**
 * Language selection keyboard supporting all 10 languages
 */
export function getTTSLanguagePickerKeyboard(token: string, isKm: boolean): InlineKeyboard {
    return new InlineKeyboard()
        .text('🇰🇭 ភាសាខ្មែរ', `tts_l:km:${token}`).text('🇺🇸 English', `tts_l:en:${token}`).row()
        .text('🇨🇳 中文 (Chinese)', `tts_l:zh:${token}`).text('🇰🇷 한국어 (Korean)', `tts_l:ko:${token}`).row()
        .text('🇯🇵 日本語 (Japanese)', `tts_l:ja:${token}`).text('🇮🇳 हिन्दी (Hindi)', `tts_l:hi:${token}`).row()
        .text('🇲🇾 Melayu', `tts_l:ms:${token}`).text('🇮🇩 Indonesia', `tts_l:id:${token}`).row()
        .text('🇵🇭 Filipino', `tts_l:fil:${token}`).text('🇸🇦 العربية (Arabic)', `tts_l:ar:${token}`).row()
        .text(isKm ? '🔙 ត្រឡប់ក្រោយ' : '🔙 Back', `tts_back:${token}`);
}

const downloadFile = (url: string, dest: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                downloadFile(response.headers.location, dest).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Audio download failed with status ${response.statusCode ?? 'unknown'}`));
                return;
            }

            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => file.close((err) => err ? reject(err) : resolve()));
            file.on('error', (err) => {
                response.destroy();
                fs.unlink(dest, () => {});
                reject(err);
            });
            response.on('error', (err) => {
                file.destroy();
                fs.unlink(dest, () => {});
                reject(err);
            });
        });
        request.on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
};

import { redisGet, redisSet } from '../services/redis.service';

export type UserMode = 'chat' | 'tts';
const userModes = new Map<number, UserMode>();

export function setUserMode(userId: number, mode: UserMode): void {
    userModes.set(userId, mode);
    redisSet(`user:mode:${userId}`, mode, 86400).catch(() => {});
}

export function getUserMode(userId?: number): UserMode {
    if (!userId) return 'chat';
    return userModes.get(userId) || 'chat';
}

export async function loadUserMode(userId: number): Promise<UserMode> {
    if (userModes.has(userId)) return userModes.get(userId)!;
    const cached = await redisGet<UserMode>(`user:mode:${userId}`);
    if (cached === 'tts' || cached === 'chat') {
        userModes.set(userId, cached);
        return cached;
    }
    userModes.set(userId, 'chat');
    return 'chat';
}

// Direct TTS command: /tts or /tts <lang> <text> or /tts <text>
audioHandler.command('tts', async (ctx) => {
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    const match = ctx.match?.trim();

    if (!match) {
        if (userId) setUserMode(userId, 'tts');

        const studioHelp = isKm ?
            `🔊 <b>ស្ទូឌីយោបំប្លែងអក្សរទៅជាសំឡេង (Edge Neural TTS Studio)</b>\n` +
            `⚡ <b>ស្ថានភាព៖</b> 🟢 <code>ONLINE [Studio Quality 96kbps]</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🌍 <b>គាំទ្រ ១០ ភាសាជាផ្លូវការ (Supported 10 Languages)៖</b>\n` +
            `• 🇰🇭 <b>ភាសាខ្មែរ (Khmer):</b> Piseth (ប្រុស) & Sreymom (ស្រី)\n` +
            `• 🇺🇸 <b>ភាសាអង់គ្លេស (English):</b> Guy (Male) & Jenny (Female)\n` +
            `• 🇨🇳 <b>ភាសាចិន (Chinese):</b> Yunxi (Male) & Xiaoxiao (Female)\n` +
            `• 🇰🇷 <b>ភាសាកូរ៉េ (Korean):</b> InJoon (Male) & SunHi (Female)\n` +
            `• 🇯🇵 <b>ភាសាជប៉ុន (Japanese):</b> Keita (Male) & Nanami (Female)\n` +
            `• 🇮🇳 <b>ភាសាហិណ្ឌី (Hindi):</b> Madhur (Male) & Swara (Female)\n` +
            `• 🇲🇾 <b>ភាសាម៉ាឡេស៊ី (Malay):</b> Osman (Male) & Yasmin (Female)\n` +
            `• 🇮🇩 <b>ភាសាឥណ្ឌូនេស៊ី (Indonesian):</b> Ardi (Male) & Gadis (Female)\n` +
            `• 🇵🇭 <b>ភាសាហ្វីលីពីន (Filipino):</b> Angelo (Male) & Blessica (Female)\n` +
            `• 🇸🇦 <b>ភាសាអារ៉ាប់ (Arabic):</b> Hamed (Male) & Zariyah (Female)\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 <b>របៀបប្រើប្រាស់៖</b>\n` +
            `១. <b>ផ្ញើសារអក្សរធម្មតា៖</b> ប្រព័ន្ធស្គាល់ភាសាទាំង ១០ ដោយស្វ័យប្រវត្តិ (Auto-Detect)\n` +
            `២. <b>បញ្ជាក់ភាសាផ្ទាល់៖</b> <code>/tts [ភាសា] [អត្ថបទ]</code>\n` +
            `   • ឧទាហរណ៍៖ <code>/tts zh 你好</code> (ចិន)\n` +
            `   • ឧទាហរណ៍៖ <code>/tts ja おはよう</code> (ជប៉ុន)\n` +
            `   • ឧទាហរណ៍៖ <code>/tts ko 안녕하세요</code> (កូរ៉េ)\n` +
            `   • ឧទាហរណ៍៖ <code>/tts km សួស្តីកម្ពុជា</code> (ខ្មែរ)\n` +
            `   • ឧទាហរណ៍៖ <code>/tts en Hello world</code> (អង់គ្លេស)\n\n` +
            `👇 <i>សូមផ្ញើអត្ថបទមកទីនេះ ដើម្បីបំប្លែងទៅជាសំឡេងភ្លាមៗ!</i>`
            :
            `🔊 <b>Edge Neural Text-to-Speech Studio (TTS)</b>\n` +
            `⚡ <b>Status:</b> 🟢 <code>ONLINE [Studio Quality 96kbps]</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🌍 <b>Supports 10 Global Languages:</b>\n` +
            `• 🇰🇭 <b>Khmer:</b> Piseth (Male) & Sreymom (Female)\n` +
            `• 🇺🇸 <b>English:</b> Guy (Male) & Jenny (Female)\n` +
            `• 🇨🇳 <b>Chinese:</b> Yunxi (Male) & Xiaoxiao (Female)\n` +
            `• 🇰🇷 <b>Korean:</b> InJoon (Male) & SunHi (Female)\n` +
            `• 🇯🇵 <b>Japanese:</b> Keita (Male) & Nanami (Female)\n` +
            `• 🇮🇳 <b>Hindi:</b> Madhur (Male) & Swara (Female)\n` +
            `• 🇲🇾 <b>Malay:</b> Osman (Male) & Yasmin (Female)\n` +
            `• 🇮🇩 <b>Indonesian:</b> Ardi (Male) & Gadis (Female)\n` +
            `• 🇵🇭 <b>Filipino:</b> Angelo (Male) & Blessica (Female)\n` +
            `• 🇸🇦 <b>Arabic:</b> Hamed (Male) & Zariyah (Female)\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 <b>How to Use:</b>\n` +
            `1. <b>Send any message:</b> Auto-detects across all 10 languages.\n` +
            `2. <b>Specify language:</b> <code>/tts [lang] [text]</code>\n` +
            `   • Example: <code>/tts zh 你好</code> (Chinese)\n` +
            `   • Example: <code>/tts ja こんにちは</code> (Japanese)\n` +
            `   • Example: <code>/tts ko 안녕하세요</code> (Korean)\n` +
            `   • Example: <code>/tts ar مرحبا</code> (Arabic)\n` +
            `   • Example: <code>/tts en Good morning</code> (English)\n\n` +
            `👇 <i>Send any text below to hear it spoken!</i>`;

        return ctx.reply(studioHelp, { parse_mode: 'HTML' });
    }

    // Parse whether match starts with a language code (e.g. `/tts zh 你好` or `/tts ja こんにちは`)
    let targetLang: SupportedTTSLanguage | null = null;
    let textToSpeak = match;

    const parts = match.split(/\s+/);
    if (parts.length >= 2) {
        const potentialLang = normalizeLanguageCode(parts[0]);
        if (potentialLang) {
            targetLang = potentialLang;
            textToSpeak = parts.slice(1).join(' ').trim();
        }
    }

    if (!targetLang) {
        const pref = getUserVoicePreference(userId);
        if (pref !== 'auto' && pref in TTS_LANGUAGES) {
            targetLang = pref;
        } else {
            targetLang = detectLanguage(textToSpeak, isKm ? 'km' : 'en');
        }
    }

    if (userId && !config.ADMIN_IDS.includes(userId)) {
        const isEnabled = await isFeatureEnabled('tts');
        if (!isEnabled) {
            return ctx.reply(
                isKm
                    ? '⚠️ <b>មុខងារបំប្លែងសំឡេង TTS ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                    : '⚠️ <b>Neural TTS is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
                { parse_mode: 'HTML' }
            );
        }
    }

    try {
        await ctx.replyWithChatAction('record_voice');
        const prefGender = getUserVoiceGender(userId);
        const prefSpeed = getUserVoiceSpeed(userId);
        const audioPath = await generateNeuralTTS(textToSpeak, targetLang, prefGender, prefSpeed);

        if (audioPath && fs.existsSync(audioPath)) {
            const token = createTTSToken();
            await saveTTSTextCache(token, textToSpeak, targetLang, undefined, prefGender, prefSpeed);
            const voiceKeyboard = getTTSVoiceKeyboard(token, targetLang, isKm);
            const caption = getTTSCaption(targetLang, prefGender, isKm);

            const sent = await ctx.replyWithVoice(new InputFile(audioPath), {
                caption,
                parse_mode: 'HTML',
                reply_markup: voiceKeyboard,
                reply_parameters: { message_id: ctx.message!.message_id }
            });

            if (sent.voice?.file_id) {
                await updateTTSVoiceFileId(token, sent.voice.file_id);
            }

            try { fs.unlinkSync(audioPath); } catch (e) {}
        } else {
            await ctx.reply(isKm ? '❌ មិនអាចបង្កើតសំឡេងបានទេ។' : '❌ Could not generate audio.');
        }
    } catch (err: any) {
        logger.error('DIRECT_TTS', 'Direct TTS generation failed', err, { userId, textSample: textToSpeak.substring(0, 30) });
        await ctx.reply(`❌ TTS Error: ${err.message}`);
    }
});

// AI Chat command: /chat or /ask
audioHandler.command(['chat', 'ask', 'ai'], async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) setUserMode(userId, 'chat');
    const isKm = getUserLanguage(userId) === 'km';
    const t = getTranslation(userId);
    const query = (ctx.match?.trim() || '').slice(0, 4000);

    if (!query) {
        return ctx.reply(t.ai_chat_title, {
            parse_mode: 'HTML'
        });
    }

    if (userId && !config.ADMIN_IDS.includes(userId)) {
        const isEnabled = await isFeatureEnabled('chat');
        if (!isEnabled) {
            return ctx.reply(
                isKm
                    ? '⚠️ <b>មុខងារសន្ទនា AI ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                    : '⚠️ <b>AI Chat is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
                { parse_mode: 'HTML' }
            );
        }
    }

    try {
        const progress = await startProcessingAnimation(ctx, t.animation_ai, 1200, ctx.message?.message_id);
        try {
            const systemPrompt = isKm
                ? "You are a warm, polite, respectful, and intelligent AI assistant. When responding in Khmer, use natural, grammatically correct, polite, and friendly Khmer phrasing (ភាសាខ្មែរដែលគួរសម រួសរាយ និងត្រឹមត្រូវ). Format your response neatly with clear headings, bold key points, bullet lists, or code blocks where helpful. Keep answers concise, helpful, and well-structured."
                : "You are a warm, polite, and intelligent AI assistant. When responding in English, format your response neatly with clear headings, bold key points, bullet lists, or code blocks where helpful. Keep answers concise, helpful, and well-structured.";

            const aiResponse = await generateResponse(query, systemPrompt);
            await sendOrEditAiResponse(ctx, progress.messageId, aiResponse, getAiResponseKeyboard(isKm), ctx.message?.message_id);

            if (userId) {
                saveConversationToSupabase(userId, 'user', query).catch(() => {});
                saveConversationToSupabase(userId, 'assistant', aiResponse).catch(() => {});
            }
        } finally {
            progress.stop();
        }
    } catch (error: any) {
        logger.error('CHAT_CMD', 'AI Chat command failed', error, { userId });
        await ctx.reply(`🥺 Error: ${error.message}`);
    }
});

// Catch standard text messages: Dispatches to TTS mode or AI Chat mode based on user mode
audioHandler.on('message:text', async (ctx, next) => {
    // Ignore commands or URLs (handled by downloader)
    if (ctx.message.text.startsWith('/') || ctx.message.text.match(/(https?:\/\/)/)) {
        return next();
    }
    
    // Ignore all Reply Keyboard menu items (both Khmer and English)
    const menuItems = [
        '🗣️ សំឡេង AI', '🗣️ Voice Chat', '🗣️ សន្ទនាសំឡេង',
        '🤖 សន្ទនា AI', '🤖 AI Chat', '🤖 សន្ទនា',
        '🔊 បំប្លែងសំឡេង TTS', '🔊 Text to Speech', '🔊 បំប្លែងសំឡេង (TTS)', '🔊 TTS', '🔊 បំប្លែងសំឡេង',
        '📸 ស្កេន OCR', '📸 Vision OCR', '📸 ស្កេនរូបភាព',
        '📧 អ៊ីមែលបណ្តោះអាសន្ន', '📧 Temp Mail', '📧 អ៊ីមែល',
        '📥 ទាញយកវីដេអូ', '📥 Media Downloader', '📥 ទាញយក',
        '⚙️ ការកំណត់', '⚙️ Settings',
        '💡 ជំនួយ & ណែនាំ', '💡 Help & Guide', '💡 ជំនួយ',
        '☕ ឧបត្ថម្ភ (Donation)', '☕ Donation', 'ឧបត្ថម្ភ', 'Donation',
        '🔴 ◀️ ថយក្រោយ (Back)', '🔴 ◀️ Back', '🔴 ◀️ ថយក្រោយ', '🔴 < Back', '🔴 Back', '< Back', 'Back', 'ថយក្រោយ'
    ];
    if (menuItems.includes(ctx.message.text)) {
        return next();
    }

    const userId = ctx.from?.id;
    const currentMode = getUserMode(userId);

    // ==========================================
    // 1. DEDICATED TTS MODE: Text -> Pure Voice Note (Zero Gemini call)
    // ==========================================
    if (currentMode === 'tts') {
        const isKm = getUserLanguage(userId) === 'km';
        const t = getTranslation(userId);

        if (userId && !config.ADMIN_IDS.includes(userId)) {
            const isEnabled = await isFeatureEnabled('tts');
            if (!isEnabled) {
                return ctx.reply(
                    isKm
                        ? '⚠️ <b>មុខងារបំប្លែងសំឡេង TTS ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                        : '⚠️ <b>Neural TTS is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
                    { parse_mode: 'HTML' }
                );
            }
        }
        
        // Security: Rate limit TTS generation
        const ttsRate = await checkFeatureRateLimit(userId, 'tts', 8);
        if (!ttsRate.allowed) {
            return ctx.reply(
                isKm 
                    ? '⏳ <b>លោកអ្នកបានបំប្លែងសំឡេងញឹកពេក!</b>\n<i>សូមរង់ចាំបន្តិច មុននឹងបន្ត...</i>' 
                    : '⏳ <b>Too many TTS requests!</b>\n<i>Please wait a moment before trying again...</i>',
                { parse_mode: 'HTML' }
            );
        }

        try {
            await ctx.replyWithChatAction('record_voice');
            const progress = await startProcessingAnimation(ctx, t.animation_tts);
            try {
                const pref = getUserVoicePreference(userId);
                let lang: SupportedTTSLanguage = pref !== 'auto' && pref in TTS_LANGUAGES 
                    ? pref 
                    : detectLanguage(ctx.message.text, isKm ? 'km' : 'en');
                const prefGender = getUserVoiceGender(userId);
                const prefSpeed = getUserVoiceSpeed(userId);
                const audioPath = await generateNeuralTTS(ctx.message.text, lang, prefGender, prefSpeed);
                if (audioPath && fs.existsSync(audioPath)) {
                    const token = createTTSToken();
                    await saveTTSTextCache(token, ctx.message.text, lang, undefined, prefGender, prefSpeed);
                    const voiceKeyboard = getTTSVoiceKeyboard(token, lang, isKm);
                    const caption = getTTSCaption(lang, prefGender, isKm);

                    const sent = await ctx.replyWithVoice(new InputFile(audioPath), {
                        caption,
                        parse_mode: 'HTML',
                        reply_markup: voiceKeyboard,
                        reply_parameters: { message_id: ctx.message.message_id }
                    });

                    if (sent.voice?.file_id) {
                        await updateTTSVoiceFileId(token, sent.voice.file_id);
                    }

                    try { fs.unlinkSync(audioPath); } catch (e) {}
                } else {
                    await ctx.reply(isKm ? '❌ មិនអាចបង្កើតសំឡេងបានទេ។' : '❌ Could not generate audio.');
                }
            } finally {
                progress.stop();
                await ctx.api.deleteMessage(ctx.chat.id, progress.messageId).catch(() => {});
            }
        } catch (err: any) {
            logger.error('TTS_MODE', 'TTS generation failed in TTS mode', err, { userId });
            await ctx.reply(`❌ TTS Error: ${err.message}`);
        }
        return;
    }

    // ==========================================
    // 2. DEDICATED AI CHAT MODE: Question -> Gemini Answer
    // ==========================================
    try {
        const isKm = getUserLanguage(userId) === 'km';
        const t = getTranslation(userId);

        if (userId && !config.ADMIN_IDS.includes(userId)) {
            const isEnabled = await isFeatureEnabled('chat');
            if (!isEnabled) {
                return ctx.reply(
                    isKm
                        ? '⚠️ <b>មុខងារសន្ទនា AI ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                        : '⚠️ <b>AI Chat is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
                    { parse_mode: 'HTML' }
                );
            }
        }

        // Start dynamic "AI Thinking" animation with typing indicator replying to user's question
        const progress = await startProcessingAnimation(ctx, t.animation_ai, 1200, ctx.message.message_id);

        try {
            const systemPrompt = isKm
                ? "You are a warm, polite, respectful, and intelligent AI assistant. When responding in Khmer, use natural, grammatically correct, polite, and friendly Khmer phrasing (ភាសាខ្មែរដែលគួរសម រួសរាយ និងត្រឹមត្រូវ). Format your response neatly with clear headings, bold key points, bullet lists, or code blocks where helpful. Keep answers concise, helpful, and well-structured."
                : "You are a warm, polite, and intelligent AI assistant. When responding in English, format your response neatly with clear headings, bold key points, bullet lists, or code blocks where helpful. Keep answers concise, helpful, and well-structured.";

            const aiResponse = await generateResponse(ctx.message.text, systemPrompt);
            await sendOrEditAiResponse(ctx, progress.messageId, aiResponse, getAiResponseKeyboard(isKm), ctx.message.message_id);

            if (userId) {
                saveConversationToSupabase(userId, 'user', ctx.message.text).catch(() => {});
                saveConversationToSupabase(userId, 'assistant', aiResponse).catch(() => {});
            }
        } finally {
            progress.stop();
        }
    } catch (error: any) {
        logger.error('CHAT_TEXT', 'Text response handler failed', error, { userId, textSample: ctx.message.text.substring(0, 30) });
        const isKm = getUserLanguage(userId) === 'km';
        await ctx.reply(isKm ? `🥺 សូមអភ័យទោស មានបញ្ហាក្នុងការឆ្លើយតប៖ ${error.message}` : `🥺 Sorry, I had trouble processing that: ${error.message}`);
    }
});

// Helper to extract clean text from callback query target
function extractTextFromQuery(ctx: any): string {
    let raw = '';
    if (ctx.callbackQuery.message?.text) {
        raw = ctx.callbackQuery.message.text;
    } else if (ctx.callbackQuery.message?.caption) {
        raw = ctx.callbackQuery.message.caption;
    } else if (ctx.callbackQuery.message?.reply_to_message?.text) {
        raw = ctx.callbackQuery.message.reply_to_message.text;
    }

    if (!raw) return '';

    // If it's a voice response message containing transcription & response, extract ONLY the AI response
    if (raw.includes('🤖') || raw.includes('ចម្លើយពី AI') || raw.includes('AI Response')) {
        const parts = raw.split(/(?:🤖|💬)\s*(?:ចម្លើយពី AI|AI Response|ការឆ្លើយតប)[^\n]*\n?/i);
        if (parts.length > 1 && parts[1].trim()) {
            raw = parts[1].trim();
        }
    }

    // Strip out progress animations like [ ▰▰▰▰▰ 100% ]
    raw = raw.replace(/\[\s*[▰▱]+\s*\d+%\s*\]/g, '');
    
    // Strip HTML tags if any
    raw = raw.replace(/<[^>]*>/g, '').trim();

    // Decode HTML entities so speech synthesis pronounces natural text
    raw = decodeHtmlEntities(raw);

    return raw;
}

// Unified TTS Callback: Directly generates audio with detected or requested language (10 languages)
audioHandler.callbackQuery(
    /^do_tts_(auto|[a-z]+)$|^voice_reply_(auto|[a-z]+)$/,
    async (ctx) => {
        const rawAction = ctx.callbackQuery.data;
        const requestedCode = rawAction.replace(/^(do_tts_|voice_reply_)/, '');
        const userId = ctx.from?.id;
        const userLang = getUserLanguage(userId);
        const isKm = userLang === 'km';

        const text = extractTextFromQuery(ctx);
        if (!text) {
            return ctx.reply(isKm ? '❌ រកមិនឃើញអត្ថបទដើម្បីអានទេ។' : '❌ No text found to read.');
        }

        let targetLang: SupportedTTSLanguage;
        if (requestedCode !== 'auto' && normalizeLanguageCode(requestedCode)) {
            targetLang = normalizeLanguageCode(requestedCode)!;
        } else {
            const voicePref = getUserVoicePreference(userId);
            if (voicePref !== 'auto' && voicePref in TTS_LANGUAGES) {
                targetLang = voicePref;
            } else {
                targetLang = detectLanguage(text, isKm ? 'km' : 'en');
            }
        }

        const cfg = TTS_LANGUAGES[targetLang] || TTS_LANGUAGES['km'];
        await ctx.answerCallbackQuery({
            text: `${cfg.flag} កំពុងបង្កើតសំឡេង ${cfg.nativeName}...`
        });

        try {
            await ctx.replyWithChatAction('record_voice');
            const progress = await startProcessingAnimation(ctx, isKm
                ? [`${cfg.flag} <b>កំពុងបង្កើតសំឡេង ${cfg.nameKm}...</b>`, '🎙️ <b>កំពុងបង្កើតសំឡេងធម្មជាតិ...</b> ▰▰▱', '🔊 <b>ជិតរួចរាល់ហើយ...</b> ▰▰▰']
                : [`${cfg.flag} <b>Generating ${cfg.nameEn} voice...</b>`, '🎙️ <b>Creating natural speech...</b> ▰▰▱', '🔊 <b>Almost ready...</b> ▰▰▰']);

            const prefGender = getUserVoiceGender(userId);
            const prefSpeed = getUserVoiceSpeed(userId);
            const audioPath = await generateNeuralTTS(text, targetLang, prefGender, prefSpeed);
            progress.stop();
            await ctx.api.deleteMessage(ctx.chat!.id, progress.messageId).catch(() => {});

            if (audioPath && fs.existsSync(audioPath)) {
                const token = createTTSToken();
                await saveTTSTextCache(token, text, targetLang, undefined, prefGender, prefSpeed);
                const voiceKeyboard = getTTSVoiceKeyboard(token, targetLang, isKm);
                const caption = getTTSCaption(targetLang, prefGender, isKm);

                const sent = await ctx.replyWithVoice(new InputFile(audioPath), {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: voiceKeyboard,
                    reply_parameters: { message_id: ctx.callbackQuery.message!.message_id }
                });

                if (sent.voice?.file_id) {
                    await updateTTSVoiceFileId(token, sent.voice.file_id);
                }

                try {
                    fs.unlinkSync(audioPath);
                } catch (e) {}
            } else {
                await ctx.reply(
                    isKm
                        ? '❌ មិនអាចបង្កើតសំឡេងបានទេ។ សូមសាកល្បងម្តងទៀត។'
                        : '❌ Could not generate audio. Please try again.'
                );
            }
        } catch (error: any) {
            logger.error('TTS_CALLBACK', `Direct TTS generation failed for ${targetLang}`, error, { userId });
            await ctx.reply(`❌ Audio error: ${error.message}`);
        }
    }
);

// ==========================================
// Male / Female Voice Switch Callback Query
// ==========================================
audioHandler.callbackQuery(/^tts_v:(male|female):([a-z0-9]+)$/, async (ctx) => {
    const match = ctx.match;
    const targetGender = match[1] as VoiceGender;
    const token = match[2];
    const userId = ctx.from?.id;
    const userLang = getUserLanguage(userId);
    const isKm = userLang === 'km';

    if (userId) {
        setUserVoiceGender(userId, targetGender);
    }

    // 1. Retrieve text and language from cache
    const cacheItem = await getTTSTextCache(token);
    let text = cacheItem?.text;
    let lang: SupportedTTSLanguage = cacheItem?.lang || (isKm ? 'km' : 'en');
    const speed = cacheItem?.speed || getUserVoiceSpeed(userId);

    // 2. Fallback to extracting from message or reply
    if (!text) {
        text = extractTextFromQuery(ctx);
        lang = detectLanguage(text, isKm ? 'km' : 'en');
    }

    if (!text) {
        return ctx.answerCallbackQuery({
            text: isKm ? '❌ មិនអាចរកអត្ថបទឃើញទេ។' : '❌ Text not found.',
            show_alert: true
        });
    }

    const cfg = TTS_LANGUAGES[lang] || TTS_LANGUAGES['km'];
    const toastMsg = targetGender === 'male'
        ? `${cfg.flag} កំពុងបង្កើត សំឡេង ប្រុស (${cfg.nativeName})... 👨`
        : `${cfg.flag} កំពុងបង្កើត សំឡេង ស្រី (${cfg.nativeName})... 👩`;

    await ctx.answerCallbackQuery({ text: toastMsg });

    try {
        await ctx.replyWithChatAction('record_voice');

        const audioPath = await generateNeuralTTS(text, lang, targetGender, speed);
        if (audioPath && fs.existsSync(audioPath)) {
            const newToken = createTTSToken();
            await saveTTSTextCache(newToken, text, lang, undefined, targetGender, speed);
            const voiceKeyboard = getTTSVoiceKeyboard(newToken, lang, isKm);
            const caption = getTTSCaption(lang, targetGender, isKm);

            const sent = await ctx.replyWithVoice(new InputFile(audioPath), {
                caption,
                parse_mode: 'HTML',
                reply_markup: voiceKeyboard,
                reply_parameters: { message_id: ctx.callbackQuery.message?.message_id || ctx.callbackQuery.message?.reply_to_message?.message_id }
            });

            if (sent.voice?.file_id) {
                await updateTTSVoiceFileId(newToken, sent.voice.file_id);
            }

            try { fs.unlinkSync(audioPath); } catch (e) {}
        } else {
            await ctx.reply(isKm ? '❌ មិនអាចបង្កើតសំឡេងបានទេ។' : '❌ Could not generate audio.');
        }
    } catch (err: any) {
        logger.error('TTS_GENDER_CALLBACK', 'Gender voice switch error', err, { targetGender, userId });
        await ctx.reply(`❌ TTS Error: ${err.message}`);
    }
});

// ==========================================
// Open Speed Selection Menu
// ==========================================
audioHandler.callbackQuery(/^tts_speed:([a-z0-9]+)$/, async (ctx) => {
    const token = ctx.match[1];
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    const cacheItem = await getTTSTextCache(token);
    const currentSpeed = cacheItem?.speed || getUserVoiceSpeed(userId);
    await ctx.answerCallbackQuery({ text: isKm ? '⚡ ជ្រើសរើសល្បឿនសម្លេង...' : '⚡ Choose voice speed...' });

    try {
        await ctx.editMessageReplyMarkup({
            reply_markup: getTTSSpeedPickerKeyboard(token, isKm, currentSpeed)
        });
    } catch (e) {}
});

// ==========================================
// Select Speed Callback Query: tts_s:<speed>:<token>
// ==========================================
audioHandler.callbackQuery(/^tts_s:(0\.75x|1\.0x|1\.25x|1\.5x):([a-z0-9]+)$/, async (ctx) => {
    const targetSpeed = ctx.match[1];
    const token = ctx.match[2];
    const userId = ctx.from?.id;
    const userLang = getUserLanguage(userId);
    const isKm = userLang === 'km';

    if (userId) {
        setUserVoiceSpeed(userId, targetSpeed);
    }

    const cacheItem = await getTTSTextCache(token);
    let text = cacheItem?.text;
    let lang: SupportedTTSLanguage = cacheItem?.lang || (isKm ? 'km' : 'en');
    let gender: VoiceGender = cacheItem?.gender || getUserVoiceGender(userId);

    if (!text) {
        text = extractTextFromQuery(ctx);
        lang = detectLanguage(text, isKm ? 'km' : 'en');
    }

    if (!text) {
        return ctx.answerCallbackQuery({
            text: isKm ? '❌ មិនអាចរកអត្ថបទឃើញទេ។' : '❌ Text not found.',
            show_alert: true
        });
    }

    await ctx.answerCallbackQuery({
        text: isKm ? `⚡ ល្បឿន ${targetSpeed}...` : `⚡ Speed ${targetSpeed}...`
    });

    try {
        await ctx.replyWithChatAction('record_voice');

        const audioPath = await generateNeuralTTS(text, lang, gender, targetSpeed);
        if (audioPath && fs.existsSync(audioPath)) {
            const newToken = createTTSToken();
            await saveTTSTextCache(newToken, text, lang, undefined, gender, targetSpeed);
            const voiceKeyboard = getTTSVoiceKeyboard(newToken, lang, isKm);
            const caption = getTTSCaption(lang, gender, isKm);

            const sent = await ctx.replyWithVoice(new InputFile(audioPath), {
                caption,
                parse_mode: 'HTML',
                reply_markup: voiceKeyboard,
                reply_parameters: { message_id: ctx.callbackQuery.message?.message_id || ctx.callbackQuery.message?.reply_to_message?.message_id }
            });

            if (sent.voice?.file_id) {
                await updateTTSVoiceFileId(newToken, sent.voice.file_id);
            }

            try { fs.unlinkSync(audioPath); } catch (e) {}
        } else {
            await ctx.reply(isKm ? '❌ មិនអាចបង្កើតសំឡេងបានទេ។' : '❌ Could not generate audio.');
        }
    } catch (err: any) {
        logger.error('TTS_SPEED_CALLBACK', 'Speed voice switch error', err, { targetSpeed, userId });
        await ctx.reply(`❌ TTS Error: ${err.message}`);
    }
});

// ==========================================
// Open 10 Languages Selection Menu
// ==========================================
audioHandler.callbackQuery(/^tts_langs:([a-z0-9]+)$/, async (ctx) => {
    const token = ctx.match[1];
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    await ctx.answerCallbackQuery({ text: isKm ? 'ជ្រើសរើសភាសា (10 Languages)... 🌐' : 'Choose Language (10 Languages)... 🌐' });

    try {
        await ctx.editMessageReplyMarkup({
            reply_markup: getTTSLanguagePickerKeyboard(token, isKm)
        });
    } catch (e) {}
});

// ==========================================
// Back from Language Selector Menu
// ==========================================
audioHandler.callbackQuery(/^tts_back:([a-z0-9]+)$/, async (ctx) => {
    const token = ctx.match[1];
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    const item = await getTTSTextCache(token);
    await ctx.answerCallbackQuery();

    try {
        await ctx.editMessageReplyMarkup({
            reply_markup: getTTSVoiceKeyboard(token, item?.lang || 'km', isKm)
        });
    } catch (e) {}
});

// ==========================================
// Select Language Callback Query: tts_l:<lang>:<token>
// ==========================================
audioHandler.callbackQuery(/^tts_l:([a-z]+):([a-z0-9]+)$/, async (ctx) => {
    const rawLang = ctx.match[1];
    const targetLang = normalizeLanguageCode(rawLang) || 'km';
    const token = ctx.match[2];
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';

    const cacheItem = await getTTSTextCache(token);
    let text = cacheItem?.text;
    const gender = cacheItem?.gender || getUserVoiceGender(userId);
    const speed = cacheItem?.speed || getUserVoiceSpeed(userId);

    if (!text) {
        text = extractTextFromQuery(ctx);
    }

    if (!text) {
        return ctx.answerCallbackQuery({
            text: isKm ? '❌ មិនអាចរកអត្ថបទឃើញទេ។' : '❌ Text not found.',
            show_alert: true
        });
    }

    const cfg = TTS_LANGUAGES[targetLang] || TTS_LANGUAGES['km'];
    await ctx.answerCallbackQuery({
        text: `${cfg.flag} កំពុងបង្កើតសំឡេង ${cfg.nativeName}...`
    });

    try {
        await ctx.replyWithChatAction('record_voice');
        const audioPath = await generateNeuralTTS(text, targetLang, gender, speed);
        if (audioPath && fs.existsSync(audioPath)) {
            const newToken = createTTSToken();
            await saveTTSTextCache(newToken, text, targetLang, undefined, gender, speed);
            const voiceKeyboard = getTTSVoiceKeyboard(newToken, targetLang, isKm);
            const caption = getTTSCaption(targetLang, gender, isKm);

            const sent = await ctx.replyWithVoice(new InputFile(audioPath), {
                caption,
                parse_mode: 'HTML',
                reply_markup: voiceKeyboard,
                reply_parameters: { message_id: ctx.callbackQuery.message?.message_id || ctx.callbackQuery.message?.reply_to_message?.message_id }
            });

            if (sent.voice?.file_id) {
                await updateTTSVoiceFileId(newToken, sent.voice.file_id);
            }

            try { fs.unlinkSync(audioPath); } catch (e) {}
        } else {
            await ctx.reply(isKm ? '❌ មិនអាចបង្កើតសំឡេងបានទេ។' : '❌ Could not generate audio.');
        }
    } catch (err: any) {
        logger.error('TTS_LANG_SWITCH', 'Language switch failed', err, { targetLang, userId });
        await ctx.reply(`❌ TTS Error: ${err.message}`);
    }
});

// Real Voice Note Handler
audioHandler.on(':voice', async (ctx) => {
    if (!ctx.message?.voice) return;
    const voice = ctx.message.voice;
    const t = getTranslation(ctx.from?.id);
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const replyOptions: any = { parse_mode: 'HTML' };
    if (ctx.message?.message_id) {
        replyOptions.reply_parameters = { message_id: ctx.message.message_id };
    }

    const title = isKm ? '🎧 <b>សារសំឡេង (Voice Note AI)</b>' : '🎧 <b>Voice Note AI Assistant</b>';
    const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';

    const processingMsg = await ctx.reply(
        `${title}\n${divider}\n⏳ <b>${isKm ? 'ស្ថានភាព' : 'Status'}៖</b> <code>[ ▰▱▱▱▱ 25% ]</code>\n<i>${isKm ? 'កំពុងទទួល និងស្តាប់សារសំឡេងរបស់អ្នក...' : 'Receiving and listening to your voice note...'}</i>`,
        replyOptions
    );
    
    try {
        await ctx.replyWithChatAction('record_voice');
    } catch (e) {}

    const transcribeTimer = setTimeout(async () => {
        await safeEditMessage(
            ctx,
            processingMsg.message_id,
            `${title}\n${divider}\n⚡ <b>${isKm ? 'ស្ថានភាព' : 'Status'}៖</b> <code>[ ▰▰▰▱▱ 70% ]</code>\n<i>${isKm ? 'Gemini AI កំពុងស្តាប់ សរសេរអត្ថបទ និងឆ្លើយតប...' : 'Gemini AI transcribing audio and generating reply...'}</i>`
        );
    }, 1100);
    
    let localVoicePath: string | null = null;
    try {
        const file = await ctx.api.getFile(voice.file_id);
        
        if (!file.file_path) {
            throw new Error('Telegram voice file path is unavailable.');
        }

        const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`;
        const downloadsDir = path.resolve(__dirname, '../../downloads');
        if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
        
        const cleanVoiceId = voice.file_id.replace(/[^a-zA-Z0-9_-]/g, '');
        localVoicePath = path.join(downloadsDir, `${cleanVoiceId}.ogg`);
        if (!path.resolve(localVoicePath).startsWith(path.resolve(downloadsDir))) {
            throw new Error('Invalid audio destination path');
        }
        await downloadFile(url, localVoicePath);

        const { transcription, reply } = await transcribeAudio(localVoicePath, 'audio/ogg');
        clearTimeout(transcribeTimer);

        const formattedReply = formatTelegramHtml(reply);

        const voiceResultCard = 
`${title}
${divider}
📝 <b>${isKm ? 'ការសរសេរតាមសំឡេង' : 'Voice Transcription'}៖</b>
<blockquote>"${escapeHtml(transcription)}"</blockquote>

🤖 <b>${isKm ? 'ចម្លើយពី AI' : 'AI Response'}៖</b>
${formattedReply}
${divider}
🎙️ <i>ដំណើរការដោយ Gemini 3.6 • @voicekhaibot</i>`;

        await safeEditMessage(
            ctx,
            processingMsg.message_id,
            voiceResultCard
        );

        if (ctx.from?.id) {
            saveConversationToSupabase(ctx.from.id, 'user', `[Voice Note]: ${transcription}`).catch(() => {});
            saveConversationToSupabase(ctx.from.id, 'assistant', reply).catch(() => {});
        }
    } catch (error: any) {
        clearTimeout(transcribeTimer);
        logger.error('VOICE_NOTE', 'Voice note processing error', error, { userId: ctx.from?.id });
        const errorCard = 
`${title}
${divider}
❌ <b>${isKm ? 'មិនអាចស្តាប់សារសំឡេងបានទេ' : 'Voice note processing failed'}៖</b>
<i>${escapeHtml(error?.message || 'Error')}</i>`;
        await safeEditMessage(
            ctx,
            processingMsg.message_id,
            errorCard
        );
    } finally {
        if (localVoicePath && fs.existsSync(localVoicePath)) {
            try { fs.unlinkSync(localVoicePath); } catch (e) {}
        }
    }
});
