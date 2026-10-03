import fs from 'fs';
import path from 'path';
import https from 'https';
import { EdgeTTS } from 'node-edge-tts';
import { logger } from '../utils/logger';
import { redisGet, redisSet } from './redis.service';
import { updateUserPrefsInSupabase } from './supabase.service';

const DOWNLOAD_DIR = path.resolve(__dirname, '../../downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

export type SupportedTTSLanguage =
    | 'km'    // Khmer
    | 'en'    // English
    | 'zh'    // Chinese
    | 'ko'    // Korean
    | 'ja'    // Japanese
    | 'hi'    // Hindi
    | 'ms'    // Malay
    | 'id'    // Indonesian
    | 'fil'   // Filipino
    | 'ar';   // Arabic

export type VoiceGender = 'male' | 'female';

export interface TTSLanguageConfig {
    code: SupportedTTSLanguage;
    nameKm: string;
    nameEn: string;
    nativeName: string;
    flag: string;
    edgeLang: string;
    googleLang: string;
    voices: Record<VoiceGender, string>;
}

export const TTS_LANGUAGES: Record<SupportedTTSLanguage, TTSLanguageConfig> = {
    km: {
        code: 'km',
        nameKm: 'ភាសាខ្មែរ',
        nameEn: 'Khmer',
        nativeName: 'ភាសាខ្មែរ',
        flag: '🇰🇭',
        edgeLang: 'km-KH',
        googleLang: 'km',
        voices: {
            male: 'km-KH-PisethNeural',
            female: 'km-KH-SreymomNeural',
        }
    },
    en: {
        code: 'en',
        nameKm: 'ភាសាអង់គ្លេស',
        nameEn: 'English',
        nativeName: 'English',
        flag: '🇺🇸',
        edgeLang: 'en-US',
        googleLang: 'en',
        voices: {
            male: 'en-US-GuyNeural',
            female: 'en-US-JennyNeural',
        }
    },
    zh: {
        code: 'zh',
        nameKm: 'ភាសាចិន',
        nameEn: 'Chinese',
        nativeName: '中文',
        flag: '🇨🇳',
        edgeLang: 'zh-CN',
        googleLang: 'zh-CN',
        voices: {
            male: 'zh-CN-YunxiNeural',
            female: 'zh-CN-XiaoxiaoNeural',
        }
    },
    ko: {
        code: 'ko',
        nameKm: 'ភាសាកូរ៉េ',
        nameEn: 'Korean',
        nativeName: '한국어',
        flag: '🇰🇷',
        edgeLang: 'ko-KR',
        googleLang: 'ko',
        voices: {
            male: 'ko-KR-InJoonNeural',
            female: 'ko-KR-SunHiNeural',
        }
    },
    ja: {
        code: 'ja',
        nameKm: 'ភាសាជប៉ុន',
        nameEn: 'Japanese',
        nativeName: '日本語',
        flag: '🇯🇵',
        edgeLang: 'ja-JP',
        googleLang: 'ja',
        voices: {
            male: 'ja-JP-KeitaNeural',
            female: 'ja-JP-NanamiNeural',
        }
    },
    hi: {
        code: 'hi',
        nameKm: 'ភាសាហិណ្ឌី',
        nameEn: 'Hindi',
        nativeName: 'हिन्दी',
        flag: '🇮🇳',
        edgeLang: 'hi-IN',
        googleLang: 'hi',
        voices: {
            male: 'hi-IN-MadhurNeural',
            female: 'hi-IN-SwaraNeural',
        }
    },
    ms: {
        code: 'ms',
        nameKm: 'ភាសាម៉ាឡេស៊ី',
        nameEn: 'Malay',
        nativeName: 'Bahasa Melayu',
        flag: '🇲🇾',
        edgeLang: 'ms-MY',
        googleLang: 'ms',
        voices: {
            male: 'ms-MY-OsmanNeural',
            female: 'ms-MY-YasminNeural',
        }
    },
    id: {
        code: 'id',
        nameKm: 'ភាសាឥណ្ឌូនេស៊ី',
        nameEn: 'Indonesian',
        nativeName: 'Bahasa Indonesia',
        flag: '🇮🇩',
        edgeLang: 'id-ID',
        googleLang: 'id',
        voices: {
            male: 'id-ID-ArdiNeural',
            female: 'id-ID-GadisNeural',
        }
    },
    fil: {
        code: 'fil',
        nameKm: 'ភាសាហ្វីលីពីន',
        nameEn: 'Filipino',
        nativeName: 'Tagalog',
        flag: '🇵🇭',
        edgeLang: 'fil-PH',
        googleLang: 'tl',
        voices: {
            male: 'fil-PH-AngeloNeural',
            female: 'fil-PH-BlessicaNeural',
        }
    },
    ar: {
        code: 'ar',
        nameKm: 'ភាសាអារ៉ាប់',
        nameEn: 'Arabic',
        nativeName: 'العربية',
        flag: '🇸🇦',
        edgeLang: 'ar-SA',
        googleLang: 'ar',
        voices: {
            male: 'ar-SA-HamedNeural',
            female: 'ar-SA-ZariyahNeural',
        }
    }
};

/**
 * Backward compatibility alias for VOICE_MODELS
 */
export const VOICE_MODELS: Record<SupportedTTSLanguage, Record<VoiceGender, string>> = Object.entries(TTS_LANGUAGES).reduce(
    (acc, [key, val]) => {
        acc[key as SupportedTTSLanguage] = val.voices;
        return acc;
    },
    {} as Record<SupportedTTSLanguage, Record<VoiceGender, string>>
);

/**
 * Normalizes user-inputted language alias into a SupportedTTSLanguage
 */
export function normalizeLanguageCode(input?: string): SupportedTTSLanguage | null {
    if (!input) return null;
    const lower = input.trim().toLowerCase();

    const aliasMap: Record<string, SupportedTTSLanguage> = {
        km: 'km', khmer: 'km', kh: 'km',
        en: 'en', english: 'en', eng: 'en', us: 'en', uk: 'en',
        zh: 'zh', chinese: 'zh', cn: 'zh', mandarin: 'zh',
        ko: 'ko', korean: 'ko', kr: 'ko', kor: 'ko',
        ja: 'ja', japanese: 'ja', jp: 'ja', jpn: 'ja',
        hi: 'hi', hindi: 'hi', hin: 'hi', in: 'hi',
        ms: 'ms', malay: 'ms', melayu: 'ms', my: 'ms',
        id: 'id', indonesian: 'id', indonesia: 'id', indo: 'id',
        fil: 'fil', filipino: 'fil', tagalog: 'fil', tl: 'fil', ph: 'fil',
        ar: 'ar', arabic: 'ar', arab: 'ar', sa: 'ar',
    };

    return aliasMap[lower] || null;
}

/**
 * Clean text for optimal, human-like speech synthesis:
 * Strips URLs, usernames, markdown, and emojis so neural voice flows naturally.
 */
export function cleanTextForTTS(text: string): string {
    if (!text) return '';
    return text
        // Remove URLs
        .replace(/https?:\/\/\S+/g, '')
        // Remove Telegram usernames
        .replace(/@\w+/g, '')
        // Remove emojis and decorative unicode symbols so Edge TTS speaks smoothly without pausing or glitches
        .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, '')
        // Remove markdown formatting symbols
        .replace(/[*_`#~\[\]()<>]/g, ' ')
        // Convert list bullets and dashes into natural pauses
        .replace(/[•\-\–\—]/g, ', ')
        // Remove excessive punctuation
        .replace(/,\s*,+/g, ',')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Automatically detects which of the 10 languages the text belongs to
 */
export function detectLanguage(text: string, fallback: SupportedTTSLanguage = 'km'): SupportedTTSLanguage {
    if (!text || typeof text !== 'string') return fallback;

    const clean = text
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[\d\s\p{P}\p{S}]/gu, '');

    if (!clean) return fallback;

    // 1. Khmer script
    if (/[\u1780-\u17FF\u19E0-\u19FF]/.test(clean)) return 'km';

    // 2. Arabic script
    if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(clean)) return 'ar';

    // 3. Devanagari script (Hindi)
    if (/[\u0900-\u097F]/.test(clean)) return 'hi';

    // 4. Hangul script (Korean)
    if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(clean)) return 'ko';

    // 5. Japanese (Hiragana or Katakana)
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(clean)) return 'ja';

    // 6. Chinese (CJK Ideographs without Japanese Kana)
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(clean)) return 'zh';

    // 7. Latin scripts: Distinguish Filipino, Indonesian, Malay, English
    const lower = text.toLowerCase();

    // Filipino / Tagalog distinct keywords
    const filipinoRegex = /\b(ang|mga|ng|sa|ako|ikaw|siya|kami|tayo|kayo|sila|kumusta|salamat|opo|hindi|oo|bakit|ano|sino|natin|ninyo|kanila|magandang|umaga|tanghali|hapon|gabi|po)\b/i;
    if (filipinoRegex.test(lower)) return 'fil';

    // Malay distinct keywords
    const malayRegex = /\b(awak|maklumat|sahaja|kerana|ialah|boleh|mengapa|siapa|jemput|tuan|puan|tak)\b/i;
    if (malayRegex.test(lower)) return 'ms';

    // Indonesian distinct keywords
    const indonesianRegex = /\b(nggak|tidak|gimana|banget|udah|sudah|kamu|aku|adalah|dengan|untuk|terima\s+kasih|selamat|bisa|saya|dari|ini|itu|dong|deh|sih)\b/i;
    if (indonesianRegex.test(lower)) return 'id';

    // English / Latin general check
    const latinCount = (clean.match(/[a-zA-Z]/g) || []).length;
    if (latinCount > 0) return 'en';

    return fallback;
}

/**
 * Generate ultra-realistic Microsoft Edge Neural Voice (Male or Female)
 * across 10 supported languages with studio 24kHz/96kbps quality, 60s timeout, and auto-retry.
 */
export async function generateNeuralTTS(
    text: string,
    lang: SupportedTTSLanguage = 'km',
    gender: VoiceGender = 'female'
): Promise<string | null> {
    const clean = cleanTextForTTS(text);
    if (!clean) return null;

    const langConfig = TTS_LANGUAGES[lang] || TTS_LANGUAGES['km'];
    const voice = langConfig.voices[gender] || langConfig.voices['female'];
    const edgeLang = langConfig.edgeLang;
    const filename = `neural_tts_${lang}_${gender}_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const outputPath = path.join(DOWNLOAD_DIR, filename);

    // Attempt 1: Studio Quality 96kbps 24kHz Edge Neural TTS (Ultra-realistic)
    try {
        const edgeTts = new EdgeTTS({
            voice,
            lang: edgeLang,
            outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
            timeout: 60000
        });
        await edgeTts.ttsPromise(clean.substring(0, 1500), outputPath);

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            logger.info('NEURAL_TTS', `Generated ${gender} neural voice for ${lang} (${clean.length} chars, studio quality)`);
            return outputPath;
        }
    } catch (err1) {
        logger.warn('NEURAL_TTS', `First EdgeTTS attempt failed for ${lang}-${gender}, retrying...`, err1);
    }

    // Attempt 2: Standard 48kbps Edge Neural TTS (retry before fallback)
    try {
        const retryEdgeTts = new EdgeTTS({
            voice,
            lang: edgeLang,
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            timeout: 60000
        });
        await retryEdgeTts.ttsPromise(clean.substring(0, 1200), outputPath);

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            logger.info('NEURAL_TTS', `Generated ${gender} neural voice on retry for ${lang}`);
            return outputPath;
        }
    } catch (err2) {
        logger.error('NEURAL_TTS', `Both EdgeTTS attempts failed for ${lang}-${gender}`, err2);
    }

    // Fallback only if Edge servers are unreachable
    return await generateTTS(clean, lang);
}

function fetchAudioChunk(text: string, lang: string): Promise<Buffer> {
    const encoded = encodeURIComponent(text.trim());
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`;

    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                return reject(new Error(`TTS request failed with status ${res.statusCode}`));
            }
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function splitTextIntoChunks(text: string, maxLength = 150): string[] {
    const clean = text
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[*_`#~\[\]()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return [];
    if (clean.length <= maxLength) return [clean];

    const words = clean.split(' ');
    const chunks: string[] = [];
    let current = '';

    for (const word of words) {
        if (word.length > maxLength) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            for (let i = 0; i < word.length; i += maxLength) {
                chunks.push(word.substring(i, i + maxLength));
            }
        } else if ((current + ' ' + word).trim().length <= maxLength) {
            current = (current + ' ' + word).trim();
        } else {
            if (current) chunks.push(current);
            current = word;
        }
    }
    if (current) chunks.push(current);

    return chunks.slice(0, 6);
}

export async function generateTTS(text: string, lang: SupportedTTSLanguage): Promise<string | null> {
    try {
        const langConfig = TTS_LANGUAGES[lang] || TTS_LANGUAGES['km'];
        const googleLang = langConfig.googleLang;
        const chunks = splitTextIntoChunks(text);
        if (chunks.length === 0) return null;

        const buffers: Buffer[] = [];
        for (const chunk of chunks) {
            const buf = await fetchAudioChunk(chunk, googleLang);
            buffers.push(buf);
        }

        const combined = Buffer.concat(buffers);
        const filename = `tts_${lang}_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
        const outputPath = path.join(DOWNLOAD_DIR, filename);

        fs.writeFileSync(outputPath, combined);
        return outputPath;
    } catch (error) {
        logger.error('TTS', `TTS generation failed for language '${lang}'`, error, { textSample: text.substring(0, 40) });
        return null;
    }
}

// ==========================================
// User Voice Gender Preferences (Male / Female)
// ==========================================
const userVoiceGenders = new Map<number, VoiceGender>();

export function getUserVoiceGender(userId?: number): VoiceGender {
    if (!userId) return 'female';
    return userVoiceGenders.get(userId) || 'female';
}

export function setUserVoiceGender(userId: number, gender: VoiceGender): void {
    userVoiceGenders.set(userId, gender);
    redisSet(`user:gender:${userId}`, gender, 30 * 86400).catch(() => {});
    updateUserPrefsInSupabase(userId, { gender }).catch(() => {});
}

export async function loadUserVoiceGender(userId: number): Promise<VoiceGender> {
    if (userVoiceGenders.has(userId)) {
        return userVoiceGenders.get(userId)!;
    }
    const cached = await redisGet<VoiceGender>(`user:gender:${userId}`);
    if (cached === 'male' || cached === 'female') {
        userVoiceGenders.set(userId, cached);
        return cached;
    }
    userVoiceGenders.set(userId, 'female');
    return 'female';
}

// ==========================================
// Token Caching for Gender Buttons Callback Query & Shared Voice Notes
// ==========================================
export interface TTSCacheItem {
    text: string;
    lang: SupportedTTSLanguage;
    voiceFileId?: string;
    gender?: VoiceGender;
}

const ttsTextCache = new Map<string, TTSCacheItem>();

export function createTTSToken(): string {
    return Math.random().toString(36).substring(2, 10);
}

export async function saveTTSTextCache(
    token: string,
    text: string,
    lang: SupportedTTSLanguage,
    voiceFileId?: string,
    gender?: VoiceGender
): Promise<void> {
    const item: TTSCacheItem = { text, lang, voiceFileId, gender };
    ttsTextCache.set(token, item);
    if (ttsTextCache.size > 500) {
        const oldestKey = ttsTextCache.keys().next().value;
        if (oldestKey) ttsTextCache.delete(oldestKey);
    }
    await redisSet(`tts:text:${token}`, JSON.stringify(item), 86400).catch(() => {});
}

export async function updateTTSVoiceFileId(token: string, voiceFileId: string): Promise<void> {
    const item = await getTTSTextCache(token);
    if (item) {
        item.voiceFileId = voiceFileId;
        await saveTTSTextCache(token, item.text, item.lang, voiceFileId, item.gender);
    }
}

export async function getTTSTextCache(token: string): Promise<TTSCacheItem | null> {
    if (ttsTextCache.has(token)) {
        return ttsTextCache.get(token)!;
    }
    const cached = await redisGet<string>(`tts:text:${token}`);
    if (cached) {
        try {
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            if (parsed && parsed.text) {
                ttsTextCache.set(token, parsed);
                return parsed;
            }
        } catch (e) {}
    }
    return null;
}

// ==========================================
// User Language Preference (10 Languages or Auto)
// ==========================================
const userVoicePreferences = new Map<number, SupportedTTSLanguage | 'auto'>();

export function getUserVoicePreference(userId?: number): SupportedTTSLanguage | 'auto' {
    if (!userId) return 'auto';
    return userVoicePreferences.get(userId) || 'auto';
}

export function setUserVoicePreference(userId: number, pref: SupportedTTSLanguage | 'auto'): void {
    userVoicePreferences.set(userId, pref);
    redisSet(`user:voice:${userId}`, pref, 30 * 86400).catch(() => {});
}

export async function loadUserVoicePreference(userId: number): Promise<SupportedTTSLanguage | 'auto'> {
    if (userVoicePreferences.has(userId)) {
        return userVoicePreferences.get(userId)!;
    }
    const cached = await redisGet<string>(`user:voice:${userId}`);
    if (cached && (cached === 'auto' || cached in TTS_LANGUAGES)) {
        const validated = cached as SupportedTTSLanguage | 'auto';
        userVoicePreferences.set(userId, validated);
        return validated;
    }
    userVoicePreferences.set(userId, 'auto');
    return 'auto';
}

export async function generateAutoTTS(text: string, userId?: number): Promise<{ audioPath: string | null; lang: SupportedTTSLanguage }> {
    const pref = getUserVoicePreference(userId);
    let lang: SupportedTTSLanguage;
    if (pref !== 'auto' && pref in TTS_LANGUAGES) {
        lang = pref;
    } else {
        lang = detectLanguage(text);
    }
    const gender = getUserVoiceGender(userId);
    logger.info('TTS', `Selected language '${lang}' and gender '${gender}' for direct TTS (user pref: ${pref})`);
    const audioPath = await generateNeuralTTS(text, lang, gender);
    return { audioPath, lang };
}

export async function generateEnglishTTS(text: string, gender: VoiceGender = 'female'): Promise<string | null> {
    return generateNeuralTTS(text, 'en', gender);
}

export async function generateKhmerTTS(text: string, gender: VoiceGender = 'female'): Promise<string | null> {
    return generateNeuralTTS(text, 'km', gender);
}
