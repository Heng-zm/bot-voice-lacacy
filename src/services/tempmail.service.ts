import { logger } from '../utils/logger';
import { redisGet, redisSet, redisDel, redisKeys } from './redis.service';

const API_BASE = 'https://api.mail.tm';

export interface TempMailAccount {
    address: string;
    token: string;
    id: string;
    password: string;
    createdAt: number;
    lastActive: number;
    seenMessageIds: Set<string>;
}

export interface MailMessageSummary {
    id: string;
    from: { address: string; name: string };
    subject: string;
    intro?: string;
    createdAt: string;
}

export interface MailMessageDetail {
    id: string;
    from: { address: string; name: string };
    to: { address: string; name: string }[];
    subject: string;
    intro?: string;
    text?: string;
    html?: string[];
    createdAt: string;
}

const ACCOUNT_TTL_SECONDS = 24 * 3600;
const userAccounts = new Map<number, TempMailAccount>();
const inFlightMessages = new Set<string>();

function serializeAccount(account: TempMailAccount) {
    return {
        address: account.address,
        id: account.id,
        token: account.token,
        password: account.password,
        createdAt: account.createdAt,
        lastActive: account.lastActive,
        seenMessageIds: Array.from(account.seenMessageIds).slice(-500)
    };
}

function persistAccount(userId: number, account: TempMailAccount): Promise<boolean> {
    return redisSet(`tempmail:account:${userId}`, serializeAccount(account), ACCOUNT_TTL_SECONDS);
}

function restoreAccount(userId: number, cached: any): TempMailAccount | null {
    if (!cached?.token || !cached?.id || !cached?.address || !cached?.password) return null;
    const account: TempMailAccount = {
        address: cached.address,
        id: cached.id,
        token: cached.token,
        password: cached.password,
        createdAt: cached.createdAt || Date.now(),
        lastActive: cached.lastActive || Date.now(),
        seenMessageIds: new Set<string>(Array.isArray(cached.seenMessageIds) ? cached.seenMessageIds : [])
    };
    userAccounts.set(userId, account);
    return account;
}

// In-memory cache for user temp accounts


export function extractOtp(subject = '', body = ''): string | null {
    const combined = `${subject} ${body}`;
    
    // Pattern 1: explicitly labeled codes (e.g. "code is 123456", "OTP: 123456", "verification code: 123456", "PIN: 1234")
    const labeledMatch = combined.match(/(?:code|otp|verification|pin|password|token|security code)[\s:=is#-]+([0-9]{4,8})\b/i);
    if (labeledMatch && labeledMatch[1]) {
        return labeledMatch[1];
    }

    // Pattern 2: 4 to 8 consecutive digits in text that mentions verify or confirm
    if (/verify|verification|confirm|security|authenticate|code/i.test(combined)) {
        const digitMatch = combined.match(/\b([0-9]{4,8})\b/);
        if (digitMatch && digitMatch[1]) {
            return digitMatch[1];
        }
    }

    return null;
}

export function extractActionLinks(htmlOrText = ''): { label: string; url: string }[] {
    const links: { label: string; url: string }[] = [];
    if (!htmlOrText) return links;

    // Pattern 1: Match <a> tags in HTML
    const aTagRegex = /<a\s+(?:[^>]*?\s+)?href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = aTagRegex.exec(htmlOrText)) !== null) {
        const url = match[1];
        const rawText = match[2].replace(/<[^>]*>/g, '').trim();
        if (/confirm|verify|activate|validate|login|button|click|here|link|join/i.test(rawText) || /verify|confirm|activate|token|auth/i.test(url)) {
            const label = rawText.length > 0 && rawText.length <= 28 ? rawText : 'Verify / Confirm';
            if (!links.some(l => l.url === url)) {
                links.push({ label, url });
            }
        }
    }

    // Pattern 2: Standalone verification URLs
    if (links.length === 0) {
        const urlRegex = /(https?:\/\/[^\s<>'"]+(?:verify|confirm|activate|token|validation|auth)[^\s<>'"]*)/gi;
        let urlMatch: RegExpExecArray | null;
        while ((urlMatch = urlRegex.exec(htmlOrText)) !== null) {
            const url = urlMatch[1];
            if (!links.some(l => l.url === url)) {
                links.push({ label: 'Open Confirmation Link', url });
            }
        }
    }

    return links.slice(0, 3);
}

async function getAvailableDomain(): Promise<string> {
    const res = await fetch(`${API_BASE}/domains`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`Failed to fetch domains: ${res.statusText}`);
    const data: any = await res.json();
    const domains = data['hydra:member'];
    if (!domains || domains.length === 0) {
        throw new Error('No available domains found from Mail.tm');
    }
    const active = domains.find((d: any) => d.isActive);
    return active ? active.domain : domains[0].domain;
}

export async function createTempAccount(userId: number): Promise<TempMailAccount> {
    const domain = await getAvailableDomain();
    const randomAlnum = Math.random().toString(36).replace(/[^a-z0-9]/g, '').substring(0, 6);
    const suffix = Date.now().toString().slice(-4);
    const address = `user${randomAlnum}${suffix}@${domain}`.toLowerCase();
    const password = `TmpPass${randomAlnum}1!`;

    // 1. Create Account
    const createRes = await fetch(`${API_BASE}/accounts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify({ address, password })
    });

    if (!createRes.ok) {
        const errJson: any = await createRes.json().catch(() => ({}));
        throw new Error(`Failed to create temp mail account: ${errJson['hydra:description'] || createRes.statusText}`);
    }

    const accountData: any = await createRes.json();

    // 2. Obtain Token
    const tokenRes = await fetch(`${API_BASE}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify({ address, password })
    });

    if (!tokenRes.ok) {
        throw new Error(`Failed to retrieve token: ${tokenRes.statusText}`);
    }

    const tokenData: any = await tokenRes.json();

    const account: TempMailAccount = {
        address: accountData.address,
        id: accountData.id,
        token: tokenData.token,
        password,
        createdAt: Date.now(),
        lastActive: Date.now(),
        seenMessageIds: new Set<string>()
    };

    userAccounts.set(userId, account);
    await persistAccount(userId, account);
    return account;
}

async function restoreAccountFromRedis(userId: number): Promise<TempMailAccount | null> {
    const cached = await redisGet<any>(`tempmail:account:${userId}`);
    return cached ? restoreAccount(userId, cached) : null;
}

export async function restoreTempAccounts(): Promise<void> {
    const keys = await redisKeys('tempmail:account:*');
    await Promise.all(keys.map(async (key) => {
        const idPart = key.slice('tempmail:account:'.length);
        const userId = Number(idPart);
        if (!Number.isSafeInteger(userId) || userId <= 0) return;
        await restoreAccountFromRedis(userId);
    }));
}

async function refreshAccountToken(account: TempMailAccount): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(`${API_BASE}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({ address: account.address, password: account.password }),
            signal: controller.signal
        });
        if (!response.ok) return false;
        const data: any = await response.json();
        if (typeof data.token !== 'string' || !data.token) return false;
        account.token = data.token;
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchAccountMessages(userId: number, account: TempMailAccount): Promise<MailMessageSummary[]> {
    const request = async () => fetch(`${API_BASE}/messages`, {
        headers: { 'Authorization': `Bearer ${account.token}`, 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
    });
    let res = await request();
    if (res.status === 401 && await refreshAccountToken(account)) {
        await persistAccount(userId, account);
        res = await request();
    }
    if (res.status === 401) {
        userAccounts.delete(userId);
        await redisDel(`tempmail:account:${userId}`);
        throw new Error('Temporary mailbox credentials expired; create a new mailbox.');
    }
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.statusText}`);
    const data: any = await res.json();
    return data['hydra:member'] || [];
}

export async function getOrCreateTempAccount(userId: number): Promise<TempMailAccount> {
    const existing = userAccounts.get(userId);
    if (existing) {
        existing.lastActive = Date.now();
        return existing;
    }

    const restored = await restoreAccountFromRedis(userId);
    if (restored) {
        restored.lastActive = Date.now();
        return restored;
    }

    return createTempAccount(userId);
}

export async function getTempAccount(userId: number): Promise<TempMailAccount | null> {
    const existing = userAccounts.get(userId);
    if (existing) return existing;
    return restoreAccountFromRedis(userId);
}

export async function fetchInboxMessages(userId: number): Promise<MailMessageSummary[]> {
    const account = await getOrCreateTempAccount(userId);
    const messages = await fetchAccountMessages(userId, account);
    account.lastActive = Date.now();
    for (const message of messages) account.seenMessageIds.add(message.id);
    await persistAccount(userId, account);
    return messages;
}

export async function fetchMessageDetail(userId: number, messageId: string): Promise<MailMessageDetail> {
    const account = await getOrCreateTempAccount(userId);
    const res = await fetch(`${API_BASE}/messages/${messageId}`, {
        headers: {
            'Authorization': `Bearer ${account.token}`,
            'User-Agent': 'Mozilla/5.0'
        },
        signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch message details: ${res.statusText}`);
    }

    return res.json() as Promise<MailMessageDetail>;
}

export async function deleteTempAccount(userId: number): Promise<void> {
    const account = userAccounts.get(userId);
    if (account) {
        try {
            await fetch(`${API_BASE}/accounts/${account.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${account.token}`, 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(8000)
            });
        } catch (err) {
            logger.warn('TEMPMAIL', `Failed to delete account ${account.address} on server`, err);
        }
    }
    userAccounts.delete(userId);
    await redisDel(`tempmail:account:${userId}`);
}

export async function deleteMessage(userId: number, messageId: string): Promise<boolean> {
    const account = await getOrCreateTempAccount(userId);
    try {
        const res = await fetch(`${API_BASE}/messages/${messageId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${account.token}`,
                'User-Agent': 'Mozilla/5.0'
            },
            signal: AbortSignal.timeout(8000)
        });
        account.seenMessageIds.delete(messageId);
        await persistAccount(userId, account);
        return res.ok;
    } catch (err) {
        logger.warn('TEMPMAIL', `Failed to delete message ${messageId}`, err);
        return false;
    }
}

// ==========================================
// REAL-TIME AUTO WATCHER
// ==========================================

type NewEmailCallback = (userId: number, account: TempMailAccount, detail: MailMessageDetail, otp: string | null) => Promise<void>;

let watcherRunning = false;
let watcherCallback: NewEmailCallback | null = null;
let pollInProgress = false;

export function registerRealtimeMailListener(callback: NewEmailCallback) {
    watcherCallback = callback;
    if (!watcherRunning) {
        watcherRunning = true;
        logger.success('TEMPMAIL', 'Realtime mail watcher started (polling every 4s)');
        restoreTempAccounts().catch((err) => logger.warn('TEMPMAIL', 'Failed to restore accounts from Redis', err));
        startRealtimePollLoop();
    }
}

async function startRealtimePollLoop() {
    setInterval(async () => {
        if (pollInProgress || !watcherCallback || userAccounts.size === 0) return;
        pollInProgress = true;
        try {
        const now = Date.now();
        const INACTIVE_LIMIT = 10 * 60 * 1000; // 10 minutes active polling window

        // 1. Prune accounts inactive for > 10 minutes from continuous polling
        for (const [userId, account] of userAccounts.entries()) {
            if (now - account.lastActive > INACTIVE_LIMIT) {
                userAccounts.delete(userId);
                logger.info('TEMPMAIL', `Paused active background polling for inactive account ${account.address} (user ${userId})`);
            }
        }

        if (userAccounts.size === 0) return;

        // 2. Poll mailboxes in staggered chunks of 3 to avoid Mail.tm rate limits when 10+ users are active
        const entries = Array.from(userAccounts.entries());
        const CHUNK_SIZE = 3;
        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
            const chunk = entries.slice(i, i + CHUNK_SIZE);
            const pollTasks = chunk.map(async ([userId, account]) => {
                try {
                    const messages = await fetchAccountMessages(userId, account);
                    account.lastActive = Date.now();

                    for (const msg of messages) {
                        const messageKey = `${userId}:${msg.id}`;
                        if (account.seenMessageIds.has(msg.id) || inFlightMessages.has(messageKey)) continue;
                        inFlightMessages.add(messageKey);
                        try {
                            const detail = await fetchMessageDetail(userId, msg.id);
                            const body = detail.text || detail.intro || '';
                            const otp = extractOtp(detail.subject, body);
                            logger.info('TEMPMAIL', `New email received for ${account.address} (OTP: ${otp || 'None'})`, {
                                from: detail.from?.address,
                                subject: detail.subject
                            });

                            if (watcherCallback) await watcherCallback(userId, account, detail, otp);
                            account.seenMessageIds.add(msg.id);
                        } catch (detailErr) {
                            logger.error('TEMPMAIL', `Error processing new mail ${msg.id}`, detailErr, { userId });
                        } finally {
                            inFlightMessages.delete(messageKey);
                        }
                    }
                    await persistAccount(userId, account);
                } catch (pollErr) {
                    // Ignore transient network blips or timeouts
                }
            });

            await Promise.allSettled(pollTasks);
            if (i + CHUNK_SIZE < entries.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        } finally {
            pollInProgress = false;
        }
    }, 4000); // Check every 4 seconds for instant real-time response!
}
