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

export interface DownloadResult {
    filePath: string;
    thumbnailPath?: string;
    title?: string;
    artist?: string;
    duration?: number;
    width?: number;
    height?: number;
}

/**
 * Direct high-speed TikTok/Douyin media extractor using TikWM API.
 * Bypasses Python and yt-dlp entirely, delivers watermark-free HD video and direct MP3 audio
 * with embedded ID3 tags, artist/title metadata, and high-resolution cover artwork.
 */
export async function downloadTikTokDirect(safeUrl: string, isVideo: boolean): Promise<DownloadResult | null> {
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
        let title: string | undefined;
        let artist: string | undefined;
        let coverUrl: string | undefined;

        if (isVideo) {
            mediaUrl = mediaData.hdplay || mediaData.play || mediaData.wmplay;
            ext = 'mp4';
            title = (mediaData.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
            artist = mediaData.author?.nickname || mediaData.author?.unique_id || 'TikTok';
            coverUrl = mediaData.origin_cover || mediaData.cover;
        } else {
            mediaUrl = mediaData.music;
            ext = 'mp3';
            title = (mediaData.music_info?.title || mediaData.title || 'TikTok Audio').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
            artist = mediaData.music_info?.author || mediaData.author?.nickname || 'TikTok';
            coverUrl = mediaData.music_info?.cover || mediaData.origin_cover || mediaData.cover;
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

        if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
            return null;
        }

        let thumbnailPath: string | undefined;

        // Download & convert cover image to standard JPEG if ffmpeg is available
        if (coverUrl && ffmpegPath) {
            try {
                const coverRes = await fetch(coverUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                if (coverRes.ok && coverRes.body) {
                    const rawCoverPath = path.join(DOWNLOAD_DIR, `${timestamp}_raw_cover`);
                    const jpgCoverPath = path.join(DOWNLOAD_DIR, `${timestamp}_thumb.jpg`);
                    const coverOut = fs.createWriteStream(rawCoverPath);
                    await finished(Readable.fromWeb(coverRes.body as any).pipe(coverOut));

                    const { execFile } = await import('child_process');
                    const { promisify } = await import('util');
                    const execFileAsync = promisify(execFile);

                    // Convert to standard JPEG under 200KB (handles WebP/PNG/JPEG effortlessly)
                    await execFileAsync(ffmpegPath, [
                        '-y',
                        '-i', rawCoverPath,
                        '-vf', "scale='min(320,iw)':-2",
                        '-frames:v', '1',
                        '-q:v', '5',
                        jpgCoverPath
                    ], { timeout: 10000 });

                    try { fs.unlinkSync(rawCoverPath); } catch (e) {}

                    if (fs.existsSync(jpgCoverPath) && fs.statSync(jpgCoverPath).size > 0) {
                        thumbnailPath = jpgCoverPath;
                        logger.info('DOWNLOADER_TIKTOK', `Cover artwork converted to JPEG successfully`);
                    }
                }
            } catch (covErr: any) {
                logger.warn('DOWNLOADER_TIKTOK', `Cover download/conversion skipped: ${covErr.message}`);
            }
        }

        // Apply metadata and cover embedding via FFmpeg
        if (ffmpegPath) {
            try {
                const { execFile } = await import('child_process');
                const { promisify } = await import('util');
                const execFileAsync = promisify(execFile);

                if (isVideo) {
                    const remuxedPath = targetPath.replace('.mp4', '_tagged.mp4');
                    const ffmpegArgs = ['-y', '-i', targetPath];

                    if (thumbnailPath) {
                        ffmpegArgs.push('-i', thumbnailPath);
                        ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-map', '1');
                        ffmpegArgs.push('-c:v:0', 'copy', '-c:a', 'copy', '-c:v:1', 'copy');
                        ffmpegArgs.push('-disposition:v:1', 'attached_pic');
                    } else {
                        ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0?');
                        ffmpegArgs.push('-c', 'copy');
                    }

                    ffmpegArgs.push('-movflags', '+faststart');
                    if (title) ffmpegArgs.push('-metadata', `title=${title}`);
                    if (artist) ffmpegArgs.push('-metadata', `artist=${artist}`);
                    ffmpegArgs.push(remuxedPath);

                    await execFileAsync(ffmpegPath, ffmpegArgs, { timeout: 20000 });

                    if (fs.existsSync(remuxedPath) && fs.statSync(remuxedPath).size > 0) {
                        fs.unlinkSync(targetPath);
                        fs.renameSync(remuxedPath, targetPath);
                        logger.info('DOWNLOADER_TIKTOK', `Embedded metadata & cover into MP4 successfully`);
                    }
                } else {
                    // Audio: embed ID3v2 tag and album cover
                    const taggedPath = targetPath.replace('.mp3', '_tagged.mp3');
                    const ffmpegArgs = ['-y', '-i', targetPath];

                    if (thumbnailPath) {
                        ffmpegArgs.push('-i', thumbnailPath);
                        ffmpegArgs.push('-map', '0:a', '-map', '1:0');
                        ffmpegArgs.push('-c', 'copy');
                        ffmpegArgs.push('-id3v2_version', '3');
                        ffmpegArgs.push('-metadata:s:v', 'title=Album cover');
                        ffmpegArgs.push('-metadata:s:v', 'comment=Cover (front)');
                    } else {
                        ffmpegArgs.push('-c', 'copy', '-id3v2_version', '3');
                    }

                    if (title) ffmpegArgs.push('-metadata', `title=${title}`);
                    if (artist) ffmpegArgs.push('-metadata', `artist=${artist}`);
                    ffmpegArgs.push('-metadata', 'album=TikTok Audio');
                    ffmpegArgs.push(taggedPath);

                    await execFileAsync(ffmpegPath, ffmpegArgs, { timeout: 15000 });

                    if (fs.existsSync(taggedPath) && fs.statSync(taggedPath).size > 0) {
                        fs.unlinkSync(targetPath);
                        fs.renameSync(taggedPath, targetPath);
                        logger.info('DOWNLOADER_TIKTOK', `Embedded ID3v2 metadata & album cover into MP3 successfully`);
                    }
                }
            } catch (remuxErr: any) {
                logger.warn('DOWNLOADER_TIKTOK', `FFmpeg metadata tagging skipped: ${remuxErr.message}`);
            }
        }

        logger.success('DOWNLOADER_TIKTOK', `Successfully downloaded & tagged TikTok ${isVideo ? 'video' : 'audio'}: ${targetFilename} (${(fs.statSync(targetPath).size / 1024 / 1024).toFixed(2)} MB)`);

        return {
            filePath: targetPath,
            thumbnailPath,
            title,
            artist,
            duration: mediaData.duration || 0
        };
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

export async function downloadMedia(url: string): Promise<DownloadResult | null> {
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
            dlpOptions.embedMetadata = true;
            dlpOptions.embedThumbnail = true;
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
            return { filePath };
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

export async function downloadAudio(url: string): Promise<DownloadResult | null> {
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
            dlpOptions.embedMetadata = true;
            dlpOptions.embedThumbnail = true;
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
            return { filePath };
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
