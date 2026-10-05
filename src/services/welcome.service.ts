import { redisGet, redisSet, redisDel, isRedisConnected } from './redis.service';

export interface CustomWelcomeConfig {
    enabled: boolean;
    photoFileId: string | null;
    caption: string | null;
    updatedAt?: string;
}

// In-memory fallback
let memoryWelcomeConfig: CustomWelcomeConfig = {
    enabled: false,
    photoFileId: null,
    caption: null
};

// Admin awaiting states (e.g. 'awaiting_welcome_photo', 'awaiting_welcome_caption')
const adminStates = new Map<number, string>();

export async function getAdminState(userId: number): Promise<string | null> {
    if (adminStates.has(userId)) return adminStates.get(userId)!;
    if (isRedisConnected()) {
        const val = await redisGet<string>(`admin:state:${userId}`);
        if (val) {
            adminStates.set(userId, val);
            return val;
        }
    }
    return null;
}

export async function setAdminState(userId: number, state: string | null): Promise<void> {
    if (!state) {
        adminStates.delete(userId);
        if (isRedisConnected()) await redisDel(`admin:state:${userId}`);
    } else {
        adminStates.set(userId, state);
        if (isRedisConnected()) await redisSet(`admin:state:${userId}`, state, 600); // 10 mins expiry
    }
}

export async function getCustomWelcomeConfig(): Promise<CustomWelcomeConfig> {
    if (isRedisConnected()) {
        const data = await redisGet<CustomWelcomeConfig>('bot:custom_welcome');
        if (data && typeof data === 'object') {
            memoryWelcomeConfig = data;
            return data;
        }
    }
    return memoryWelcomeConfig;
}

export async function setCustomWelcomePhoto(photoFileId: string, caption?: string): Promise<void> {
    const current = await getCustomWelcomeConfig();
    const updated: CustomWelcomeConfig = {
        enabled: true,
        photoFileId,
        caption: (caption && caption.trim()) ? caption.trim() : (current.caption || getDefaultWelcomeCaption()),
        updatedAt: new Date().toISOString()
    };
    memoryWelcomeConfig = updated;
    if (isRedisConnected()) {
        await redisSet('bot:custom_welcome', updated);
    }
}

export async function setCustomWelcomeCaption(caption: string): Promise<void> {
    const current = await getCustomWelcomeConfig();
    const updated: CustomWelcomeConfig = {
        ...current,
        enabled: true,
        caption: caption.trim(),
        updatedAt: new Date().toISOString()
    };
    memoryWelcomeConfig = updated;
    if (isRedisConnected()) {
        await redisSet('bot:custom_welcome', updated);
    }
}

export async function resetCustomWelcome(): Promise<void> {
    memoryWelcomeConfig = {
        enabled: false,
        photoFileId: null,
        caption: null,
        updatedAt: new Date().toISOString()
    };
    if (isRedisConnected()) {
        await redisDel('bot:custom_welcome');
    }
}

import { FeatureKey, isFeatureEnabledSync } from './features.service';

export function buildFeaturesBulletList(features?: Partial<Record<FeatureKey, boolean>>, isKm = true): string {
    const isFeatActive = (key: FeatureKey) => {
        if (features && features[key] !== undefined) return !!features[key];
        return isFeatureEnabledSync(key);
    };

    const lines: string[] = [];
    if (isFeatActive('chat')) {
        lines.push(isKm 
            ? '• 🤖 <b>AI Chat៖</b> សួរ សរសេរ និងទទួលជំនួយដោយ Gemini 3.6 Flash' 
            : '• 🤖 <b>AI Chat:</b> Ask questions, chat and get assistance powered by Gemini 3.6 Flash');
    }
    if (isFeatActive('tts')) {
        lines.push(isKm 
            ? '• 🔊 <b>Text-to-Speech៖</b> បម្លែងអត្ថបទជាសំឡេង ១០ ភាសា (Studio HD 96k)' 
            : '• 🔊 <b>Text-to-Speech:</b> Convert text to neural speech in 10 languages (Studio HD 96k)');
    }
    if (isFeatActive('vision')) {
        lines.push(isKm 
            ? '• 📸 <b>Vision OCR៖</b> ស្រង់អក្សរពីរូបភាព & បកប្រែជាភាសាខ្មែរ' 
            : '• 📸 <b>Vision OCR:</b> Extract text from photos & translate to Khmer');
    }
    if (isFeatActive('tempmail')) {
        lines.push(isKm 
            ? '• 📧 <b>Temp Mail៖</b> ទទួលអ៊ីមែល និង OTP ជូនដំណឹងភ្លាមៗ' 
            : '• 📧 <b>Temp Mail:</b> Disposable email inbox with instant OTP notifications');
    }
    if (isFeatActive('downloader')) {
        lines.push(isKm 
            ? '• 📥 <b>Media Downloader៖</b> ទាញយកពី TikTok, YouTube, Instagram និង Facebook' 
            : '• 📥 <b>Media Downloader:</b> Download videos from TikTok, YouTube, Instagram and Facebook');
    }
    return lines.join('\n');
}

export function getDefaultWelcomeCaption(features?: Partial<Record<FeatureKey, boolean>>): string {
    const bullets = buildFeaturesBulletList(features, true);
    return `🌟 <b>សួស្តី {name}!</b> សូមស្វាគមន៍មកកាន់ <b>@sddaDCbOT</b>!\n\n` +
           `✨ <b>មុខងាររបស់អ្នក</b>៖\n` +
           (bullets ? `${bullets}\n\n` : '') +
           `👇 <b>ជ្រើសរើសមុខងារមួយខាងក្រោមដើម្បីចាប់ផ្តើម</b>៖`;
}

export function formatWelcomeCaption(
    template: string,
    user: { firstName: string; username?: string; id: number }
): string {
    const name = user.firstName || 'មិត្តភក្តិ';
    const username = user.username ? `@${user.username}` : name;
    const id = String(user.id);

    return template
        .replace(/\{name\}/gi, name)
        .replace(/\{username\}/gi, username)
        .replace(/\{id\}/gi, id);
}
