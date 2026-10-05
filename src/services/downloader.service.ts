import ytDlp from 'yt-dlp-exec';
import path from 'path';
import fs from 'fs';
import { Readable, Transform } from 'stream';
import { finished } from 'stream/promises';
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

// Standalone yt-dlp binary path for Linux systems (bundles Python 3.10+ runtime)
const LINUX_STANDALONE_BINARY = path.resolve(__dirname, '../../bin/yt-dlp_linux');
let cachedYtDlpInstance: any = null;

export async function getYtDlpRunner(): Promise<any> {
    if (cachedYtDlpInstance) {
        return cachedYtDlpInstance;
    }

    if (process.platform === 'linux') {
        const potentialPaths = [
            LINUX_STANDALONE_BINARY,
            path.resolve(process.cwd(), 'bin/yt-dlp_linux'),
            '/home/container/bin/yt-dlp_linux'
        ];

        for (const binPath of potentialPaths) {
            if (fs.existsSync(binPath)) {
                try {
                    fs.chmodSync(binPath, 0o755);
                    logger.info('DOWNLOADER', `Using standalone Linux yt-dlp binary: ${binPath}`);
                    cachedYtDlpInstance = (ytDlp as any).create(binPath);
                    return cachedYtDlpInstance;
                } catch (e: any) {
                    logger.warn('DOWNLOADER', `Failed to set execute permissions on ${binPath}: ${e.message}`);
                }
            }
        }

        // If not found, attempt to auto-download standalone Linux binary
        try {
            const binDir = path.dirname(LINUX_STANDALONE_BINARY);
            if (!fs.existsSync(binDir)) {
                fs.mkdirSync(binDir, { recursive: true });
            }
            logger.info('DOWNLOADER', 'Downloading standalone Linux yt-dlp binary (with bundled Python 3.10+)...');
            const dlRes = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux');
            if (dlRes.ok && dlRes.body) {
                const out = fs.createWriteStream(LINUX_STANDALONE_BINARY);
                await finished(Readable.fromWeb(dlRes.body as any).pipe(out));
                fs.chmodSync(LINUX_STANDALONE_BINARY, 0o755);
                logger.info('DOWNLOADER', `Standalone Linux yt-dlp binary ready at: ${LINUX_STANDALONE_BINARY}`);
                cachedYtDlpInstance = (ytDlp as any).create(LINUX_STANDALONE_BINARY);
                return cachedYtDlpInstance;
            }
        } catch (dlErr: any) {
            logger.warn('DOWNLOADER', `Auto-download of standalone Linux yt-dlp binary failed: ${dlErr.message}`);
        }
    }

    cachedYtDlpInstance = ytDlp;
    return cachedYtDlpInstance;
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
        return { isValid: false, error: 'Domain not supported. Supported: TikTok, YouTube, Facebook, Instagram, Twitter/X, Threads, Pinterest.' };
    }

    return { isValid: true, sanitizedUrl: parsed.toString() };
}

export function isTikTokOrDouyin(url: string): boolean {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        return host === 'tiktok.com' || host.endsWith('.tiktok.com') ||
               host === 'douyin.com' || host.endsWith('.douyin.com');
    } catch {
        return false;
    }
}

/**
 * Direct high-speed TikTok/Douyin media extractor using TikWM API.
 * Bypasses Python and yt-dlp entirely, delivers watermark-free HD video and direct MP3 audio.
 */
export async function downloadTikTokDirect(safeUrl: string, isVideo: boolean): Promise<string | null> {
    const timestamp = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    try {
        logger.info('DOWNLOADER_TIKTOK', `Requesting TikTok media info from TikWM API for: ${safeUrl}`);
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(safeUrl)}&hd=1`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);

        const response = await fetch(apiUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });
        clearTimeout(timeout);

        if (!response.ok) {
            logger.warn('DOWNLOADER_TIKTOK', `TikWM API returned HTTP ${response.status}`);
            return null;
        }

        const data: any = await response.json();
        if (data.code !== 0 || !data.data) {
            logger.warn('DOWNLOADER_TIKTOK', `TikWM API returned code ${data.code}: ${data.msg || 'No data'}`);
            return null;
        }

        const mediaData = data.data;
        let mediaUrl: string | undefined;
        let ext: string;

        if (isVideo) {
            // Prioritize HD or clean watermark-free video
            mediaUrl = mediaData.hdplay || mediaData.play || mediaData.wmplay;
            ext = 'mp4';
        } else {
            mediaUrl = mediaData.music;
            ext = 'mp3';
        }

        if (!mediaUrl) {
            logger.warn('DOWNLOADER_TIKTOK', `No stream URL found in TikWM response for ${isVideo ? 'video' : 'audio'}`);
            return null;
        }

        // Safeguard: Check size from metadata if available (Telegram 50MB limit)
        if (isVideo && mediaData.size && mediaData.size > 49.5 * 1024 * 1024) {
            throw new Error(`File size ${(mediaData.size / 1024 / 1024).toFixed(1)}MB exceeds Telegram 50MB limit`);
        }

        const targetFilename = `${timestamp}_tiktok_${mediaData.id || 'media'}.${ext}`;
        const targetPath = path.join(DOWNLOAD_DIR, targetFilename);

        const mediaStreamRes = await fetch(mediaUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://www.tiktok.com/'
            }
        });

        if (!mediaStreamRes.ok || !mediaStreamRes.body) {
            logger.warn('DOWNLOADER_TIKTOK', `Failed to stream TikTok media: HTTP ${mediaStreamRes.status}`);
            return null;
        }

        const contentLength = Number(mediaStreamRes.headers.get('content-length') || '0');
        if (contentLength > 49.5 * 1024 * 1024) {
            throw new Error(`File size ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds Telegram 50MB limit`);
        }

        const fileStream = fs.createWriteStream(targetPath);
        let downloadedBytes = 0;
        const maxBytes = 49.5 * 1024 * 1024;

        const sizeLimiter = new Transform({
            transform(chunk, _encoding, callback) {
                downloadedBytes += chunk.length;
                if (downloadedBytes > maxBytes) {
                    callback(new Error(`File size exceeded 50MB limit during download`));
                } else {
                    callback(null, chunk);
                }
            }
        });

        await finished(
            Readable.fromWeb(mediaStreamRes.body as any)
                .pipe(sizeLimiter)
                .pipe(fileStream)
        );

        if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
            // Remux with faststart if it's video and ffmpeg is available so Telegram can stream and play natively
            if (isVideo && ffmpegPath) {
                try {
                    const remuxedPath = targetPath.replace('.mp4', '_fast.mp4');
                    const { execFile } = await import('child_process');
                    const { promisify } = await import('util');
                    const execFileAsync = promisify(execFile);

                    await execFileAsync(ffmpegPath, [
                        '-y',
                        '-i', targetPath,
                        '-map', '0:v:0',
                        '-map', '0:a:0?',
                        '-c', 'copy',
                        '-movflags', '+faststart',
                        remuxedPath
                    ], { timeout: 15000 });

                    if (fs.existsSync(remuxedPath) && fs.statSync(remuxedPath).size > 0) {
                        fs.unlinkSync(targetPath);
                        fs.renameSync(remuxedPath, targetPath);
                        logger.info('DOWNLOADER_TIKTOK', `Remuxed TikTok video with faststart and video stream first`);
                    }
                } catch (remuxErr: any) {
                    logger.warn('DOWNLOADER_TIKTOK', `FFmpeg faststart remux skipped: ${remuxErr.message}`);
                }
            }

            logger.success('DOWNLOADER_TIKTOK', `Successfully downloaded TikTok ${isVideo ? 'video' : 'audio'} via TikWM: ${targetFilename} (${(fs.statSync(targetPath).size / 1024 / 1024).toFixed(2)} MB)`);
            return targetPath;
        }

        return null;
    } catch (err: any) {
        logger.warn('DOWNLOADER_TIKTOK', `Direct TikTok download failed: ${err.message}`);
        try {
            const files = fs.readdirSync(DOWNLOAD_DIR);
            for (const f of files) {
                if (f.startsWith(timestamp)) {
                    fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
                }
            }
        } catch (e) {}

        if (err.message && err.message.includes('exceeds')) {
            throw err;
        }
        return null;
    }
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
            if (file === '.gitkeep') continue;
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

    // Fast-path for TikTok / Douyin
    if (isTikTokOrDouyin(safeUrl)) {
        try {
            const directFile = await downloadTikTokDirect(safeUrl, true);
            if (directFile) {
                return directFile;
            }
            logger.info('DOWNLOADER', `TikWM returned null, falling back to yt-dlp for TikTok URL: ${safeUrl}`);
        } catch (error: any) {
            if (error.message && error.message.includes('exceeds')) {
                throw error;
            }
            logger.warn('DOWNLOADER', `Direct TikTok download error (${error.message}), falling back to yt-dlp`);
        }
    }

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
            socketTimeout: 30,     // Security: prevent hanging connections
            concurrentFragments: 4, // Performance: multi-stream fragment acceleration
            bufferSize: '16K'
        };

        if (ffmpegPath) {
            dlpOptions.ffmpegLocation = ffmpegPath;
            dlpOptions.mergeOutputFormat = 'mp4';
        }

        // Use smart binary runner (supports standalone Linux binary)
        const runner = await getYtDlpRunner();
        await withTimeout(runner(safeUrl, dlpOptions), 75000);

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

    // Fast-path for TikTok / Douyin
    if (isTikTokOrDouyin(safeUrl)) {
        try {
            const directFile = await downloadTikTokDirect(safeUrl, false);
            if (directFile) {
                return directFile;
            }
            logger.info('DOWNLOADER', `TikWM audio returned null, falling back to yt-dlp for TikTok URL: ${safeUrl}`);
        } catch (error: any) {
            if (error.message && error.message.includes('exceeds')) {
                throw error;
            }
            logger.warn('DOWNLOADER', `Direct TikTok audio error (${error.message}), falling back to yt-dlp`);
        }
    }

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
            socketTimeout: 30,
            concurrentFragments: 4, // Performance: multi-stream fragment acceleration
            bufferSize: '16K'
        };

        if (ffmpegPath) {
            dlpOptions.ffmpegLocation = ffmpegPath;
        }

        // Use smart binary runner (supports standalone Linux binary)
        const runner = await getYtDlpRunner();
        await withTimeout(runner(safeUrl, dlpOptions), 75000);

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
