import { Composer, Keyboard, InlineKeyboard, InputFile } from 'grammy';
import {
    getTranslation,
    getUserLanguage,
    setUserLanguage,
    getUserNotificationPreference,
    setUserNotificationPreference
} from '../utils/i18n';
import { getComponentStatusReport, startProcessingAnimation } from '../utils/animation';
import {
    setUserVoicePreference,
    getUserVoiceGender,
    setUserVoiceGender,
    VoiceGender,
    getTTSTextCache,
    saveTTSTextCache,
    createTTSToken,
    generateNeuralTTS,
    updateTTSVoiceFileId,
    SupportedTTSLanguage,
    TTS_LANGUAGES,
    normalizeLanguageCode
} from '../services/tts.service';
import { setUserMode, getTTSVoiceKeyboard, getTTSCaption, getAiResponseKeyboard } from './audio.handler';
import { generateResponse } from '../services/gemini.service';
import { sendOrEditAiResponse } from '../utils/telegram-format';
import { saveConversationToSupabase } from '../services/supabase.service';
import { logger } from '../utils/logger';
import {
    getCustomWelcomeConfig,
    formatWelcomeCaption,
    getDefaultWelcomeCaption
} from '../services/welcome.service';
import fs from 'fs';
import path from 'path';

export const startHandler = new Composer();

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Main Menu: Show feature buttons + Donation (Back button is hidden)
export const getMainMenuKeyboard = (userId?: number) => {
    const t = getTranslation(userId);
    return new Keyboard()
        .text(t.menu_ai_chat).text(t.menu_tts).row()
        .text(t.menu_vision).text(t.menu_mail).row()
        .text(t.menu_dl).text(t.menu_donation).row()
        .text(t.menu_settings).text(t.menu_help)
        .resized();
};

// Submenu: Show ONLY the red < Back button (Feature buttons are hidden)
export const getSubmenuBackKeyboard = (userId?: number) => {
    const t = getTranslation(userId);
    return new Keyboard()
        .text(t.btn_back)
        .danger()
        .resized();
};

startHandler.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    const match = ctx.match?.trim();

    // Check if user came from a shared voice note link: /start v_<token>
    if (match && match.startsWith('v_')) {
        const token = match.substring(2);
        const item = await getTTSTextCache(token);

        if (item) {
            const isKm = getUserLanguage(userId) === 'km' || item.lang === 'km';
            const newToken = createTTSToken();
            await saveTTSTextCache(newToken, item.text, item.lang, item.voiceFileId, item.gender);
            const voiceKeyboard = getTTSVoiceKeyboard(newToken, item.lang, isKm);
            const cfg = TTS_LANGUAGES[item.lang] || TTS_LANGUAGES['km'];

            const caption = `${cfg.flag} <b>${cfg.nameKm} / ${cfg.nativeName} (Shared Voice Note ✨)</b>\n<i>"${escapeHtml(item.text.substring(0, 120))}"</i>\n\n<i>💡 ចុចសញ្ញា ↪️ Forward ដើម្បីផ្ញើសំឡេងផ្ទាល់</i>`;

            if (item.voiceFileId) {
                try {
                    await ctx.replyWithVoice(item.voiceFileId, {
                        caption,
                        parse_mode: 'HTML',
                        reply_markup: voiceKeyboard
                    });
                    // Also send main menu below it so friend can use the bot
                    const t = getTranslation(userId);
                    const firstName = ctx.from?.first_name || (isKm ? 'មិត្តភក្តិ' : 'friend');
                    await ctx.reply(t.welcome(escapeHtml(firstName)), {
                        parse_mode: 'HTML',
                        reply_markup: getMainMenuKeyboard(userId)
                    });
                    return;
                } catch (e) {
                    logger.warn('START_VOICE_SHARE', 'Cached voice file_id expired, generating fresh...', e);
                }
            }

            // Synthesize fresh if file_id is missing or failed
            await ctx.replyWithChatAction('record_voice');
            const audioPath = await generateNeuralTTS(item.text, item.lang, item.gender || 'female');
            if (audioPath && fs.existsSync(audioPath)) {
                const sent = await ctx.replyWithVoice(new InputFile(audioPath), {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: voiceKeyboard
                });
                if (sent.voice?.file_id) {
                    await updateTTSVoiceFileId(newToken, sent.voice.file_id);
                }
                try { fs.unlinkSync(audioPath); } catch (e) {}

                const t = getTranslation(userId);
                const firstName = ctx.from?.first_name || (isKm ? 'មិត្តភក្តិ' : 'friend');
                await ctx.reply(t.welcome(escapeHtml(firstName)), {
                    parse_mode: 'HTML',
                    reply_markup: getMainMenuKeyboard(userId)
                });
                return;
            }
        }
    }

    // Check if custom welcome message (photo with caption) is enabled by admin
    const customWelcome = await getCustomWelcomeConfig();
    const isKm = getUserLanguage(userId) === 'km';
    const firstName = ctx.from?.first_name || (isKm ? 'មិត្តភក្តិ' : 'friend');

    if (customWelcome.enabled) {
        const rawCaption = customWelcome.caption || getDefaultWelcomeCaption();
        const formattedCaption = formatWelcomeCaption(rawCaption, {
            firstName: escapeHtml(firstName),
            username: ctx.from?.username ? escapeHtml(ctx.from.username) : undefined,
            id: ctx.from?.id || 0
        });

        if (customWelcome.photoFileId) {
            try {
                await ctx.replyWithPhoto(customWelcome.photoFileId, {
                    caption: formattedCaption,
                    parse_mode: 'HTML',
                    reply_markup: getMainMenuKeyboard(userId)
                });
                return;
            } catch (err) {
                logger.warn('START_CUSTOM_WELCOME', 'Failed to send custom welcome photo, falling back to text', err);
            }
        }

        try {
            await ctx.reply(formattedCaption, {
                parse_mode: 'HTML',
                reply_markup: getMainMenuKeyboard(userId)
            });
        } catch (textErr) {
            logger.warn('START_CUSTOM_WELCOME', 'HTML parse error in custom welcome, fallback to plain text', textErr);
            await ctx.reply(customWelcome.caption || 'Welcome!', {
                reply_markup: getMainMenuKeyboard(userId)
            });
        }
        return;
    }

    // Default system welcome start handler
    const t = getTranslation(userId);
    await ctx.reply(t.welcome(escapeHtml(firstName)), { 
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(userId) 
    });
});

// Universal < Back Handler: returns to main menu and restores the feature buttons
export const backButtonAliases = [
    '🔴 ◀️ ថយក្រោយ (Back)',
    '🔴 ◀️ Back',
    '🔴 ◀️ ថយក្រោយ',
    '🔴 < Back',
    '🔴 Back',
    '< Back',
    'Back',
    'ថយក្រោយ',
    '🔙 ថយក្រោយ',
    '🔙 Back',
    '🔴 🔙 ថយក្រោយ (Back)',
    '🔴 🔙 Back'
];

startHandler.hears(backButtonAliases, async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) setUserMode(userId, 'chat');
    const t = getTranslation(userId);
    
    // Clean up user's "Back" message
    try {
        if (ctx.message?.message_id) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
        }
    } catch (e) {}

    await ctx.reply(t.returned_main, {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(userId)
    });
});

startHandler.callbackQuery(['back_main', 'main_menu'], async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) setUserMode(userId, 'chat');
    const t = getTranslation(userId);
    await ctx.answerCallbackQuery();
    await ctx.reply(t.returned_main, {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(userId)
    });
});

// Universal callback query to delete any temporary / result message
startHandler.callbackQuery(['delete_this_msg', 'delete_msg', 'close_msg'], async (ctx) => {
    try {
        await ctx.answerCallbackQuery({ text: 'បានលុបសារ! 🗑️' });
    } catch (e) {}
    try {
        await ctx.deleteMessage();
    } catch (e) {}
});

// /clean and /clear commands to clean up the chat
startHandler.command(['clean', 'clear'], async (ctx) => {
    if (!ctx.message) return;
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const currentId = ctx.message.message_id;
    const chatId = ctx.chat.id;

    // Delete user's /clean command
    try {
        await ctx.api.deleteMessage(chatId, currentId);
    } catch (e) {}

    // Clean recent messages safely without triggering Telegram API flood limits
    const messageIds = Array.from({ length: 15 }, (_, i) => currentId - (i + 1)).filter(id => id > 0);
    try {
        if (messageIds.length > 0) {
            if (typeof (ctx.api as any).deleteMessages === 'function') {
                await (ctx.api as any).deleteMessages(chatId, messageIds).catch(() => {});
            } else {
                for (const id of messageIds) {
                    await ctx.api.deleteMessage(chatId, id).catch(() => {});
                    await new Promise(r => setTimeout(r, 40));
                }
            }
        }
    } catch {}

    const alertMsg = await ctx.reply(
        isKm ? '🧹 <b>ឆាតត្រូវបានសម្អាត និងរៀបចំឱ្យស្អាតរួចរាល់!</b>' : '🧹 <b>Chat cleaned up successfully!</b>',
        { parse_mode: 'HTML' }
    );

    setTimeout(() => {
        ctx.api.deleteMessage(chatId, alertMsg.message_id).catch(() => {});
    }, 3500);
});

// ==========================================
// DONATION COMPONENT
// ==========================================

const handleDonation = async (ctx: any) => {
    const userId = ctx.from?.id;
    const t = getTranslation(userId);

    const qrPath = path.resolve(__dirname, '../../assets/my_khqr.webp');
    const stickerPath = path.resolve(__dirname, '../../assets/thank.webm');

    // 1. Send the KHQR Image with "Thanks for Donation" caption & red < Back keyboard
    if (fs.existsSync(qrPath)) {
        try {
            await ctx.replyWithPhoto(new InputFile(qrPath), {
                caption: t.donation_msg,
                parse_mode: 'HTML',
                reply_markup: getSubmenuBackKeyboard(userId)
            });
        } catch (photoErr) {
            await ctx.replyWithDocument(new InputFile(qrPath), {
                caption: t.donation_msg,
                parse_mode: 'HTML',
                reply_markup: getSubmenuBackKeyboard(userId)
            });
        }
    } else {
        await ctx.reply(t.donation_msg, {
            parse_mode: 'HTML',
            reply_markup: getSubmenuBackKeyboard(userId)
        });
    }

    // 2. Send the Thank You Sticker (assets/thank.webm)
    if (fs.existsSync(stickerPath)) {
        try {
            await ctx.replyWithSticker(new InputFile(stickerPath));
        } catch (stickerErr) {
            logger.warn('DONATION', 'Failed to send as sticker, falling back to document', stickerErr);
            try {
                await ctx.replyWithDocument(new InputFile(stickerPath));
            } catch (docErr) {
                logger.error('DONATION', 'Failed to send thank you media file', docErr);
            }
        }
    }
};

startHandler.hears(['☕ ឧបត្ថម្ភ (Donation)', '☕ Donation', 'ឧបត្ថម្ភ', 'Donation'], handleDonation);
startHandler.command(['donate', 'donation'], handleDonation);

// Help & Guide Component: switch keyboard to ONLY the red < Back button
const sendHelpGuide = async (ctx: any) => {
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';

    const guideKeyboard = new InlineKeyboard()
        .text(isKm ? '🗣️ ណែនាំអំពីសំឡេង' : '🗣️ Voice Guide', 'guide_voice')
        .text(isKm ? '📸 ណែនាំស្កេន OCR' : '📸 Vision Guide', 'guide_vision').row()
        .text(isKm ? '📧 ណែនាំអ៊ីមែល' : '📧 Temp Mail Guide', 'guide_mail')
        .text(isKm ? '📥 ណែនាំទាញយក' : '📥 Downloader Guide', 'guide_dl').row()
        .text(isKm ? '⚡ ស្ថានភាពដំណើរការមុខងារ' : '⚡ Live Component Status', 'view_status');

    const helpText = isKm ?
        `💡 <b>មគ្គុទ្ទេសក៍ & របៀបប្រើប្រាស់មុខងារទាំងអស់</b>\n\n` +
        `១️⃣ <b>សន្ទនាសំឡេង & AI៖</b> សរសេរសំណួរណាមួយមក នោះ AI នឹងឆ្លើយ។ ចុច <b>🔊 ស្តាប់ជាភាសាខ្មែរ</b> ដើម្បីស្តាប់ការអានជាសំឡេងធម្មជាតិ។\n` +
        `២️⃣ <b>សារសំឡេង (Voice Note)៖</b> ផ្ញើសារសំឡេងជាភាសាខ្មែរ ឬអង់គ្លេស AI នឹងស្តាប់ សរសេរជាអក្សរ និងឆ្លើយតបវិញ។\n` +
        `៣️⃣ <b>ស្កេនអក្សរ OCR៖</b> ផ្ញើរូបភាពដើម្បីស្រង់អក្សរ និងបកប្រែជាភាសាខ្មែរ។\n` +
        `៤️⃣ <b>អ៊ីមែលបណ្តោះអាសន្ន៖</b> ទទួលលេខកូដ OTP ភ្លាមៗដោយស្វ័យប្រវត្ត (Realtime)។\n` +
        `៥️⃣ <b>ទាញយកវីដេអូ៖</b> ផ្ញើតំណភ្ជាប់ពី TikTok, YouTube, Instagram, Facebook ដើម្បីទទួលបានវីដេអូច្បាស់ល្អ។\n` +
        `៦️⃣ <b>ការឧបត្ថម្ភ (Donation)៖</b> ចុចប៊ូតុងឧបត្ថម្ភដើម្បីស្កេន KHQR និងគាំទ្រដល់ @sddaDCbOT។\n\n` +
        `👇 ចុចលើប៊ូតុងខាងក្រោមសម្រាប់ព័ត៌មានលម្អិតបន្ថែម៖`
        :
        `💡 <b>Bot Components & Usage Guide</b>\n\n` +
        `1️⃣ <b>Chat & Voice:</b> Send any question to chat with AI. Tap <b>🔊 Read</b> to hear it spoken in Khmer or English.\n` +
        `2️⃣ <b>Audio Messages:</b> Send a Telegram voice note and the bot will transcribe and answer you.\n` +
        `3️⃣ <b>Photo OCR:</b> Send photos/documents to read text and translate it to Khmer.\n` +
        `4️⃣ <b>Temp Mail:</b> Generates disposable email addresses with instant real-time push alerts.\n` +
        `5️⃣ <b>Downloader:</b> Simply send video links from TikTok, YouTube, Instagram, or Facebook.\n` +
        `6️⃣ <b>Donation:</b> Tap Donation button to scan KHQR and support @sddaDCbOT.\n\n` +
        `Tap a guide below for in-depth details:`;

    await ctx.reply(helpText, {
        parse_mode: 'HTML',
        reply_markup: getSubmenuBackKeyboard(userId)
    });
    await ctx.reply(isKm ? '👇 ជ្រើសរើសផ្នែកណែនាំខាងក្រោម៖' : '👇 Choose guide topic below:', {
        reply_markup: guideKeyboard
    });
};

startHandler.command('help', sendHelpGuide);
startHandler.hears(['💡 ជំនួយ & ណែនាំ', '💡 Help & Guide', '💡 ជំនួយ'], sendHelpGuide);

// Live Component Status Feature
const sendComponentStatus = async (ctx: any) => {
    const userId = ctx.from?.id;
    const { text, keyboard } = getComponentStatusReport(userId);
    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
};

startHandler.command('status', sendComponentStatus);
startHandler.hears(['⚡ ស្ថានភាពមុខងារ', '⚡ Component Status', '⚡ Status', 'status', 'Status'], sendComponentStatus);

startHandler.callbackQuery('view_status', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    const { text, keyboard } = getComponentStatusReport(userId);
    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

startHandler.callbackQuery('status_refresh', async (ctx) => {
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    await ctx.answerCallbackQuery({ text: isKm ? 'កំពុងធ្វើបច្ចុប្បន្នភាពស្ថានភាព... ⚡' : 'Updating live status... ⚡' });
    const { text, keyboard } = getComponentStatusReport(userId);
    try {
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (e) {}
});

// Guide Sub-callbacks
startHandler.callbackQuery('guide_voice', async (ctx) => {
    await ctx.answerCallbackQuery();
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const text = isKm ?
        `🗣️ <b>ការណែនាំអំពីការប្រើប្រាស់សំឡេង (Voice & TTS Studio)</b>\n\n` +
        `• <b>ការអានអត្ថបទ (Edge Neural TTS 96k)៖</b> គាំទ្រ ១០ ភាសាជាផ្លូវការ រួមមាន 🇰🇭 ខ្មែរ, 🇺🇸 អង់គ្លេស, 🇨🇳 ចិន, 🇰🇷 កូរ៉េ, 🇯🇵 ជប៉ុន, 🇮🇳 ហិណ្ឌី, 🇲🇾 ម៉ាឡេស៊ី, 🇮🇩 ឥណ្ឌូនេស៊ី, 🇵🇭 ហ្វីលីពីន, និង 🇸🇦 អារ៉ាប់។\n` +
        `• <b>សំឡេងមនុស្សពិតៗ (Studio HD)៖</b> មានជម្រើសសំឡេងប្រុស (Male) និងសំឡេងស្រី (Female) ធម្មជាតិកម្រិត Studio 96kbps សម្រាប់គ្រប់ភាសាទាំងអស់។\n` +
        `• <b>របៀបប្រើប្រាស់៖</b> ផ្ញើសារអក្សរធម្មតា ឬប្រើ <code>/tts [ភាសា] [អត្ថបទ]</code> (ឧទាហរណ៍ <code>/tts zh 你好</code>, <code>/tts ja こんにちは</code>, <code>/tts km សួស្តី</code>) ដើម្បីអានភ្លាមៗ!\n` +
        `• <b>សារសំឡេង (Voice Note)៖</b> ចុចសង្កត់លើរូប Icon មេក្រូហ្វូនក្នុង Telegram និយាយជាភាសាខ្មែរ ឬអង់គ្លេស រួចលែងដៃ។ Gemini AI នឹងស្តាប់ សរសេរអត្ថបទ និងឆ្លើយតបវិញភ្លាមៗ!`
        :
        `🗣️ <b>Voice & Speech Guide (TTS Studio)</b>\n\n` +
        `• <b>Text-to-Speech (Edge Neural 96k):</b> Fully supports 10 languages: 🇰🇭 Khmer, 🇺🇸 English, 🇨🇳 Chinese, 🇰🇷 Korean, 🇯🇵 Japanese, 🇮🇳 Hindi, 🇲🇾 Malay, 🇮🇩 Indonesian, 🇵🇭 Filipino, and 🇸🇦 Arabic.\n` +
        `• <b>Natural Studio Voices:</b> Features both Male and Female natural neural voices with studio HD 24kHz/96kbps quality across all 10 languages.\n` +
        `• <b>Usage:</b> Simply send any text message or use <code>/tts [lang] [text]</code> (e.g. <code>/tts zh 你好</code>, <code>/tts ja こんにちは</code>, <code>/tts km សួស្តី</code>) for instant speech!\n` +
        `• <b>Voice Notes:</b> Hold the mic button in Telegram, speak in English or Khmer, and release. Gemini AI will listen, transcribe, and reply back!`;

    await ctx.reply(text, { parse_mode: 'HTML' });
});

startHandler.callbackQuery('guide_vision', async (ctx) => {
    await ctx.answerCallbackQuery();
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const text = isKm ?
        `📸 <b>ការណែនាំអំពីការស្កេនរូបភាព (Vision OCR)</b>\n\n` +
        `• ថតរូបស្លាកសញ្ញា ឯកសារ បង្កាន់ដៃ ឬសៀវភៅ រួចផ្ញើមកកាន់ទីនេះ។\n` +
        `• ប្រព័ន្ធ Gemini 3.6 Flash នឹងស្រង់អក្សរចេញយ៉ាងត្រឹមត្រូវ។\n` +
        `• ចុចប៊ូតុង <code>🌐 បកប្រែជាភាសាខ្មែរ</code> ដើម្បីបកប្រែជាភាសាខ្មែរដោយស្វ័យប្រវត្តិ។`
        :
        `📸 <b>Vision OCR Guide</b>\n\n` +
        `• Take a picture of signs, documents, receipts, or books and send it here.\n` +
        `• Gemini 3.6 Flash will extract all visible text.\n` +
        `• Tap <code>🌐 បកប្រែជាខ្មែរ</code> to translate it immediately into natural Khmer.`;

    await ctx.reply(text, { parse_mode: 'HTML' });
});

startHandler.callbackQuery('guide_mail', async (ctx) => {
    await ctx.answerCallbackQuery();
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const text = isKm ?
        `📧 <b>ការណែនាំអំពីអ៊ីមែលបណ្តោះអាសន្ន (Temp Mail)</b>\n\n` +
        `• ចុចលើ <code>📧 អ៊ីមែលបណ្តោះអាសន្ន</code> ឬវាយ <code>/tempmail</code> ដើម្បីបង្កើតអ៊ីមែលថ្មីមួយភ្លាមៗ។\n` +
        `• <b>Real-time Alerts៖</b> មិនបាច់ចុច Refresh ទេ! ពេលមានគេផ្ញើអ៊ីមែលមក ប្រព័ន្ធនឹងផ្ញើសារជូនដំណឹងភ្លាមៗក្នុងរយៈពេល ៤ វិនាទី។\n` +
        `• <b>ចាប់យកលេខកូដ OTP៖</b> លេខកូដបញ្ជាក់ (Verification Code) នឹងត្រូវស្រង់ចេញដោយស្វ័យប្រវត្ត ងាយស្រួលចុចចម្លងតែម្តង។`
        :
        `📧 <b>Temp Mail Guide</b>\n\n` +
        `• Tap <code>📧 Temp Mail</code> or type <code>/tempmail</code> to get an instant disposable email.\n` +
        `• <b>Real-time push notifications:</b> You don't need to refresh! Incoming emails buzz your Telegram within 4 seconds.\n` +
        `• <b>OTP detector:</b> Verification codes are extracted as 1-tap copyable blocks.`;

    await ctx.reply(text, { parse_mode: 'HTML' });
});

startHandler.callbackQuery('guide_dl', async (ctx) => {
    await ctx.answerCallbackQuery();
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const text = isKm ?
        `📥 <b>ការណែនាំអំពីការទាញយកវីដេអូ (Downloader)</b>\n\n` +
        `• ចម្លងតំណភ្ជាប់ (Link) ពី TikTok (រួមទាំងតំណខ្លី vt.tiktok.com), YouTube, Instagram Reels ឬ Facebook។\n` +
        `• បិទភ្ជាប់ (Paste) ក្នុងប្រអប់ឆាតនេះ។\n` +
        `• Bot នឹងទាញយកឯកសារវីដេអូច្បាស់ MP4 និងផ្ញើជូនអ្នកដោយផ្ទាល់។`
        :
        `📥 <b>Media Downloader Guide</b>\n\n` +
        `• Copy link from TikTok (including vt.tiktok.com), YouTube, Instagram Reels, or Facebook.\n` +
        `• Paste directly in chat.\n` +
        `• The bot will download the high-definition MP4 and send it directly!`;

    await ctx.reply(text, { parse_mode: 'HTML' });
});

// 1. AI Chat Component: switch keyboard to ONLY the red < Back button and set chat mode
startHandler.hears(['🤖 សន្ទនា AI', '🤖 AI Chat', '🗣️ សំឡេង AI', '🗣️ Voice Chat', 'សន្ទនា AI', 'AI Chat'], async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) setUserMode(userId, 'chat');
    const t = getTranslation(userId);
    const isKm = getUserLanguage(userId) === 'km';

    try {
        if (ctx.message?.message_id) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
        }
    } catch (e) {}

    await ctx.reply(t.ai_chat_title, {
        parse_mode: 'HTML',
        reply_markup: getSubmenuBackKeyboard(userId)
    });
});

// 2. Direct TTS Component: switch keyboard to ONLY the red < Back button and set TTS mode
startHandler.hears(['🔊 បំប្លែងសំឡេង TTS', '🔊 Text to Speech', '🔊 បំប្លែងសំឡេង (TTS)', '🔊 TTS', 'បំប្លែងសំឡេង'], async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) setUserMode(userId, 'tts');
    const t = getTranslation(userId);
    const isKm = getUserLanguage(userId) === 'km';
    const currentGender = getUserVoiceGender(userId);

    try {
        if (ctx.message?.message_id) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
        }
    } catch (e) {}

    await ctx.reply(t.tts_title, {
        parse_mode: 'HTML',
        reply_markup: getSubmenuBackKeyboard(userId)
    });
});

// Vision OCR Component: switch keyboard to ONLY the red < Back button
startHandler.hears(['📸 ស្កេន OCR', '📸 Vision OCR', '📸 ស្កេនរូបភាព'], async (ctx) => {
    const userId = ctx.from?.id;
    const t = getTranslation(userId);

    try {
        if (ctx.message?.message_id) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
        }
    } catch (e) {}

    await ctx.reply(t.vision_info, {
        parse_mode: 'HTML',
        reply_markup: getSubmenuBackKeyboard(userId)
    });
});

// Settings Component: switch keyboard to ONLY the red < Back button
startHandler.hears(['⚙️ ការកំណត់', '⚙️ Settings'], async (ctx) => {
    const userId = ctx.from?.id;
    const t = getTranslation(userId);
    const isKm = getUserLanguage(userId) === 'km';

    try {
        if (ctx.message?.message_id) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
        }
    } catch (e) {}

    const notifOn = getUserNotificationPreference(userId);
    const gender = getUserVoiceGender(userId);
    const settingsMenu = new InlineKeyboard()
        .text(t.settings_btn_voice, 'set_voice')
        .text(t.settings_btn_gender(gender), 'set_gender').row()
        .text(t.settings_btn_lang, 'set_lang')
        .text(t.settings_btn_notif(notifOn), 'set_notif').row()
        .text(t.settings_btn_status, 'view_status');
        
    await ctx.reply(t.settings_title, {
        parse_mode: 'HTML',
        reply_markup: getSubmenuBackKeyboard(userId)
    });
    await ctx.reply(isKm ? '👇 ជ្រើសរើសការកំណត់ខាងក្រោម៖' : '👇 Choose settings below:', {
        reply_markup: settingsMenu
    });
});

// Voice Chat Callbacks
startHandler.callbackQuery('tts_khmer', async (ctx) => {
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    await ctx.answerCallbackQuery({ text: isKm ? 'សំឡេងខ្មែរដំណើរការ!' : 'Khmer voice active!' });
    await ctx.reply(
        isKm ?
        '🇰🇭 <b>សំឡេងភាសាខ្មែរ (Studio) ត្រៀមរួចជាស្រេច!</b>\n\nសូមសរសេរសារជាអក្សរក្នុងឆាត ហើយចុច <b>🔊 ស្តាប់ជាភាសាខ្មែរ</b> ឬផ្ញើសារសំឡេង (Voice Note) មកបានគ្រប់ពេលវេលា!'
        :
        '🇰🇭 <b>Khmer Voice is ready!</b>\n\nType any message in chat and tap <b>🔊 Read in Khmer</b>, or record a voice note anytime!',
        { parse_mode: 'HTML' }
    );
});

startHandler.callbackQuery('tts_en', async (ctx) => {
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    await ctx.answerCallbackQuery({ text: isKm ? 'សំឡេងអង់គ្លេសដំណើរការ!' : 'English voice active!' });
    await ctx.reply(
        isKm ?
        '🇺🇸 <b>សំឡេងភាសាអង់គ្លេស (Neural) ត្រៀមរួចជាស្រេច!</b>\n\nសូមសរសេរសារជាអក្សរក្នុងឆាត ហើយចុច <b>🔊 Read in English</b> ដើម្បីស្តាប់ការអានជាសំឡេង!'
        :
        '🇺🇸 <b>English Voice is ready!</b>\n\nType any message in chat and tap <b>🔊 Read in English</b> to hear it spoken!',
        { parse_mode: 'HTML' }
    );
});

startHandler.callbackQuery('voice_record', async (ctx) => {
    await ctx.answerCallbackQuery();
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    await ctx.reply(
        isKm ?
        '🎙️ <b>របៀបសន្ទនាជាសំឡេងជាមួយខ្ញុំ៖</b>\n\n១. ចុចសង្កត់លើរូប <b>មេក្រូហ្វូន</b> នៅលើក្តារចុច Telegram របស់អ្នក។\n២. និយាយជាភាសាខ្មែរ ឬអង់គ្លេស។\n៣. លែងដៃដើម្បីផ្ញើ។\n\nAI នឹងស្តាប់ សរសេរជាអក្សរ និងឆ្លើយតបមកអ្នកវិញភ្លាមៗ! 🎧'
        :
        '🎙️ <b>How to talk to me with Voice:</b>\n\n1. Press and hold the <b>microphone icon</b> on your Telegram keyboard.\n2. Speak in Khmer or English.\n3. Release to send.\n\nMy AI will transcribe your voice note and talk back to you! 🎧',
        { parse_mode: 'HTML' }
    );
});

// Settings Callbacks: 10 Supported Languages Default Voice Selection
startHandler.callbackQuery('set_voice', async (ctx) => {
    await ctx.answerCallbackQuery();
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const menu = new InlineKeyboard()
        .text('⚡ ស្វ័យប្រវត្តិតាមភាសា (Auto Detect)', 'voice_set:auto').row()
        .text('🇰🇭 ភាសាខ្មែរ', 'voice_set:km').text('🇺🇸 English', 'voice_set:en').row()
        .text('🇨🇳 中文 (Chinese)', 'voice_set:zh').text('🇰🇷 한국어 (Korean)', 'voice_set:ko').row()
        .text('🇯🇵 日本語 (Japanese)', 'voice_set:ja').text('🇮🇳 हिन्दी (Hindi)', 'voice_set:hi').row()
        .text('🇲🇾 Melayu', 'voice_set:ms').text('🇮🇩 Indonesia', 'voice_set:id').row()
        .text('🇵🇭 Filipino', 'voice_set:fil').text('🇸🇦 العربية', 'voice_set:ar');

    await ctx.reply(
        isKm 
            ? '🗣️ <b>ជ្រើសរើសសំឡេងលំនាំដើម (គាំទ្រ ១០ ភាសា)៖</b>\n<i>ប្រព័ន្ធនឹងប្រើប្រាស់ភាសានេះសម្រាប់ការបំប្លែងសំឡេងជាស្វ័យប្រវត្តិ។</i>' 
            : '🗣️ <b>Select Default Voice (10 Languages Supported):</b>\n<i>The bot will use this voice as your primary TTS default.</i>',
        { parse_mode: 'HTML', reply_markup: menu }
    );
});

startHandler.callbackQuery(/^voice_set:([a-z]+)$/, async (ctx) => {
    const raw = ctx.match[1];
    const isKm = getUserLanguage(ctx.from?.id) === 'km';

    if (raw === 'auto') {
        if (ctx.from) setUserVoicePreference(ctx.from.id, 'auto');
        await ctx.answerCallbackQuery({ text: isKm ? 'បានកំណត់ស្វ័យប្រវត្តិ (Auto)!' : 'Default voice set to Auto Detect! ⚡' });
        await ctx.editMessageText(
            isKm ? '✅ សំឡេងលំនាំដើមត្រូវបានប្តូរទៅ <b>ស្វ័យប្រវត្តិតាមភាសា (Auto Detect)</b>។ ប្រព័ន្ធនឹងអានតាមភាសាដែលបានរកឃើញដោយផ្ទាល់ (គាំទ្រ ១០ ភាសា)។' : '✅ Default voice updated to <b>Auto-Detect (10 Languages Direct Speech)</b>.',
            { parse_mode: 'HTML' }
        );
        return;
    }

    const code = normalizeLanguageCode(raw);
    if (code && ctx.from) {
        setUserVoicePreference(ctx.from.id, code);
        const cfg = TTS_LANGUAGES[code];
        await ctx.answerCallbackQuery({ text: `${cfg.flag} បានកំណត់សំឡេង ${cfg.nativeName}!` });
        await ctx.editMessageText(
            isKm 
                ? `✅ សំឡេងលំនាំដើមត្រូវបានប្តូរទៅ <b>${cfg.flag} ${cfg.nameKm} (${cfg.nativeName})</b>។` 
                : `✅ Default voice updated to <b>${cfg.flag} ${cfg.nameEn} (${cfg.nativeName})</b>.`,
            { parse_mode: 'HTML' }
        );
    }
});

startHandler.callbackQuery('set_lang', async (ctx) => {
    await ctx.answerCallbackQuery();
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const menu = new InlineKeyboard()
        .text('🇰🇭 ភាសាខ្មែរ (Khmer)', 'lang_kh')
        .text('🇺🇸 English', 'lang_en');
    await ctx.reply(isKm ? '🌐 <b>ជ្រើសរើសភាសាសម្រាប់ប្រើប្រាស់៖</b>' : '🌐 <b>Choose Preferred Language:</b>', { parse_mode: 'HTML', reply_markup: menu });
});

startHandler.callbackQuery('lang_kh', async (ctx) => {
    if (ctx.from) setUserLanguage(ctx.from.id, 'km');
    await ctx.answerCallbackQuery({ text: 'បានផ្លាស់ប្តូរទៅជាភាសាខ្មែរ! 🇰🇭' });
    await ctx.reply('✅ បានកំណត់ភាសាទៅជា <b>ភាសាខ្មែរ</b>។ ក្តារចុចត្រូវបានធ្វើបច្ចុប្បន្នភាព!', {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(ctx.from?.id)
    });
});

startHandler.callbackQuery('lang_en', async (ctx) => {
    if (ctx.from) setUserLanguage(ctx.from.id, 'en');
    await ctx.answerCallbackQuery({ text: 'Language switched to English! 🇺🇸' });
    await ctx.reply('✅ Preferred language updated to <b>English</b>. Keyboard refreshed!', {
        parse_mode: 'HTML',
        reply_markup: getMainMenuKeyboard(ctx.from?.id)
    });
});

// Settings: Toggle User-Specific Notifications
startHandler.callbackQuery('set_notif', async (ctx) => {
    if (!ctx.from) return;
    const current = getUserNotificationPreference(ctx.from.id);
    const newState = !current;
    setUserNotificationPreference(ctx.from.id, newState);
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    await ctx.answerCallbackQuery({
        text: isKm ? `ការជូនដំណឹងត្រូវបាន ${newState ? 'បើក (ON)' : 'បិទ (OFF)'}` : `Notifications turned ${newState ? 'ON' : 'OFF'}`
    });
    const t = getTranslation(ctx.from.id);
    const gender = getUserVoiceGender(ctx.from.id);
    const settingsMenu = new InlineKeyboard()
        .text(t.settings_btn_voice, 'set_voice')
        .text(t.settings_btn_gender(gender), 'set_gender').row()
        .text(t.settings_btn_lang, 'set_lang')
        .text(t.settings_btn_notif(newState), 'set_notif').row()
        .text(t.settings_btn_status, 'view_status');
    await ctx.editMessageReplyMarkup({ reply_markup: settingsMenu });
});

// Settings: Toggle Voice Gender (Male / Female)
startHandler.callbackQuery('set_gender', async (ctx) => {
    if (!ctx.from) return;
    const current = getUserVoiceGender(ctx.from.id);
    const newGender: VoiceGender = current === 'male' ? 'female' : 'male';
    setUserVoiceGender(ctx.from.id, newGender);
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    await ctx.answerCallbackQuery({
        text: isKm ? `បានប្តូរសំឡេងទៅ៖ ${newGender === 'male' ? 'ប្រុស (Male) 👨' : 'ស្រី (Female) 👩'}` : `Voice switched to: ${newGender === 'male' ? 'Male 👨' : 'Female 👩'}`
    });
    const t = getTranslation(ctx.from.id);
    const notifOn = getUserNotificationPreference(ctx.from.id);
    const settingsMenu = new InlineKeyboard()
        .text(t.settings_btn_voice, 'set_voice')
        .text(t.settings_btn_gender(newGender), 'set_gender').row()
        .text(t.settings_btn_lang, 'set_lang')
        .text(t.settings_btn_notif(notifOn), 'set_notif').row()
        .text(t.settings_btn_status, 'view_status');
    await ctx.editMessageReplyMarkup({ reply_markup: settingsMenu });
});

// TTS Studio: Quick Voice Gender Toggle
startHandler.callbackQuery('tts_toggle_gender', async (ctx) => {
    if (!ctx.from) return;
    const current = getUserVoiceGender(ctx.from.id);
    const newGender: VoiceGender = current === 'male' ? 'female' : 'male';
    setUserVoiceGender(ctx.from.id, newGender);
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    const t = getTranslation(ctx.from.id);
    await ctx.answerCallbackQuery({
        text: isKm ? `បានប្តូរសំឡេងទៅ៖ ${newGender === 'male' ? 'ប្រុស (Male) 👨' : 'ស្រី (Female) 👩'}` : `Switched to: ${newGender === 'male' ? 'Male 👨' : 'Female 👩'}`
    });
    const ttsMenu = new InlineKeyboard()
        .text(isKm ? '🗣️ ជ្រើសរើសសំឡេង (10 ភាសា)' : '🗣️ Choose Voice (10 Languages)', 'set_voice')
        .text(t.settings_btn_gender(newGender), 'tts_toggle_gender')
        .row()
        .text('🇰🇭 សាកល្បងសំឡេងខ្មែរ', 'tts_sample:km')
        .text('🇺🇸 Try English Voice', 'tts_sample:en');
    await ctx.editMessageReplyMarkup({ reply_markup: ttsMenu });
});

// TTS Studio: Instant Sample Audio Preview
startHandler.callbackQuery(/^tts_sample:(km|en)$/, async (ctx) => {
    const lang = ctx.match[1] as 'km' | 'en';
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    await ctx.answerCallbackQuery({ text: isKm ? 'កំពុងបង្កើតសំឡេងគំរូ Studio... 🎙️' : 'Generating Studio sample voice... 🎙️' });

    const sampleTexts = {
        km: 'សួស្តី! ខ្ញុំគឺជាសំឡេងបញ្ញាសិប្បនិម្មិត Edge Neural TTS។ ខ្ញុំអាចអានអត្ថបទជាភាសាខ្មែរ និង ៩ ភាសាទៀតបានយ៉ាងច្បាស់ និងធម្មជាតិបំផុត។',
        en: 'Hello! I am an ultra-realistic Edge Neural AI voice. Send any text, and I will read it aloud for you in studio quality!'
    };

    const textToSpeak = sampleTexts[lang];
    const gender = getUserVoiceGender(userId);
    try {
        await ctx.replyWithChatAction('record_voice');
        const audioPath = await generateNeuralTTS(textToSpeak, lang, gender);
        if (audioPath && fs.existsSync(audioPath)) {
            const token = createTTSToken();
            await saveTTSTextCache(token, textToSpeak, lang, undefined, gender);
            const voiceKeyboard = getTTSVoiceKeyboard(token, lang, isKm);
            const caption = getTTSCaption(lang, gender, isKm);

            const sent = await ctx.replyWithVoice(new InputFile(audioPath), {
                caption: `💡 <b>${isKm ? 'សំឡេងគំរូ (Studio Sample Preview)' : 'Studio Sample Voice Preview'}</b>\n${caption}`,
                parse_mode: 'HTML',
                reply_markup: voiceKeyboard
            });

            if (sent.voice?.file_id) {
                await updateTTSVoiceFileId(token, sent.voice.file_id);
            }
            try { fs.unlinkSync(audioPath); } catch (e) {}
        }
    } catch (err: any) {
        logger.error('TTS_SAMPLE', 'Failed to generate TTS sample', err, { userId, lang });
        await ctx.reply(`❌ TTS Error: ${err.message}`);
    }
});

// AI Chat: Clear Context / Chat History
startHandler.callbackQuery('chat_clear', async (ctx) => {
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    await ctx.answerCallbackQuery({
        text: isKm ? '🧹 បានសម្អាតប្រវត្តិសន្ទនាជោគជ័យ!' : '🧹 Chat history cleared!'
    });
    await ctx.reply(
        isKm
            ? '✨ <b>ប្រវត្តិសន្ទនាត្រូវបានសម្អាតរួចរាល់!</b>\n<i>លោកអ្នកអាចចាប់ផ្តើមសួរសំណួរ ឬប្រធានបទថ្មីបានដោយរលូន។</i>'
            : '✨ <b>Chat context refreshed!</b>\n<i>You can now ask fresh questions or start a new topic.</i>',
        { parse_mode: 'HTML' }
    );
});

// AI Chat: Display Sample Prompt Questions
startHandler.callbackQuery('chat_samples', async (ctx) => {
    await ctx.answerCallbackQuery();
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    const sampleKb = new InlineKeyboard()
        .text(isKm ? '💡 តើ AI ដំណើរការយ៉ាងដូចម្តេច?' : '💡 How does AI work?', 'ask_sample:ai').row()
        .text(isKm ? '📝 ជួយសរសេរ Caption សម្រាប់ Facebook' : '📝 Write a Facebook post caption', 'ask_sample:caption').row()
        .text(isKm ? '💻 តើគួរចាប់ផ្តើមរៀន Code ពីណា?' : '💻 Where to start learning coding?', 'ask_sample:code').row()
        .text(isKm ? '🧠 គំនិតរកស៊ីខ្នាតតូចទុនតិច' : '🧠 Small business ideas with low budget', 'ask_sample:business').row()
        .text(isKm ? '🗑️ បិទ' : '🗑️ Close', 'delete_this_msg');

    await ctx.reply(
        isKm 
            ? '💡 <b>ជ្រើសរើសសំណួរគំរូមួយខាងក្រោម ដើម្បីសាកល្បងភ្លាមៗ៖</b>' 
            : '💡 <b>Choose a sample prompt below to try instantly:</b>',
        { parse_mode: 'HTML', reply_markup: sampleKb }
    );
});

// AI Chat: Trigger Instant Sample Prompt Answer
startHandler.callbackQuery(/^ask_sample:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const sampleKey = ctx.match[1];
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    const t = getTranslation(userId);

    const prompts: Record<string, { km: string; en: string }> = {
        ai: {
            km: 'តើបច្ចេកវិទ្យា Artificial Intelligence (AI) ដំណើរការយ៉ាងដូចម្តេច? សូមពន្យល់ដោយសាមញ្ញ និងងាយយល់បំផុត។',
            en: 'How does Artificial Intelligence (AI) work? Please explain in simple, easy-to-understand terms.'
        },
        caption: {
            km: 'សូមជួយតែង Caption ហ្វេសប៊ុកបែបលើកទឹកចិត្ត (Motivation) ខ្លីៗ ពីរោះ និងទាក់ទាញចំនួន ៣ ជម្រើស។',
            en: 'Please write 3 short, engaging, and motivational Facebook captions with emojis and hashtags.'
        },
        code: {
            km: 'ខ្ញុំទើបតែចាប់ផ្តើមចង់រៀនសរសេរកូដ (Coding) តើខ្ញុំគួរចាប់ផ្តើមរៀនភាសាអ្វីមុនគេ ហើយរៀនតាមរបៀបណា?',
            en: 'I want to start learning programming. What language should I start with, and what is the best roadmap?'
        },
        business: {
            km: 'សូមផ្តល់គំនិតអាជីវកម្មខ្នាតតូច ៣ ដែលអាចចាប់ផ្តើមជាមួយដើមទុនតិច និងមានតម្រូវការទីផ្សារខ្ពស់។',
            en: 'Please suggest 3 small business ideas that can be started with low capital and have high market demand.'
        }
    };

    const promptObj = prompts[sampleKey] || prompts.ai;
    const query = isKm ? promptObj.km : promptObj.en;

    const progress = await startProcessingAnimation(ctx, t.animation_ai);
    try {
        const systemPrompt = isKm
            ? "You are a warm, polite, respectful, and intelligent AI assistant. When responding in Khmer, use natural, grammatically correct, polite, and friendly Khmer phrasing. Format your response neatly with clear headings, bold key points, bullet lists, or code blocks where helpful. Keep answers concise, helpful, and well-structured."
            : "You are a warm, polite, and intelligent AI assistant. When responding in English, format your response neatly with clear headings, bold key points, bullet lists, or code blocks where helpful. Keep answers concise, helpful, and well-structured.";

        const aiResponse = await generateResponse(query, systemPrompt);
        await sendOrEditAiResponse(ctx, progress.messageId, aiResponse, getAiResponseKeyboard(isKm));

        if (userId) {
            saveConversationToSupabase(userId, 'user', query).catch(() => {});
            saveConversationToSupabase(userId, 'assistant', aiResponse).catch(() => {});
        }
    } catch (err: any) {
        logger.error('SAMPLE_PROMPT', 'Failed to generate sample prompt response', err, { userId });
        await ctx.reply(`🥺 Error: ${err.message}`);
    } finally {
        progress.stop();
    }
});
