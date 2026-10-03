import { redisGet, redisSet, isRedisConnected } from './redis.service';
import { getSupabaseSetting, setSupabaseSetting } from './supabase.service';
import { logger } from '../utils/logger';

export type FeatureKey = 'chat' | 'tts' | 'downloader' | 'tempmail' | 'vision';

export interface FeatureMeta {
    key: FeatureKey;
    nameKm: string;
    nameEn: string;
    icon: string;
    description: string;
}

export const FEATURES: Record<FeatureKey, FeatureMeta> = {
    chat: {
        key: 'chat',
        nameKm: 'សន្ទនា AI (Gemini)',
        nameEn: 'AI Chat',
        icon: '🤖',
        description: 'សន្ទនាឆ្លាតវៃជាមួយ Gemini 3.6 Flash'
    },
    tts: {
        key: 'tts',
        nameKm: 'បំប្លែងសំឡេង (Neural TTS)',
        nameEn: 'Neural TTS',
        icon: '🔊',
        description: 'បំប្លែងអក្សរទៅជាសំឡេងមនុស្សពិត ១០ ភាសា'
    },
    downloader: {
        key: 'downloader',
        nameKm: 'ទាញយកវីដេអូ (Downloader)',
        nameEn: 'Media Downloader',
        icon: '📥',
        description: 'ទាញយកវីដេអូពី TikTok, YouTube, FB, IG'
    },
    tempmail: {
        key: 'tempmail',
        nameKm: 'អ៊ីមែលបណ្តោះអាសន្ន (TempMail)',
        nameEn: 'TempMail',
        icon: '📧',
        description: 'បង្កើតអ៊ីមែលបណ្តោះអាសន្ន និងទទួលសារ Realtime'
    },
    vision: {
        key: 'vision',
        nameKm: 'ស្កេនរូបភាព OCR (Vision)',
        nameEn: 'Vision OCR',
        icon: '📸',
        description: 'វិភាគរូបភាព និងទាញយកអត្ថបទខ្មែរ/អង់គ្លេស'
    }
};

// In-memory fallback if Redis and Supabase are unreachable
const localFeatureState = new Map<FeatureKey, boolean>();

/**
 * Check if a specific module/feature is active (enabled)
 * Defaults to true if never explicitly set to '0'
 */
export async function isFeatureEnabled(key: FeatureKey): Promise<boolean> {
    const redisKey = `bot:module:${key}`;

    if (isRedisConnected()) {
        const val = await redisGet<string>(redisKey);
        if (val !== null && val !== undefined) {
            return String(val) !== '0';
        }
    }

    // Fallback to Supabase bot_settings
    const dbVal = await getSupabaseSetting(`module_${key}`, '1');
    const enabled = String(dbVal) !== '0';

    if (isRedisConnected()) {
        redisSet(redisKey, enabled ? '1' : '0', 86400).catch(() => {});
    }

    return localFeatureState.has(key) ? localFeatureState.get(key)! : enabled;
}

/**
 * Toggle a feature state between Enabled and Disabled
 */
export async function toggleFeature(key: FeatureKey, updatedBy?: number): Promise<boolean> {
    const current = await isFeatureEnabled(key);
    const nextState = !current;

    localFeatureState.set(key, nextState);

    const valStr = nextState ? '1' : '0';

    if (isRedisConnected()) {
        await redisSet(`bot:module:${key}`, valStr);
    }

    await setSupabaseSetting(`module_${key}`, valStr, updatedBy).catch(() => {});

    logger.info('FEATURE_TOGGLE', `Feature '${key}' set to ${nextState ? 'ENABLED' : 'DISABLED'} by admin ${updatedBy || 'system'}`);
    return nextState;
}

/**
 * Get the status of all bot features
 */
export async function getAllFeaturesStatus(): Promise<Record<FeatureKey, boolean>> {
    const keys = Object.keys(FEATURES) as FeatureKey[];
    const result: Partial<Record<FeatureKey, boolean>> = {};

    await Promise.all(
        keys.map(async (k) => {
            result[k] = await isFeatureEnabled(k);
        })
    );

    return result as Record<FeatureKey, boolean>;
}
