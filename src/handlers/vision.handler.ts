import { Composer, InlineKeyboard } from 'grammy';
import { extractTextFromImage, generateResponse } from '../services/gemini.service';
import { config } from '../config';
import { getTranslation, getUserLanguage } from '../utils/i18n';
import { logger } from '../utils/logger';
import { escapeHtml, formatTelegramHtml } from '../utils/telegram-format';
import fs from 'fs';
import path from 'path';
import https from 'https';

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
                reject(new Error(`Image download failed with status ${response.statusCode ?? 'unknown'}`));
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

import { checkFeatureRateLimit } from '../middlewares/rateLimiter';
import { isFeatureEnabled } from '../services/features.service';

export const visionHandler = new Composer();

async function processImageFile(ctx: any, fileId: string) {
    const t = getTranslation(ctx.from?.id);
    const isKm = getUserLanguage(ctx.from?.id) === 'km';

    if (ctx.from?.id && !config.ADMIN_IDS.includes(ctx.from.id)) {
        const isEnabled = await isFeatureEnabled('vision');
        if (!isEnabled) {
            return ctx.reply(
                isKm
                    ? '⚠️ <b>មុខងារស្កេនរូបភាព OCR ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                    : '⚠️ <b>Vision OCR module is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
                { parse_mode: 'HTML' }
            );
        }
    }

    if (ctx.from?.id) {
        const rateCheck = await checkFeatureRateLimit(ctx.from.id, 'vision', 6);
        if (!rateCheck.allowed) {
            return ctx.reply(
                isKm 
                    ? '⏳ <b>លោកអ្នកបានស្កេនរូបភាពញឹកពេក!</b>\n<i>សូមរង់ចាំបន្តិច មុននឹងផ្ញើរូបភាពស្កេនបន្ត...</i>' 
                    : '⏳ <b>Too many OCR scans!</b>\n<i>Please wait a moment before sending another image...</i>',
                { parse_mode: 'HTML' }
            );
        }
    }

    const processingMsg = await ctx.reply(
        isKm 
            ? '🔍 <b>[ ▰▱▱▱▱ 25% ]</b> <i>កំពុងទទួលយករូបភាពពី Telegram...</i>' 
            : '🔍 <b>[ ▰▱▱▱▱ 25% ]</b> <i>Receiving image from Telegram...</i>',
        { parse_mode: 'HTML' }
    );
    
    try {
        await ctx.replyWithChatAction('typing');
    } catch (e) {}

    const ocrTimer = setTimeout(async () => {
        try {
            await ctx.api.editMessageText(
                ctx.chat.id,
                processingMsg.message_id,
                isKm 
                    ? '📸 <b>[ ▰▰▰▱▱ 70% ]</b> <i>Gemini Vision OCR កំពុងស្កេន និងស្រង់អក្សរ...</i>' 
                    : '📸 <b>[ ▰▰▰▱▱ 70% ]</b> <i>Gemini Vision OCR scanning and extracting text...</i>',
                { parse_mode: 'HTML' }
            );
        } catch (e) {}
    }, 1100);

    let filePath: string | null = null;
    try {
        const file = await ctx.api.getFile(fileId);
        if (!file.file_path) {
            throw new Error('Could not retrieve image file path from Telegram.');
        }

        const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`;
        
        const downloadsDir = path.resolve(__dirname, '../../downloads');
        if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
        
        // Security: Sanitize fileId and ext against path traversal
        const cleanFileId = fileId.replace(/[^a-zA-Z0-9_-]/g, '');
        const cleanExt = (path.extname(file.file_path) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
        filePath = path.join(downloadsDir, `${cleanFileId}${cleanExt}`);

        if (!path.resolve(filePath).startsWith(path.resolve(downloadsDir))) {
            throw new Error('Invalid file destination path');
        }

        await downloadFile(url, filePath);
        
        const extractedText = await extractTextFromImage(filePath);
        clearTimeout(ocrTimer);
        
        const safeExtracted = extractedText.length > 3500
            ? extractedText.substring(0, 3500) + (isKm ? '\n\n... (អត្ថបទវែង ត្រូវបានកាត់ខ្លីត្រឹម ៣៥០០ តួអក្សរ)' : '\n\n... (Text truncated at 3,500 characters)')
            : extractedText;

        const safeText = escapeHtml(safeExtracted);
        const actionKeyboard = new InlineKeyboard()
            .text(t.vision_translate_btn, 'translate_khmer')
            .text(isKm ? '🔊 ស្តាប់ជាសំឡេង (Read Aloud)' : '🔊 Read Aloud', 'do_tts_auto')
            .row()
            .text(isKm ? '🗑️ លុប (Delete)' : '🗑️ Delete', 'delete_this_msg');

        await ctx.api.editMessageText(
            ctx.chat.id, 
            processingMsg.message_id, 
            `✨ <b>[ ▰▰▰▰▰ 100% ]</b> ${t.vision_result}\n\n${safeText}`, 
            {
                parse_mode: 'HTML',
                reply_markup: actionKeyboard
            }
        );
    } catch (error: any) {
        clearTimeout(ocrTimer);
        logger.error('VISION', 'Vision photo processing error', error, { userId: ctx.from?.id, fileId });
        await ctx.api.editMessageText(
            ctx.chat.id, 
            processingMsg.message_id, 
            isKm ? `🥺 សូមអភ័យទោស មិនអាចដំណើរការរូបភាពនេះទេ៖ ${escapeHtml(error?.message || 'Error')}` : `🥺 Sorry, I couldn't process that image: ${escapeHtml(error?.message || 'Error')}`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
    } finally {
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
    }
}

visionHandler.on('message:photo', async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Highest resolution
    await processImageFile(ctx, photo.file_id);
});

visionHandler.on('message:document', async (ctx, next) => {
    const mime = ctx.message.document.mime_type || '';
    const fileName = ctx.message.document.file_name || '';
    const isImage = mime.startsWith('image/') || /\.(jpe?g|png|webp|bmp)$/i.test(fileName);
    if (!isImage) return next();

    if (ctx.message.document.file_size && ctx.message.document.file_size > 20 * 1024 * 1024) {
        const isKm = getUserLanguage(ctx.from?.id) === 'km';
        return ctx.reply(isKm ? '⚠️ រូបភាពឯកសារមានទំហំធំពេក (លើសពី 20MB) សម្រាប់ស្កេន OCR។' : '⚠️ Image document is too large (>20MB) for OCR scanning.');
    }

    await processImageFile(ctx, ctx.message.document.file_id);
});

visionHandler.callbackQuery('translate_khmer', async (ctx) => {
    const t = getTranslation(ctx.from?.id);
    const isKm = getUserLanguage(ctx.from?.id) === 'km';
    await ctx.answerCallbackQuery({ text: t.vision_translating });
    
    try {
        const originalMessage = ctx.callbackQuery.message?.text || '';
        const extractedText = originalMessage
            .replace(/^✨\s*\[\s*[▰▱\s\d%]+\]\s*/gu, '')
            .replace(/✨\s*អត្ថបទដែលស្រង់បាន[៖:]?/gu, '')
            .replace(/✨\s*Extracted Text[៖:]?/gi, '')
            .trim();
        
        if (!extractedText) {
            return ctx.editMessageText(isKm ? '❌ រកមិនឃើញអត្ថបទដើម្បីបកប្រែទេ។' : '❌ No text found to translate.');
        }

        const prompt = `Translate the following text into accurate, natural, and polite Khmer. Output only the Khmer translation:\n\n${extractedText}`;
        const translatedText = await generateResponse(prompt);
        
        let safeTranslation = translatedText;
        if (safeTranslation.length > 3500) {
            safeTranslation = safeTranslation.substring(0, 3500) + (isKm ? '\n\n... (អត្ថបទវែង ត្រូវបានកាត់ខ្លីត្រឹម ៣៥០០ តួអក្សរ)' : '\n\n... (Translation truncated at 3,500 characters)');
        }

        const formattedTranslation = formatTelegramHtml(safeTranslation);
        const translatedKeyboard = new InlineKeyboard()
            .text(isKm ? '🔊 ស្តាប់ជាសំឡេង (Read Aloud)' : '🔊 Read Aloud', 'do_tts_auto')
            .text(isKm ? '🗑️ លុប (Delete)' : '🗑️ Delete', 'delete_this_msg');

        await ctx.editMessageText(
            `${t.vision_translated_title}\n\n${formattedTranslation}`, 
            {
                parse_mode: 'HTML',
                reply_markup: translatedKeyboard
            }
        );
    } catch (error: any) {
        logger.error('VISION_TRANSLATE', 'OCR text translation to Khmer failed', error, { userId: ctx.from?.id });
        await ctx.editMessageText(
            isKm ? `🥺 ការបកប្រែបរាជ័យ៖ ${escapeHtml(error?.message || 'Error')}` : `🥺 Translation failed: ${escapeHtml(error?.message || 'Error')}`, 
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }
});
