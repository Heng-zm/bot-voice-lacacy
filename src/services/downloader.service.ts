import ytDlp from 'yt-dlp-exec';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

const DOWNLOAD_DIR = path.resolve(__dirname, '../../downloads');

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Locate ffmpeg binary if available
let ffmpegPath: string | null = null;
try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
        ffmpegPath = ffmpegStatic;
        logger.info('DOWNLOADER', `FFmpeg binary located at: ${ffmpegPath}`);
    }
} catch (e) {
    ffmpegPath = null;
}

// Whitelisted media domains to eliminate SSRF and internal network access
const ALLOWED_MEDIA_DOMAINS = [
    'tiktok.com',
    'douyin.com',
    'youtube.com',
    'youtu.be',
    'facebook.com',
    'fb.watch',
    'fb.com',
    'instagram.com',
    'threads.net',
    'twitter.com',
    'x.com',
    'pinterest.com',
    'pin.it'
];

/**
 * Validates URLs against SSRF, internal IP access, and command argument injection.
 */
export function validateSafeMediaUrl(rawUrl: string): { isValid: boolean; sanitizedUrl?: string; error?: string } {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return { isValid: false, error: 'Empty URL' };
    }

    const trimmed = rawUrl.trim();

    // 1. Prevent command-line flag injection (e.g. --exec, --config)
    if (trimmed.startsWith('-')) {
        return { isValid: false, error: 'Invalid URL format' };
    }

    // 2. Strict protocol check: only http and https allowed
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return { isValid: false, error: 'Invalid protocol. Only HTTP/HTTPS supported.' };
    }

    // 3. URL parsing and SSRF validation
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return { isValid: false, error: 'Malformed URL' };
    }

    // Reject userinfo credentials in URL
    if (parsed.username || parsed.password) {
        return { isValid: false, error: 'Userinfo credentials in URL are prohibited' };
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost, loopbacks, internal/private IPs, cloud metadata endpoints
    const isPrivateIp = 
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        hostname === '169.254.169.254' || // Cloud instance metadata IP
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal');

    if (isPrivateIp) {
        return { isValid: false, error: 'Access to private and internal networks is prohibited' };
    }

    // 4. Whitelist verification
    const isAllowedDomain = ALLOWED_MEDIA_DOMAINS.some(domain => 
        hostname === domain || hostname.endsWith(`.${domain}`)
    );

    if (!isAllowedDomain) {
        return { isValid: false, error: 'Domain not supported. Only TikTok, YouTube, Facebook, and Instagram are allowed.' };
    }

    return { isValid: true, sanitizedUrl: parsed.toString() };
}

/**
 * Timeout wrapper to prevent runaway download processes from hanging indefinitely.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs = 75000, errorMsg = 'Download operation timed out'): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(errorMsg)), timeoutMs);
        promise
            .then(res => { clearTimeout(timer); resolve(res); })
            .catch(err => { clearTimeout(timer); reject(err); });
    });
}

// Auto-clean downloads directory: Purge files older than 10 minutes or temp files asynchronously
export async function cleanOldDownloads(): Promise<void> {
    try {
        if (!fs.existsSync(DOWNLOAD_DIR)) return;
        const now = Date.now();
        const files = await fs.promises.readdir(DOWNLOAD_DIR);
        for (const file of files) {
            const filePath = path.join(DOWNLOAD_DIR, file);
            try {
                const stat = await fs.promises.stat(filePath);
                const isTemp = file.endsWith('.part') || file.endsWith('.ytdl') || file.includes('.temp.');
                const ageMs = now - stat.mtimeMs;
                if ((isTemp && ageMs > 2 * 60 * 1000) || ageMs > 10 * 60 * 1000) {
                    await fs.promises.unlink(filePath).catch(() => {});
                    logger.info('DOWNLOADER', `Auto-purged orphan download file: ${file}`);
                }
            } catch (e) {}
        }
    } catch (e) {}
}

// Run cleanup immediately on load and every 5 minutes
cleanOldDownloads().catch(() => {});
setInterval(() => {
    cleanOldDownloads().catch(() => {});
}, 5 * 60 * 1000);

export async function downloadMedia(url: string): Promise<string | null> {
    const check = validateSafeMediaUrl(url);
    if (!check.isValid || !check.sanitizedUrl) {
        logger.warn('DOWNLOADER_SEC', `Rejected unsafe download URL: ${url} (${check.error})`);
        throw new Error(`Security validation failed: ${check.error}`);
    }

    const safeUrl = check.sanitizedUrl;
    logger.info('DOWNLOADER', `Attempting media download for URL: ${safeUrl}`);
    const timestamp = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

    try {
        const outputTemplate = path.join(DOWNLOAD_DIR, `${timestamp}_%(id)s.%(ext)s`);
        
        // Optimized format selector
        const formatString = [
            'bestvideo[ext=mp4][vcodec^=avc1][filesize<=44M]+bestaudio[ext=m4a]',
            'bestvideo[ext=mp4][vcodec^=avc1][filesize_approx<=44M]+bestaudio[ext=m4a]',
            'bestvideo[ext=mp4][filesize<=44M]+bestaudio[ext=m4a]',
            'bv*[filesize<=44M]+ba[filesize<=6M]',
            'bv*[filesize_approx<=44M]+ba[filesize_approx<=6M]',
            'b[filesize<=50M]',
            'bestvideo[height<=720]+bestaudio',
            'best[height<=720]',
            'best'
        ].join('/');

        const dlpOptions: any = {
            format: formatString,
            output: outputTemplate,
            noWarnings: true,
            quiet: true,
            noPlaylist: true,      // Security: never download entire multi-gigabyte playlists
            maxFilesize: '50M',    // Security: reject streams larger than 50MB
            socketTimeout: 30      // Security: prevent hanging connections
        };

        if (ffmpegPath) {
            dlpOptions.ffmpegLocation = ffmpegPath;
            dlpOptions.mergeOutputFormat = 'mp4';
        }

        // Enforce 75s process timeout
        await withTimeout(ytDlp(safeUrl, dlpOptions), 75000);

        // Find the downloaded file (ignore temporary .part or .ytdl files)
        const files = fs.readdirSync(DOWNLOAD_DIR);
        const downloadedFile = files.find(f => 
            f.startsWith(timestamp.toString()) && 
            !f.endsWith('.part') && 
            !f.endsWith('.ytdl')
        );
        
        if (downloadedFile) {
            const filePath = path.join(DOWNLOAD_DIR, downloadedFile);
            logger.success('DOWNLOADER', `Download succeeded: ${downloadedFile}`);
            return filePath;
        }
        logger.warn('DOWNLOADER', `File not found in download directory after yt-dlp run for: ${safeUrl}`);
        return null;
    } catch (error: any) {
        // Clean up partial files for this timestamp on error
        try {
            const files = fs.readdirSync(DOWNLOAD_DIR);
            for (const f of files) {
                if (f.startsWith(timestamp.toString())) {
                    fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
                }
            }
        } catch (e) {}
        logger.error('DOWNLOADER', `Download failed for: ${safeUrl}`, error);
        throw error;
    }
}

export async function downloadAudio(url: string): Promise<string | null> {
    const check = validateSafeMediaUrl(url);
    if (!check.isValid || !check.sanitizedUrl) {
        logger.warn('DOWNLOADER_SEC', `Rejected unsafe audio URL: ${url} (${check.error})`);
        throw new Error(`Security validation failed: ${check.error}`);
    }

    const safeUrl = check.sanitizedUrl;
    logger.info('DOWNLOADER', `Attempting MP3 audio extraction for URL: ${safeUrl}`);
    const timestamp = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

    try {
        const outputTemplate = path.join(DOWNLOAD_DIR, `${timestamp}_%(id)s.%(ext)s`);

        const dlpOptions: any = {
            format: 'bestaudio/best',
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0',
            output: outputTemplate,
            noWarnings: true,
            quiet: true,
            noPlaylist: true,      // Security: never download entire playlists
            maxFilesize: '50M',    // Security: reject audio streams larger than 50MB
            socketTimeout: 30
        };

        if (ffmpegPath) {
            dlpOptions.ffmpegLocation = ffmpegPath;
        }

        // Enforce 75s process timeout
        await withTimeout(ytDlp(safeUrl, dlpOptions), 75000);

        const files = fs.readdirSync(DOWNLOAD_DIR);
        const downloadedFile = files.find(f => 
            f.startsWith(timestamp.toString()) && 
            (f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.opus') || f.endsWith('.ogg')) &&
            !f.endsWith('.part') && 
            !f.endsWith('.ytdl')
        );

        if (downloadedFile) {
            const filePath = path.join(DOWNLOAD_DIR, downloadedFile);
            logger.success('DOWNLOADER', `Audio extraction succeeded: ${downloadedFile}`);
            return filePath;
        }

        logger.warn('DOWNLOADER', `Audio file not found in download directory after run for: ${safeUrl}`);
        return null;
    } catch (error: any) {
        try {
            const files = fs.readdirSync(DOWNLOAD_DIR);
            for (const f of files) {
                if (f.startsWith(timestamp.toString())) {
                    fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
                }
            }
        } catch (e) {}
        logger.error('DOWNLOADER', `Audio extraction failed for: ${safeUrl}`, error);
        throw error;
    }
}
