import { logger } from './logger';

/**
 * Escapes characters for HTML entities (&, <, >).
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Decodes common HTML entities back to raw text.
 */
export function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

/**
 * Ensures all opened HTML tags in a string are cleanly closed in reverse order.
 * Supported Telegram tags: b, i, s, u, code, pre, blockquote, a.
 */
function balanceHtmlTags(html: string): string {
    const supportedTags = ['b', 'i', 's', 'u', 'code', 'pre', 'blockquote', 'a'];
    const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*)?>/g;
    const stack: { tag: string; index: number }[] = [];
    const orphanClosingIndices: { start: number; end: number }[] = [];
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(html)) !== null) {
        const fullTag = match[0];
        const tagName = match[1].toLowerCase();

        if (!supportedTags.includes(tagName)) continue;

        if (fullTag.startsWith('</')) {
            // Closing tag
            const idx = stack.map(s => s.tag).lastIndexOf(tagName);
            if (idx !== -1) {
                stack.splice(idx, 1);
            } else {
                // Orphan closing tag (has no opening tag in this chunk)
                orphanClosingIndices.push({ start: match.index, end: match.index + fullTag.length });
            }
        } else if (!fullTag.endsWith('/>')) {
            // Opening tag
            stack.push({ tag: tagName, index: match.index });
        }
    }

    // Remove orphan closing tags from end to start so indices stay accurate
    let result = html;
    for (let i = orphanClosingIndices.length - 1; i >= 0; i--) {
        const { start, end } = orphanClosingIndices[i];
        result = result.substring(0, start) + result.substring(end);
    }

    // Close any unclosed tags
    while (stack.length > 0) {
        const unclosed = stack.pop();
        if (unclosed) {
            result += `</${unclosed.tag}>`;
        }
    }

    return result;
}

/**
 * Converts standard AI Markdown output into beautiful, compliant Telegram HTML.
 */
export function formatTelegramHtml(markdown: string): string {
    if (!markdown || !markdown.trim()) return '';

    let text = markdown.replace(/\r\n/g, '\n');

    // 1. Preserve Code Blocks (```lang\ncode\n```)
    const codeBlocks: { lang?: string; code: string }[] = [];
    text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang: lang ? lang.trim() : undefined, code });
        return `\x00CODEBLOCK_${idx}\x00`;
    });

    // Handle backtick code blocks without trailing newline before closing
    text = text.replace(/```([a-zA-Z0-9_-]*)([\s\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang: lang ? lang.trim() : undefined, code: code.trim() });
        return `\x00CODEBLOCK_${idx}\x00`;
    });

    // 2. Preserve Inline Code (`code`)
    const inlineCodes: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push(code);
        return `\x00INLINE_${idx}\x00`;
    });

    // 3. Process Blockquotes (> text)
    // Matches one or more lines starting with >
    text = text.replace(/(?:^|\n)(?:>[ \t]*[^\n]*(?:\n>[ \t]*[^\n]*)*)/g, (block) => {
        const lines = block
            .split('\n')
            .filter(l => l.trim().length > 0)
            .map(l => l.replace(/^[ \t]*>[ \t]?/, ''))
            .join('\n');
        return `\n<blockquote>${lines}</blockquote>\n`;
    });

    // 4. HTML Escape remaining text to avoid broken tag errors
    text = escapeHtml(text);

    // 5. Convert Headers (# Heading, ## Heading, ### Heading)
    text = text.replace(/^[ \t]*#{1,6}[ \t]+([^\n]+)$/gm, '\n<b>$1</b>\n');

    // 6. Horizontal Rules (---, ***, ___)
    text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 7. Bullet Lists (* item, - item, + item)
    text = text.replace(/^[ \t]*[\*\-\+][ \t]+([^\n]+)$/gm, '• $1');

    // 8. Numbered Lists (1. item -> <b>1.</b> item)
    text = text.replace(/^[ \t]*(\d+)\.[ \t]+([^\n]+)$/gm, '<b>$1.</b> $2');

    // 9. Bold + Italic (***text*** or ___text___)
    text = text.replace(/\*\*\*([^\*\n]+?)\*\*\*/g, '<b><i>$1</i></b>');
    text = text.replace(/___([^_\n]+?)___/g, '<b><i>$1</i></b>');

    // 10. Bold (**text** or __text__)
    text = text.replace(/\*\*([^\*\n]+?)\*\*/g, '<b>$1</b>');
    text = text.replace(/__([^_\n]+?)__/g, '<b>$1</b>');

    // 11. Italic (*text* or _text_)
    // Use word boundaries or whitespace anchors to avoid snake_case identifiers
    text = text.replace(/(^|[\s(])\*([^\*\n]+?)\*([\s),.?!:;]|$)/g, '$1<i>$2</i>$3');
    text = text.replace(/(^|[\s(])_([^_\n]+?)_([\s),.?!:;]|$)/g, '$1<i>$2</i>$3');

    // 12. Strikethrough (~~text~~)
    text = text.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');

    // 13. Links ([text](https://...))
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2">$1</a>');

    // 14. Restore Code Blocks
    for (let i = 0; i < codeBlocks.length; i++) {
        const item = codeBlocks[i];
        const escapedCode = escapeHtml(item.code);
        const tag = item.lang
            ? `<pre><code class="language-${escapeHtml(item.lang)}">${escapedCode}</code></pre>`
            : `<pre>${escapedCode}</pre>`;
        text = text.replace(`\x00CODEBLOCK_${i}\x00`, tag);
    }

    // 15. Restore Inline Code
    for (let i = 0; i < inlineCodes.length; i++) {
        const escaped = escapeHtml(inlineCodes[i]);
        text = text.replace(`\x00INLINE_${i}\x00`, `<code>${escaped}</code>`);
    }

    // Clean up duplicate empty lines (more than 2 consecutive newlines)
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // 16. Balance all HTML tags to prevent Telegram parse entity errors
    return balanceHtmlTags(text);
}

/**
 * Splits a long text into multiple Telegram-friendly chunks (max 4000 characters).
 * Preserves tag balancing across chunks.
 */
export function splitTelegramMessage(text: string, maxLength = 4000): string[] {
    if (!text || text.length <= maxLength) {
        return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(balanceHtmlTags(remaining));
            break;
        }

        let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = remaining.lastIndexOf('\n', maxLength);
        }
        if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitIndex === -1) {
            splitIndex = maxLength;
        }

        const chunk = remaining.substring(0, splitIndex).trim();
        remaining = remaining.substring(splitIndex).trim();

        if (chunk.length > 0) {
            chunks.push(balanceHtmlTags(chunk));
        }
    }

    return chunks;
}

/**
 * Safely sends or edits an AI response in Telegram.
 * Handles animation message updating, long text splitting, and automatic plain-text fallback on parsing issues.
 */
export async function sendOrEditAiResponse(
    ctx: any,
    targetMessageId: number | null,
    rawAiText: string,
    replyMarkup?: any,
    replyToMessageId?: number
): Promise<number | undefined> {
    const formatted = formatTelegramHtml(rawAiText);
    const chunks = splitTelegramMessage(formatted);

    let firstMsgId: number | undefined = targetMessageId || undefined;

    for (let i = 0; i < chunks.length; i++) {
        const isFirst = i === 0;
        const isLast = i === chunks.length - 1;
        const chunkText = chunks[i];
        const markup = isLast ? replyMarkup : undefined;

        if (isFirst && targetMessageId) {
            // Edit existing thinking animation message
            try {
                await ctx.api.editMessageText(ctx.chat.id, targetMessageId, chunkText, {
                    parse_mode: 'HTML',
                    reply_markup: markup,
                    link_preview_options: { is_disabled: true }
                });
                firstMsgId = targetMessageId;
            } catch (err: any) {
                const desc = err?.description || '';
                logger.warn('AI_FORMAT', `editMessageText with HTML failed: ${desc}. Falling back to plain text.`);
                // Fallback to plain text stripped of HTML tags
                try {
                    const plain = decodeHtmlEntities(chunkText.replace(/<[^>]*>/g, ''));
                    await ctx.api.editMessageText(ctx.chat.id, targetMessageId, plain, {
                        reply_markup: markup,
                        link_preview_options: { is_disabled: true }
                    });
                    firstMsgId = targetMessageId;
                } catch (fallbackErr: any) {
                    logger.error('AI_FORMAT', 'Plain text fallback edit also failed, sending fresh reply', fallbackErr);
                    try {
                        await ctx.api.deleteMessage(ctx.chat.id, targetMessageId);
                    } catch (delErr) {}
                    const sent = await ctx.reply(chunkText, {
                        parse_mode: 'HTML',
                        reply_markup: markup,
                        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined
                    }).catch(() => ctx.reply(rawAiText, { reply_markup: markup }));
                    firstMsgId = sent?.message_id;
                }
            }
        } else {
            // Send subsequent chunks as replies
            try {
                const sent = await ctx.reply(chunkText, {
                    parse_mode: 'HTML',
                    reply_markup: markup,
                    reply_parameters: (isFirst && replyToMessageId) ? { message_id: replyToMessageId } : undefined,
                    link_preview_options: { is_disabled: true }
                });
                if (!firstMsgId) firstMsgId = sent?.message_id;
            } catch (err: any) {
                logger.warn('AI_FORMAT', `reply chunk with HTML failed: ${err.message}. Retrying plain text.`);
                const plain = decodeHtmlEntities(chunkText.replace(/<[^>]*>/g, ''));
                const sent = await ctx.reply(plain, {
                    reply_markup: markup,
                    reply_parameters: (isFirst && replyToMessageId) ? { message_id: replyToMessageId } : undefined
                });
                if (!firstMsgId) firstMsgId = sent?.message_id;
            }
        }
    }

    return firstMsgId;
}

/**
 * Safely sanitizes and truncates a string for Telegram messages and UTF-8 transmission.
 * - Removes null bytes (\0) and non-printable control characters that crash Telegram/JSON parsers.
 * - Cleans up lone / unpaired surrogates using String.prototype.toWellFormed.
 * - Slices safely along Unicode code point boundaries using Array.from,
 *   guaranteeing that emoji modifiers, composite glyphs, and astral characters are never split in half.
 */
export function safeUtf8Slice(
    text: string | null | undefined,
    maxChars?: number,
    addEllipsis = true
): string {
    if (!text) return '';

    // 1. Remove null bytes (\u0000) and dangerous control characters (\u0001-\u0008, \u000B, \u000C, \u000E-\u001F, \u007F)
    // Preserves standard whitespace (\n, \r, \t)
    let cleaned = String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

    // 2. Ensure string is well-formed UTF-16/UTF-8 (no lone / unpaired surrogates)
    if (typeof (cleaned as any).toWellFormed === 'function') {
        cleaned = (cleaned as any).toWellFormed();
    }
    // Safeguard: strip any leftover lone surrogates
    cleaned = cleaned.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

    // 3. If truncation requested, split by Unicode code points rather than UTF-16 code units
    if (typeof maxChars === 'number' && maxChars > 0) {
        const points = Array.from(cleaned);
        if (points.length > maxChars) {
            return points.slice(0, maxChars).join('') + (addEllipsis ? '...' : '');
        }
    }

    return cleaned;
}
