import { Composer, InlineKeyboard, Bot, InputFile } from 'grammy';
import { 
    getOrCreateTempAccount, 
    createTempAccount, 
    fetchInboxMessages, 
    fetchMessageDetail, 
    deleteTempAccount, 
    deleteMessage,
    registerRealtimeMailListener,
    extractOtp,
    extractActionLinks
} from '../services/tempmail.service';
import { getTranslation, getUserLanguage, getUserNotificationPreference } from '../utils/i18n';
import { getSubmenuBackKeyboard } from './start.handler';
import { logger } from '../utils/logger';
import { escapeHtml, decodeHtmlEntities } from '../utils/telegram-format';
import { config } from '../config';
import { isFeatureEnabled } from '../services/features.service';
import fs from 'fs';
import path from 'path';

export const tempmailHandler = new Composer();

/**
 * Renders the primary Inbox UI view with real-time telemetry and message summaries.
 */
async function renderInboxView(userId: number) {
    const isKm = getUserLanguage(userId) === 'km';
    const account = await getOrCreateTempAccount(userId);
    const messages = await fetchInboxMessages(userId);

    let text = isKm
        ? `📧 <b>ប្រអប់អ៊ីមែលបណ្តោះអាសន្ន (Temp Mailbox)</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `📬 <b>អាសយដ្ឋានអ៊ីមែលរបស់អ្នក (Your Address)៖</b>\n` +
          `👉 <code>${escapeHtml(account.address)}</code> <i>(ចុចដើម្បីចម្លង)</i>\n\n` +
          `⚡ <b>ប្រព័ន្ធ Realtime៖</b> 🟢 <code>ACTIVE (4s Pulse ⚡)</code>\n` +
          `📊 <b>សារក្នុងប្រអប់៖</b> <code>${messages.length} សារ</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n`
        : `📧 <b>Temporary Disposable Mailbox</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `📬 <b>Your Current Email Address:</b>\n` +
          `👉 <code>${escapeHtml(account.address)}</code> <i>(tap to copy)</i>\n\n` +
          `⚡ <b>Realtime Watcher:</b> 🟢 <code>ACTIVE (4s Pulse ⚡)</code>\n` +
          `📊 <b>Inbox Count:</b> <code>${messages.length} message(s)</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    const keyboard = new InlineKeyboard();

    if (messages.length === 0) {
        text += isKm
            ? `📭 <i>មិនទាន់មានសារនៅឡើយទេ។ សូមចម្លងអ៊ីមែលខាងលើដើម្បីចុះឈ្មោះលើ App ឬ Website — ពេលមានអ៊ីមែលផ្ញើមក Bot នឹង Push ដំណឹងភ្លាមៗ!</i>`
            : `📭 <i>Inbox is currently empty. Use your address above for sign-ups or OTPs — you will receive an instant notification as soon as an email arrives!</i>`;

        keyboard
            .text(isKm ? '🔄 ពិនិត្យសារថ្មី' : '🔄 Refresh Inbox', 'mail_refresh')
            .text(isKm ? '🎲 បង្កើតអ៊ីមែលថ្មី' : '🎲 New Email', 'mail_new')
            .row()
            .text(isKm ? '🗑️ លុបប្រអប់សារ' : '🗑️ Delete Mailbox', 'mail_delete');
    } else {
        text += isKm ? `📩 <b>បញ្ជីសារដែលបានទទួល៖</b>\n` : `📩 <b>Incoming Messages:</b>\n`;

        messages.slice(0, 5).forEach((msg, idx) => {
            const sender = escapeHtml(msg.from?.name || msg.from?.address || 'Unknown');
            const subject = escapeHtml(msg.subject || (isKm ? '(គ្មានប្រធានបទ)' : '(No Subject)'));
            const dateStr = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            // Check if OTP is readily visible in subject or intro
            const quickOtp = extractOtp(msg.subject, msg.intro || '');

            text += `\n${idx + 1}️⃣ <b>${isKm ? 'ពី' : 'From'}:</b> ${sender}\n` +
                    `   📌 <b>${isKm ? 'ប្រធានបទ' : 'Subject'}:</b> ${subject}\n` +
                    (quickOtp ? `   🔑 <b>OTP:</b> <code>${quickOtp}</code> <i>(ចុចចម្លង)</i>\n` : '') +
                    `   🕒 <b>${isKm ? 'ម៉ោង' : 'Time'}:</b> ${dateStr}\n`;
        });

        if (messages.length > 5) {
            text += `\n<i>+ ${messages.length - 5} ${isKm ? 'សារចាស់ៗទៀត...' : 'older message(s)...'}</i>\n`;
        }

        // Add 1-tap buttons to read individual messages
        messages.slice(0, 5).forEach((msg, idx) => {
            const rawSub = msg.subject || (isKm ? `សារទី ${idx + 1}` : `Message #${idx + 1}`);
            const cleanSub = rawSub.length > 22 ? rawSub.substring(0, 22) + '...' : rawSub;
            keyboard.text(`📖 #${idx + 1}: ${cleanSub}`, `mail_read_${msg.id}`).row();
        });

        keyboard
            .text(isKm ? '🔄 ពិនិត្យសារថ្មី' : '🔄 Refresh Inbox', 'mail_refresh')
            .text(isKm ? '🎲 បង្កើតអ៊ីមែលថ្មី' : '🎲 New Email', 'mail_new')
            .row()
            .text(isKm ? '🗑️ លុបប្រអប់សារ' : '🗑️ Delete Mailbox', 'mail_delete');
    }

    return { text, keyboard };
}

// Handler for Temp Mail command & Reply Keyboard button
export const sendTempMailView = async (ctx: any) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const isKm = getUserLanguage(userId) === 'km';

    const isEnabled = await isFeatureEnabled('tempmail');
    if (!isEnabled) {
        return ctx.reply(
            isKm
                ? '⚠️ <b>មុខងារអ៊ីមែលបណ្តោះអាសន្នត្រូវបានផ្អាកជាបណ្តោះអាសន្ន</b>\n<i>Admin បានបិទមុខងារនេះបណ្តោះអាសន្នដើម្បីថែទាំ។ សូមអភ័យទោសចំពោះការរំខាន!</i>'
                : '⚠️ <b>TempMail module is temporarily paused</b>\n<i>Administrators have paused this module for maintenance. Please check back later!</i>',
            { parse_mode: 'HTML' }
        );
    }

    const { text, keyboard } = await renderInboxView(userId);

    await ctx.reply(
        isKm ? '📧 <b>បានបើកប្រអប់អ៊ីមែលបណ្តោះអាសន្ន (Temp Mail)៖</b>' : '📧 <b>Temp Mailbox Active:</b>',
        {
            parse_mode: 'HTML',
            reply_markup: getSubmenuBackKeyboard(userId)
        }
    );
    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
};

tempmailHandler.hears(['📧 អ៊ីមែលបណ្តោះអាសន្ន', '📧 Temp Mail', '📧 អ៊ីមែល'], sendTempMailView);
tempmailHandler.command('tempmail', sendTempMailView);

// Guard middleware: prevents accessing mailbox actions when tempmail module is disabled
tempmailHandler.use(async (ctx, next) => {
    if (ctx.callbackQuery?.data && ctx.callbackQuery.data.startsWith('mail_')) {
        const isEnabled = await isFeatureEnabled('tempmail');
        if (!isEnabled) {
            const isKm = getUserLanguage(ctx.from?.id) === 'km';
            return ctx.answerCallbackQuery({
                text: isKm ? '⚠️ មុខងារអ៊ីមែលបណ្តោះអាសន្នត្រូវបានផ្អាកជាបណ្តោះអាសន្ន' : '⚠️ TempMail module is temporarily paused',
                show_alert: true
            });
        }
    }
    return next();
});

// Refresh Inbox Callback
tempmailHandler.callbackQuery('mail_refresh', async (ctx) => {
    if (!ctx.from) return;
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    try {
        const { text, keyboard } = await renderInboxView(ctx.from.id);
        await ctx.answerCallbackQuery({ text: isKm ? 'បានពិនិត្យសារថ្មី! 📬' : 'Inbox refreshed! 📬' });
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (err: any) {
        if (err?.description?.includes('message is not modified') || err?.message?.includes('message is not modified')) {
            await ctx.answerCallbackQuery({ text: isKm ? 'ប្រអប់សារបានធ្វើបច្ចុប្បន្នភាពរួចរាល់ (គ្មានសារថ្មីទេ)! 📬' : 'Inbox is up to date (no new messages)! 📬' });
            return;
        }
        await ctx.answerCallbackQuery({ text: `${isKm ? 'បរាជ័យ' : 'Refresh failed'}: ${err.message}`, show_alert: true });
    }
});

// Back to Inbox Callback
tempmailHandler.callbackQuery('mail_inbox', async (ctx) => {
    if (!ctx.from) return;
    try {
        const { text, keyboard } = await renderInboxView(ctx.from.id);
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (err: any) {
        await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
    }
});

// Generate New Email Callback
tempmailHandler.callbackQuery('mail_new', async (ctx) => {
    if (!ctx.from) return;
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    await ctx.answerCallbackQuery({ text: isKm ? 'កំពុងបង្កើតអ៊ីមែលថ្មី... 🎲' : 'Generating fresh email... 🎲' });
    try {
        await deleteTempAccount(ctx.from.id);
        const { text, keyboard } = await renderInboxView(ctx.from.id);
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (err: any) {
        await ctx.reply(isKm ? `🥺 មិនអាចបង្កើតអ៊ីមែលថ្មី៖ ${err.message}` : `🥺 Could not generate new email: ${err.message}`);
    }
});

// Delete Entire Mailbox Callback
tempmailHandler.callbackQuery('mail_delete', async (ctx) => {
    if (!ctx.from) return;
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    await deleteTempAccount(ctx.from.id);
    await ctx.answerCallbackQuery({ text: isKm ? 'បានលុបអ៊ីមែលចោល! 🗑️' : 'Temp mail deleted! 🗑️' });

    const keyboard = new InlineKeyboard().text(isKm ? '🎲 បង្កើតអ៊ីមែលថ្មី' : '🎲 Generate New Email', 'mail_new');
    const deleteMsg = isKm ?
        '🗑️ <b>ប្រអប់អ៊ីមែលបណ្តោះអាសន្នរបស់អ្នកត្រូវបានលុបចេញដោយជោគជ័យ។</b>\n\nចុចលើប៊ូតុងខាងក្រោមនៅពេលដែលអ្នកត្រូវការអ៊ីមែលថ្មី!'
        :
        '🗑️ <b>Your temporary mailbox has been deleted.</b>\n\nTap below whenever you need a fresh disposable email address!';

    await ctx.editMessageText(deleteMsg, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Delete Single Email Message Callback
tempmailHandler.callbackQuery(/^mail_del_msg_(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    const messageId = ctx.match[1];

    try {
        await deleteMessage(ctx.from.id, messageId);
        await ctx.answerCallbackQuery({ text: isKm ? '🗑️ សារត្រូវបានលុបចេញ!' : '🗑️ Email deleted!' });

        const { text, keyboard } = await renderInboxView(ctx.from.id);
        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (err: any) {
        await ctx.answerCallbackQuery({ text: `Delete error: ${err.message}`, show_alert: true });
    }
});

// Read Message Callback
tempmailHandler.callbackQuery(/^mail_read_(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    const messageId = ctx.match[1];
    await ctx.answerCallbackQuery({ text: isKm ? 'កំពុងបើកអានសារ... 📩' : 'Opening email... 📩' });

    try {
        const detail = await fetchMessageDetail(ctx.from.id, messageId);
        
        const sender = escapeHtml(`${detail.from?.name ? `${detail.from.name} ` : ''}<${detail.from?.address || 'Unknown'}>`);
        const subject = escapeHtml(detail.subject || (isKm ? '(គ្មានប្រធានបទ)' : '(No Subject)'));
        const date = new Date(detail.createdAt).toLocaleString(isKm ? 'km-KH' : 'en-US');
        
        let body = detail.text?.trim() || detail.intro?.trim() || (isKm ? 'គ្មានអត្ថបទក្នុងសារនេះទេ។' : 'No text content in this email.');
        if (body.length > 2000) {
            body = body.substring(0, 2000) + (isKm 
                ? '\n\n✂️ [សារវែងពេក ត្រូវបានកាត់ខ្លីត្រឹម ២០០០ តួអក្សរ។ ចុចប៊ូតុង "🌐 ទម្រង់ HTML" ខាងក្រោមដើម្បីមើលសារពេញលេញ]' 
                : '\n\n✂️ [Message truncated at 2,000 characters. Tap "🌐 HTML Web Preview" below to view full email]');
        }

        const rawHtml = (detail.html && detail.html.length > 0) ? detail.html.join('') : '';
        const actionLinks = extractActionLinks(rawHtml || detail.text || '');
        const otp = extractOtp(detail.subject, detail.text || detail.intro || '');

        let messageText = isKm ?
            `📩 <b>ព័ត៌មានលម្អិតនៃសារអ៊ីមែល (Email Details)</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>ផ្ញើពី៖</b> ${sender}\n` +
            `📌 <b>ប្រធានបទ៖</b> ${subject}\n` +
            `🕒 <b>កាលបរិច្ឆេទ៖</b> ${date}\n`
            :
            `📩 <b>Email Message Details</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>From:</b> ${sender}\n` +
            `📌 <b>Subject:</b> ${subject}\n` +
            `🕒 <b>Received:</b> ${date}\n`;

        if (otp) {
            messageText += isKm 
                ? `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                  `🔑 <b>លេខកូដផ្ទៀងផ្ទាត់ (OTP)៖</b>\n` +
                  `👉 <code>${otp}</code> 👈 <i>(ចុចដើម្បីចម្លង)</i>\n` +
                  `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
                : `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                  `🔑 <b>Verification Code (OTP):</b>\n` +
                  `👉 <code>${otp}</code> 👈 <i>(tap to copy)</i>\n` +
                  `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        } else {
            messageText += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        }

        messageText += `📄 <b>${isKm ? 'ខ្លឹមសារសារ៖' : 'Message Body:'}</b>\n<code>${escapeHtml(body)}</code>`;

        const keyboard = new InlineKeyboard();

        // 1-Tap Action links (Verify Account, Confirm Email, etc.)
        for (const act of actionLinks) {
            keyboard.url(`🔗 ${act.label}`, act.url).row();
        }

        // Web HTML Preview and Delete buttons
        keyboard
            .text(isKm ? '🌐 ទម្រង់ HTML (Web Preview)' : '🌐 HTML Web Preview', `mail_html_${messageId}`)
            .text(isKm ? '🗑️ លុបសារនេះ' : '🗑️ Delete Email', `mail_del_msg_${messageId}`)
            .row()
            .text(isKm ? '🔙 ត្រឡប់ទៅប្រអប់សារ' : '🔙 Back to Inbox', 'mail_inbox')
            .text(isKm ? '🔄 ពិនិត្យសារ' : '🔄 Refresh', 'mail_refresh');

        await ctx.editMessageText(messageText, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } catch (err: any) {
        logger.error('TEMPMAIL', 'Failed to read email detail', err, { userId: ctx.from?.id });
        await ctx.reply(isKm ? `🥺 មិនអាចបើកសារអ៊ីមែល៖ ${err.message}` : `🥺 Could not open email: ${err.message}`);
    }
});

// HTML Web Preview Callback: Sends a responsive, beautifully styled HTML file to view in browser
tempmailHandler.callbackQuery(/^mail_html_(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const isKm = getUserLanguage(ctx.from.id) === 'km';
    const messageId = ctx.match[1];
    await ctx.answerCallbackQuery({ text: isKm ? 'កំពុងបង្កើតទម្រង់ HTML... 🌐' : 'Generating HTML Web Preview... 🌐' });

    try {
        const detail = await fetchMessageDetail(ctx.from.id, messageId);
        const downloadsDir = path.resolve(__dirname, '../../downloads');
        if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

        const htmlContent = (detail.html && detail.html.length > 0)
            ? detail.html.join('') 
            : `<pre style="white-space: pre-wrap; font-family: monospace; font-size: 14px; background: #f8f9fa; padding: 16px; border-radius: 8px;">${escapeHtml(detail.text || detail.intro || 'No content')}</pre>`;

        const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(detail.subject || 'Email Preview')}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 16px; background: #f0f2f5; color: #1c1e21; }
    .email-container { max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); overflow: hidden; }
    .email-header { background: linear-gradient(135deg, #1a73e8, #0d47a1); color: #ffffff; padding: 24px; }
    .email-header h1 { font-size: 20px; margin: 0 0 12px 0; font-weight: 600; }
    .email-meta { font-size: 13px; opacity: 0.92; margin: 4px 0; line-height: 1.5; }
    .email-body { padding: 24px; line-height: 1.6; font-size: 15px; }
    .email-body img { max-width: 100%; height: auto; border-radius: 6px; }
    .email-body a { color: #1a73e8; text-decoration: underline; font-weight: 500; }
    .email-footer { background: #f8f9fa; padding: 14px; text-align: center; font-size: 12px; color: #65676b; border-top: 1px solid #e4e6eb; }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="email-header">
      <h1>${escapeHtml(detail.subject || '(No Subject)')}</h1>
      <div class="email-meta"><b>From:</b> ${escapeHtml(detail.from?.name ? `${detail.from.name} <${detail.from.address}>` : detail.from?.address || 'Unknown')}</div>
      <div class="email-meta"><b>Date:</b> ${new Date(detail.createdAt).toLocaleString()}</div>
    </div>
    <div class="email-body">
      ${htmlContent}
    </div>
    <div class="email-footer">
      Generated by @sddaDCbOT • Disposable Temp Mail Service
    </div>
  </div>
</body>
</html>`;

        const fileName = `email_${messageId.substring(0, 8)}.html`;
        const closeBtn = new InlineKeyboard().text(isKm ? '🗑️ លុបសារ (Delete)' : '🗑️ Delete Message', 'delete_this_msg');
        await ctx.replyWithDocument(new InputFile(Buffer.from(fullHtml, 'utf8'), fileName), {
            caption: isKm 
                ? `🌐 <b>ទម្រង់ HTML ពេញលេញនៃសារអ៊ីមែល៖</b>\n<i>${escapeHtml(detail.subject || '(គ្មានប្រធានបទ)')}</i>\n\n💡 <i>(ចុចលើ File ដើម្បីបើកមើលទម្រង់ Design និងប៊ូតុងទាំងអស់ក្នុង Browser)</i>`
                : `🌐 <b>Full HTML Web Preview:</b>\n<i>${escapeHtml(detail.subject || '(No Subject)')}</i>\n\n💡 <i>(Open in any browser to see the complete rich design and buttons)</i>`,
            parse_mode: 'HTML',
            reply_markup: closeBtn
        });
    } catch (err: any) {
        logger.error('TEMPMAIL', 'Failed to generate HTML preview', err, { userId: ctx.from?.id });
        await ctx.reply(`❌ HTML Preview error: ${err.message}`);
    }
});

// ==========================================
// REAL-TIME NOTIFIER INITIALIZER (Push Notifications)
// ==========================================

export function initRealtimeMailWatcher(bot: Bot) {
    registerRealtimeMailListener(async (userId, account, detail, otp) => {
        try {
            const isKm = getUserLanguage(userId) === 'km';
            const sender = escapeHtml(detail.from?.name ? `${detail.from.name} (${detail.from.address})` : (detail.from?.address || 'Unknown'));
            const subject = escapeHtml(detail.subject || (isKm ? '(គ្មានប្រធានបទ)' : '(No Subject)'));
            const date = new Date(detail.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            let alertText = isKm ?
                `🔔 <b>ទទួលបានអ៊ីមែលថ្មី! (New Email Received)</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📬 <b>ផ្ញើមកកាន់៖</b> <code>${escapeHtml(account.address)}</code>\n` +
                `👤 <b>ពី៖</b> ${sender}\n` +
                `📌 <b>ប្រធានបទ៖</b> ${subject}\n` +
                `🕒 <b>ម៉ោង៖</b> ${date}\n`
                :
                `🔔 <b>NEW EMAIL RECEIVED!</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📬 <b>To:</b> <code>${escapeHtml(account.address)}</code>\n` +
                `👤 <b>From:</b> ${sender}\n` +
                `📌 <b>Subject:</b> ${subject}\n` +
                `🕒 <b>Time:</b> ${date}\n`;

            if (otp) {
                alertText += isKm ?
                    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🔑 <b>លេខកូដផ្ទៀងផ្ទាត់ (OTP)៖</b>\n` +
                    `👉 <code>${otp}</code> 👈 <i>(ចុចដើម្បីចម្លង)</i>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
                    :
                    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🔑 <b>Verification Code (OTP):</b>\n` +
                    `👉 <code>${otp}</code> 👈 <i>(tap to copy)</i>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            } else {
                alertText += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            }

            const bodyPreview = (detail.text || detail.intro || '').trim();
            if (bodyPreview) {
                const shortPreview = escapeHtml(bodyPreview.substring(0, 250));
                alertText += isKm ?
                    `📄 <b>ខ្លឹមសារសង្ខេប៖</b>\n<i>${shortPreview}${bodyPreview.length > 250 ? '...' : ''}</i>\n`
                    :
                    `📄 <b>Preview:</b>\n<i>${shortPreview}${bodyPreview.length > 250 ? '...' : ''}</i>\n`;
            }

            const keyboard = new InlineKeyboard();

            // Extract 1-tap action links from the incoming message for instant verification
            const rawHtml = (detail.html && detail.html.length > 0) ? detail.html.join('') : '';
            const actionLinks = extractActionLinks(rawHtml || detail.text || '');
            for (const act of actionLinks) {
                keyboard.url(`🔗 ${act.label}`, act.url).row();
            }

            keyboard
                .text(isKm ? '📖 អានសារទាំងមូល' : '📖 Read Full Email', `mail_read_${detail.id}`)
                .text(isKm ? '📬 បើកប្រអប់សារ' : '📬 Open Inbox', 'mail_inbox');

            const notifOn = getUserNotificationPreference(userId);
            await bot.api.sendMessage(userId, alertText, {
                parse_mode: 'HTML',
                reply_markup: keyboard,
                disable_notification: !notifOn
            });
        } catch (err: any) {
            if (err?.error_code === 403 || err?.description?.includes('blocked by the user')) {
                logger.info('TEMPMAIL_PUSH', `User ${userId} blocked bot, removing from active mailbox polling.`);
                deleteTempAccount(userId).catch(() => {});
            } else {
                logger.error('TEMPMAIL_PUSH', `Failed to push realtime email notification to user ${userId}`, err);
            }
        }
    });
}
