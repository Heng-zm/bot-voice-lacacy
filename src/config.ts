import dotenv from 'dotenv';

dotenv.config();

const parsedAdminIds = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(id => Number.isSafeInteger(id) && id > 0);

export const config = Object.freeze({
    BOT_TOKEN: (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
    GEMINI_MODEL: (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim(),
    REDIS_URL: (process.env.REDIS_URL || '').trim(),
    SUPABASE_URL: (process.env.SUPABASE_URL || '').trim(),
    SUPABASE_KEY: (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    ADMIN_IDS: Object.freeze(parsedAdminIds) as readonly number[],
});
