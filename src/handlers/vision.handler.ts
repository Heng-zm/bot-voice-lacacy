import { Composer, InlineKeyboard } from 'grammy';
import { extractTextFromImage, generateResponse } from '../services/gemini.service';
import { config } from '../config';
import { getTranslation, getUserLanguage } from '../utils/i18n';
import { logger } from '../utils/logger';
import { escapeHtml, formatTelegramHtml } from '../utils/telegram-format';
import { safeEditMessage } from '../utils/animation';
import fs from 'fs';
import path from 'path';
import https from 'https';

/**
 * UI Component: Renders the Vision OCR processing card with progress status.
 */
function renderVisionProcessingCard(stage: 'download' | 'analyzing', isKm: boolean): string {
    const title = isKm ? '📸 <b>ស្កេនរូបភាព (Gemini 3.6 Vision OCR)</b>' : '📸 <b>Gemini 3.6 Vision OCR</b>';
    const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';
    
    if (stage === 'download') {
        const status = isKm
            ? '⏳ <b>ស្ថានភាព៖</b> <code>[ ▰▱▱▱▱ 25% ]</code>\n<i>កំពុងទទួលយករូបភាពពី Telegram...</i>'
            : '⏳ <b>Status:</b> <code>[ ▰▱▱▱▱ 25% ]</code>\n<i>Receiving image from Telegram...</i>';
        return `${title}\n${divider}\n${status}`;
    }
    
    const status = isKm
        ? '⚡ <b>ស្ថានភាព៖</b> <code>[ ▰▰▰▱▱ 70% ]</code>\n<i>Gemini Vision OCR កំពុងស្កេន និងស្រង់អក្សរ...</i>'
        : '⚡ <b>Status:</b> <code>[ ▰▰▰▱▱ 70% ]</code>\n<i>Gemini Vision OCR scanning and extracting text...</i>';
    return `${title}\n${divider}\n${status}`;
}

/**
 * UI Component: Renders the final Vision OCR extracted result card.
 */
function renderVisionResultCard(extractedText: string, isKm: boolean): string {
    const title = isKm ? '📸 <b>ស្កេនរូបភាព (Gemini 3.6 Vision OCR)</b>' : '📸 <b>Gemini 3.6 Vision OCR</b>';
    const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';
    const label = isKm ? '📝 <b>អត្ថបទដែលស្រង់បាន៖</b>' : '📝 <b>Extracted Text:</b>';
    const footer = isKm 
        ? '⚡ <i>ស្រង់អក្សរបានជោគជ័យ • @voicekhaibot</i>' 
        : '⚡ <i>Extracted successfully • @voicekhaibot</i>';

    const safeExtracted = extractedText.length > 3500
        ? extractedText.substring(0, 3500) + (isKm ? '\n\n... (អត្ថបទវែង ត្រូវបានកាត់ខ្លីត្រឹម ៣៥០០ តួអក្សរ)' : '\n\n... (Text truncated at 3,500 characters)')
        : extractedText;

    const safeText = escapeHtml(safeExtracted.trim());
    const content = safeText.length > 0 
        ? `<blockquote>${safeText}</blockquote>` 
        : (isKm ? '<i>⚠️ មិនមានអក្សរនៅក្នុងរូបភាពនេះទេ</i>' : '<i>⚠️ No text detected in this image</i>');

    return `${title}\n${divider}\n${label}\n\n${content}\n${divider}\n${footer}`;
}

/**
 * UI Component: Renders the Vision OCR error card.
 */
function renderVisionErrorCard(errorMessage: string, isKm: boolean): string {
    const title = isKm ? '📸 <b>ស្កេនរូបភាព (Gemini 3.6 Vision OCR)</b>' : '📸 <b>Gemini 3.6 Vision OCR</b>';
    const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━';
    const errorLabel = isKm ? '❌ <b>ការស្កេនមិនជោគជ័យ៖</b>' : '❌ <b>Scan Failed:</b>';
    const hint = isKm 
        ? '💡 <i>សូមសាកល្បងផ្ញើរូបភាពច្បាស់ ឬឯកសារ (Document) ម្តងទៀត</i>' 
        : '💡 <i>Please try again with a clearer photo or send as Document</i>';

    return `${title}\n${divider}\n${errorLabel}\n<i>${escapeHtml(errorMessage)}</i>\n\n${hint}`;
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

    const isEnabled = await isFeatureEnabled('vision');
    if (!isEnabled) {
        return ctx.reply(
            isKm
                ? '⚠️ <b>មុខងារស្កេនរូបភាព OCR ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                : '⚠️ <b>Vision OCR module is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
            { parse_mode: 'HTML' }
        );
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

    const replyOptions: any = { parse_mode: 'HTML' };
    if (ctx.message?.message_id) {
        replyOptions.reply_parameters = { message_id: ctx.message.message_id };
    }

    const processingMsg = await ctx.reply(
        renderVisionProcessingCard('download', isKm),
        replyOptions
    );
    
    try {
        await ctx.replyWithChatAction('typing');
    } catch (e) {}

    const ocrTimer = setTimeout(async () => {
        await safeEditMessage(
            ctx,
            processingMsg.message_id,
            renderVisionProcessingCard('analyzing', isKm)
        );
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
        
        const resultCard = renderVisionResultCard(extractedText, isKm);

        await safeEditMessage(
            ctx,
            processingMsg.message_id,
            resultCard
        );
    } catch (error: any) {
        clearTimeout(ocrTimer);
        logger.error('VISION', 'Vision photo processing error', error, { userId: ctx.from?.id, fileId });
        const errorCard = renderVisionErrorCard(error?.message || 'Error', isKm);
        await safeEditMessage(
            ctx,
            processingMsg.message_id,
            errorCard
        );
    } finally {
        if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
    }
}

visionHandler.command(['vision', 'ocr'], async (ctx) => {
    const userId = ctx.from?.id;
    const isKm = getUserLanguage(userId) === 'km';
    const isEnabled = await isFeatureEnabled('vision');
    if (!isEnabled) {
        return ctx.reply(
            isKm
                ? '⚠️ <b>មុខងារស្កេនរូបភាព OCR ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                : '⚠️ <b>Vision OCR module is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
            { parse_mode: 'HTML' }
        );
    }

    const t = getTranslation(userId);
    try {
        if (ctx.message?.message_id) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
        }
    } catch (e) {}

    await ctx.reply(t.vision_info, {
        parse_mode: 'HTML'
    });
});

visionHandler.on('message:photo', async (ctx) => {
    const isEnabled = await isFeatureEnabled('vision');
    if (!isEnabled) {
        const isKm = getUserLanguage(ctx.from?.id) === 'km';
        return ctx.reply(
            isKm
                ? '⚠️ <b>មុខងារស្កេនរូបភាព OCR ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                : '⚠️ <b>Vision OCR module is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
            { parse_mode: 'HTML' }
        );
    }
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Highest resolution
    await processImageFile(ctx, photo.file_id);
});

visionHandler.on('message:document', async (ctx, next) => {
    const mime = ctx.message.document.mime_type || '';
    const fileName = ctx.message.document.file_name || '';
    const isImage = mime.startsWith('image/') || /\.(jpe?g|png|webp|bmp)$/i.test(fileName);
    if (!isImage) return next();

    const isEnabled = await isFeatureEnabled('vision');
    if (!isEnabled) {
        const isKm = getUserLanguage(ctx.from?.id) === 'km';
        return ctx.reply(
            isKm
                ? '⚠️ <b>មុខងារស្កេនរូបភាព OCR ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                : '⚠️ <b>Vision OCR module is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
            { parse_mode: 'HTML' }
        );
    }

    if (ctx.message.document.file_size && ctx.message.document.file_size > 20 * 1024 * 1024) {
        const isKm = getUserLanguage(ctx.from?.id) === 'km';
        return ctx.reply(isKm ? '⚠️ រូបភាពឯកសារមានទំហំធំពេក (លើសពី 20MB) សម្រាប់ស្កេន OCR។' : '⚠️ Image document is too large (>20MB) for OCR scanning.');
    }

    await processImageFile(ctx, ctx.message.document.file_id);
});

visionHandler.callbackQuery('translate_khmer', async (ctx) => {
    const t = getTranslation(ctx.from?.id);
    const isKm = getUserLanguage(ctx.from?.id) === 'km';

    const isEnabled = await isFeatureEnabled('vision');
    if (!isEnabled) {
        return ctx.answerCallbackQuery({
            text: isKm ? '⚠️ មុខងារស្កេន OCR ត្រូវបានផ្អាកជាបណ្តោះអាសន្ន' : '⚠️ Vision OCR is temporarily paused',
            show_alert: true
        });
    }

    await ctx.answerCallbackQuery({ text: t.vision_translating });
    
    if (!ctx.callbackQuery.message) return;
    const msgId = ctx.callbackQuery.message.message_id;

    try {
        const originalMessage = ctx.callbackQuery.message.text || '';
        const extractedText = originalMessage
            .replace(/^📸[\s\S]*?━━━━━━━━━━━━━━━━━━━━━━━━━\n?/g, '')
            .replace(/📝\s*អត្ថបទដែលស្រង់បាន[៖:]?/gu, '')
            .replace(/📝\s*Extracted Text[៖:]?/gi, '')
            .replace(/^✨\s*\[\s*[▰▱\s\d%]+\]\s*/gu, '')
            .replace(/✨\s*អត្ថបទដែលស្រង់បាន[៖:]?/gu, '')
            .replace(/✨\s*Extracted Text[៖:]?/gi, '')
            .replace(/━━━━━━━━━━━━━━━━━━━━━━━━━[\s\S]*?$/g, '')
            .trim();
        
        if (!extractedText) {
            return safeEditMessage(ctx, msgId, isKm ? '❌ រកមិនឃើញអត្ថបទដើម្បីបកប្រែទេ។' : '❌ No text found to translate.');
        }

        const prompt = `Translate the following text into accurate, natural, and polite Khmer. Output only the Khmer translation:\n\n${extractedText}`;
        const translatedText = await generateResponse(prompt);
        
        let safeTranslation = translatedText;
        if (safeTranslation.length > 3500) {
            safeTranslation = safeTranslation.substring(0, 3500) + (isKm ? '\n\n... (អត្ថបទវែង ត្រូវបានកាត់ខ្លីត្រឹម ៣៥០០ តួអក្សរ)' : '\n\n... (Translation truncated at 3,500 characters)');
        }

        const translationCard = 
`🇰🇭 <b>អត្ថបទបកប្រែជាភាសាខ្មែរ (Khmer Translation)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━
<blockquote>${escapeHtml(safeTranslation.trim())}</blockquote>
━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ <i>បកប្រែដោយ Gemini 3.6 • @voicekhaibot</i>`;

        await safeEditMessage(ctx, msgId, translationCard);
    } catch (error: any) {
        logger.error('VISION_TRANSLATE', 'OCR text translation to Khmer failed', error, { userId: ctx.from?.id });
        await safeEditMessage(
            ctx,
            msgId,
            isKm ? `🥺 ការបកប្រែបរាជ័យ៖ ${escapeHtml(error?.message || 'Error')}` : `🥺 Translation failed: ${escapeHtml(error?.message || 'Error')}`
        );
    }
});
