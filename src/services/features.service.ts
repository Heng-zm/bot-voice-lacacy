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

// In-memory synced state for instant zero-latency UI checks & fallback
const localFeatureState = new Map<FeatureKey, boolean>();

interface CachedFeatureState {
    enabled: boolean;
    cachedAt: number;
}
const localFeatureCache = new Map<FeatureKey, CachedFeatureState>();
const CACHE_TTL_MS = 4000; // 4 seconds short TTL for instant cross-instance sync

/**
 * Robustly parses boolean status from diverse formats: '0', 0, 'false', false, 'disabled', 'off', etc.
 */
export function parseEnabledValue(val: any): boolean {
    if (val === null || val === undefined) return true;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    const str = String(val).trim().toLowerCase();
    if (str === '0' || str === 'false' || str === 'disabled' || str === 'off' || str === 'no') {
        return false;
    }
    return true;
}

/**
 * Check synchronously if a feature is enabled from the active in-memory cache.
 * Defaults to true if not yet initialized.
 */
export function isFeatureEnabledSync(key: FeatureKey): boolean {
    const cached = localFeatureCache.get(key);
    if (cached) {
        return cached.enabled;
    }
    if (localFeatureState.has(key)) {
        return localFeatureState.get(key)!;
    }
    return true;
}

/**
 * Check if a specific module/feature is active (enabled)
 * Defaults to true if never explicitly disabled
 */
export async function isFeatureEnabled(key: FeatureKey, forceRefresh = false): Promise<boolean> {
    const now = Date.now();
    const cached = localFeatureCache.get(key);
    if (!forceRefresh && cached && (now - cached.cachedAt < CACHE_TTL_MS)) {
        return cached.enabled;
    }

    const redisKey = `bot:module:${key}`;

    if (isRedisConnected()) {
        try {
            const val = await redisGet<any>(redisKey);
            if (val !== null && val !== undefined) {
                const enabled = parseEnabledValue(val);
                localFeatureCache.set(key, { enabled, cachedAt: now });
                localFeatureState.set(key, enabled);
                return enabled;
            }
        } catch (err) {
            logger.warn('FEATURES', `Redis get error for ${redisKey}`, err);
        }
    }

    // Fallback to Supabase bot_settings
    let enabled = true;
    try {
        const dbVal = await getSupabaseSetting(`module_${key}`, '1');
        enabled = parseEnabledValue(dbVal);
    } catch (err) {
        logger.warn('FEATURES', `Supabase get error for module_${key}`, err);
        if (cached) return cached.enabled;
    }

    if (isRedisConnected()) {
        redisSet(redisKey, enabled ? '1' : '0', 86400).catch(() => {});
    }

    localFeatureCache.set(key, { enabled, cachedAt: now });
    localFeatureState.set(key, enabled);
    return enabled;
}

/**
 * Initialize all feature states into memory on bot launch
 */
export async function initFeaturesService(): Promise<void> {
    const keys = Object.keys(FEATURES) as FeatureKey[];
    await Promise.all(
        keys.map(async (k) => {
            const state = await isFeatureEnabled(k, true);
            localFeatureState.set(k, state);
            localFeatureCache.set(k, { enabled: state, cachedAt: Date.now() });
        })
    );
    logger.info('FEATURES', `Features initialized. Active modules: ${keys.filter(k => localFeatureState.get(k)).join(', ')}`);
}

/**
 * Toggle a feature state between Enabled and Disabled
 */
export async function toggleFeature(key: FeatureKey, updatedBy?: number): Promise<boolean> {
    const current = await isFeatureEnabled(key, true);
    const nextState = !current;
    const now = Date.now();

    localFeatureCache.set(key, { enabled: nextState, cachedAt: now });
    localFeatureState.set(key, nextState);

    const valStr = nextState ? '1' : '0';

    if (isRedisConnected()) {
        await redisSet(`bot:module:${key}`, valStr);
    }

    await setSupabaseSetting(`module_${key}`, valStr, updatedBy).catch((e) => {
        logger.error('FEATURES', `Failed to persist module_${key} setting to Supabase`, e);
    });

    logger.info('FEATURE_TOGGLE', `Feature '${key}' set to ${nextState ? 'ENABLED' : 'DISABLED'} by admin ${updatedBy || 'system'}`);
    return nextState;
}

/**
 * Set a feature state explicitly (Enabled or Disabled)
 */
export async function setFeatureState(key: FeatureKey, enabled: boolean, updatedBy?: number): Promise<boolean> {
    const now = Date.now();
    localFeatureCache.set(key, { enabled, cachedAt: now });
    localFeatureState.set(key, enabled);

    const valStr = enabled ? '1' : '0';

    if (isRedisConnected()) {
        await redisSet(`bot:module:${key}`, valStr);
    }

    await setSupabaseSetting(`module_${key}`, valStr, updatedBy).catch((e) => {
        logger.error('FEATURES', `Failed to persist module_${key} setting to Supabase`, e);
    });

    logger.info('FEATURE_SET', `Feature '${key}' explicitly set to ${enabled ? 'ENABLED' : 'DISABLED'} by admin ${updatedBy || 'system'}`);
    return enabled;
}

/**
 * Get the status of all bot features
 */
export async function getAllFeaturesStatus(forceRefresh: boolean = false): Promise<Record<FeatureKey, boolean>> {
    const keys = Object.keys(FEATURES) as FeatureKey[];
    const result: Partial<Record<FeatureKey, boolean>> = {};

    await Promise.all(
        keys.map(async (k) => {
            result[k] = await isFeatureEnabled(k, forceRefresh);
        })
    );

    return result as Record<FeatureKey, boolean>;
}
