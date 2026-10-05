import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from '../config';
import { logger } from '../utils/logger';

// Guarantee global WebSocket availability across any Node.js environment
if (typeof (globalThis as any).WebSocket === 'undefined') {
    (globalThis as any).WebSocket = WebSocket;
}

const supabaseUrl = (config.SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const supabaseKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY || 
    config.SUPABASE_KEY || 
    process.env.SUPABASE_KEY || 
    ''
).trim();

export const isSupabaseConfigured = (): boolean => {
    return !!(supabaseUrl && supabaseKey);
};

export const supabase: SupabaseClient | null = isSupabaseConfigured()
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
        realtime: {
            transport: WebSocket as any,
        }
    })
    : null;

/**
 * Ping Supabase to test connectivity and measure latency
 */
export async function pingSupabase(): Promise<{ connected: boolean; latencyMs: number; error?: string }> {
    if (!supabase) {
        return { connected: false, latencyMs: 0, error: 'Supabase credentials not configured' };
    }

    const start = Date.now();
    try {
        const { error } = await supabase
            .from('bot_settings')
            .select('key')
            .limit(1);

        const latencyMs = Date.now() - start;
        if (error) {
            return { connected: false, latencyMs, error: error.message };
        }
        return { connected: true, latencyMs };
    } catch (err: any) {
        return { connected: false, latencyMs: Date.now() - start, error: err.message };
    }
}

/**
 * Sync active user to Supabase `subscribers` and `user_prefs` tables.
 * Executes non-blockingly with silent error catch.
 */
export async function syncUserToSupabase(user: {
    id: number;
    username?: string;
    firstName?: string;
    language?: string;
}): Promise<void> {
    if (!supabase || !user.id) return;

    try {
        const now = new Date().toISOString();

        // 1 & 2. Upsert into subscribers and user_prefs tables concurrently
        await Promise.all([
            supabase
                .from('subscribers')
                .upsert({
                    chat_id: user.id,
                    created_at: now
                }, { onConflict: 'chat_id' }),
            supabase
                .from('user_prefs')
                .upsert({
                    user_id: user.id,
                    username: user.username || null,
                    first_name: user.firstName || null,
                    last_active: now,
                    updated_at: now
                }, { onConflict: 'user_id' })
        ]);

        logger.debug('SUPABASE', `Synced user ${user.id} (@${user.username || 'unknown'}) to Supabase`);
    } catch (err: any) {
        logger.warn('SUPABASE', `Failed to sync user ${user.id} to Supabase: ${err.message}`);
    }
}

export interface SupabaseRegisteredUser {
    userId: number;
    username?: string;
    firstName?: string;
    createdAt?: string;
    lastActive?: string;
    source: 'supabase' | 'redis' | 'both';
}

/**
 * Retrieve total number of registered users in Supabase
 */
export async function getSupabaseSubscribersCount(): Promise<number> {
    if (!supabase) return 0;
    try {
        const { count, error } = await supabase
            .from('subscribers')
            .select('*', { count: 'exact', head: true });

        if (!error && typeof count === 'number') {
            return count;
        }

        const { count: prefCount } = await supabase
            .from('user_prefs')
            .select('*', { count: 'exact', head: true });

        return prefCount || 0;
    } catch (e) {
        return 0;
    }
}

/**
 * Fetch all registered users from Supabase subscribers & user_prefs tables
 */
export async function fetchAllSupabaseUsers(): Promise<SupabaseRegisteredUser[]> {
    if (!supabase) return [];
    try {
        const [subRes, prefRes] = await Promise.all([
            supabase
                .from('subscribers')
                .select('chat_id, created_at')
                .order('created_at', { ascending: false }),
            supabase
                .from('user_prefs')
                .select('user_id, username, first_name, last_active, created_at')
        ]);

        const userMap = new Map<number, SupabaseRegisteredUser>();

        if (subRes.data && Array.isArray(subRes.data)) {
            for (const item of subRes.data) {
                const id = Number(item.chat_id);
                if (Number.isSafeInteger(id) && id > 0) {
                    userMap.set(id, {
                        userId: id,
                        createdAt: item.created_at,
                        source: 'supabase'
                    });
                }
            }
        }

        if (prefRes.data && Array.isArray(prefRes.data)) {
            for (const item of prefRes.data) {
                const id = Number(item.user_id);
                if (Number.isSafeInteger(id) && id > 0) {
                    const existing = userMap.get(id);
                    if (existing) {
                        existing.username = item.username || existing.username;
                        existing.firstName = item.first_name || existing.firstName;
                        existing.lastActive = item.last_active;
                        if (!existing.createdAt && item.created_at) {
                            existing.createdAt = item.created_at;
                        }
                    } else {
                        userMap.set(id, {
                            userId: id,
                            username: item.username,
                            firstName: item.first_name,
                            createdAt: item.created_at,
                            lastActive: item.last_active,
                            source: 'supabase'
                        });
                    }
                }
            }
        }

        return Array.from(userMap.values());
    } catch (e: any) {
        logger.error('SUPABASE', 'Failed to fetch all users from Supabase', e);
        return [];
    }
}

/**
 * Fetch all registered subscriber/user IDs from Supabase across user_prefs and subscribers
 */
export async function getAllSupabaseSubscriberIds(): Promise<number[]> {
    if (!supabase) return [];
    try {
        const [prefsRes, subsRes] = await Promise.all([
            supabase.from('user_prefs').select('user_id'),
            supabase.from('subscribers').select('chat_id')
        ]);

        const ids = new Set<number>();
        (prefsRes.data || []).forEach(r => {
            const id = Number(r.user_id);
            if (Number.isSafeInteger(id) && id > 0) ids.add(id);
        });
        (subsRes.data || []).forEach(r => {
            const id = Number(r.chat_id);
            if (Number.isSafeInteger(id) && id > 0) ids.add(id);
        });

        return Array.from(ids);
    } catch (e) {
        return [];
    }
}

export interface SupabaseSummary {
    totalUsers: number;
    totalConversations: number;
    totalDonations: number;
    recentUsers: Array<{
        userId: number;
        username?: string;
        firstName?: string;
        lastActive?: string;
    }>;
    recentDonations: Array<{
        id: number;
        fullName?: string;
        amount: number;
        currency: string;
        status: string;
        createdAt: string;
    }>;
}

/**
 * Fetch comprehensive telemetry & statistics summary from Supabase Cloud
 */
export async function fetchSupabaseSummary(): Promise<SupabaseSummary | null> {
    if (!supabase) return null;
    try {
        const [usersRes, convRes, donRes, recentUsersRes, recentDonRes] = await Promise.all([
            supabase.from('user_prefs').select('*', { count: 'exact', head: true }),
            supabase.from('conversation_history').select('*', { count: 'exact', head: true }),
            supabase.from('donations').select('*', { count: 'exact', head: true }),
            supabase.from('user_prefs').select('user_id, username, first_name, last_active').order('last_active', { ascending: false, nullsFirst: false }).limit(5),
            supabase.from('donations').select('id, full_name, amount, currency, status, created_at').order('created_at', { ascending: false }).limit(3)
        ]);

        return {
            totalUsers: usersRes.count || 0,
            totalConversations: convRes.count || 0,
            totalDonations: donRes.count || 0,
            recentUsers: (recentUsersRes.data || []).map(u => ({
                userId: u.user_id,
                username: u.username,
                firstName: u.first_name,
                lastActive: u.last_active
            })),
            recentDonations: (recentDonRes.data || []).map(d => ({
                id: d.id,
                fullName: d.full_name,
                amount: d.amount,
                currency: d.currency,
                status: d.status,
                createdAt: d.created_at
            }))
        };
    } catch (e) {
        logger.error('SUPABASE', 'Failed to fetch summary from Supabase', e);
        return null;
    }
}

/**
 * Persist conversation message into Supabase `conversation_history`
 */
export async function saveConversationToSupabase(
    userId: number,
    role: 'user' | 'assistant',
    content: string
): Promise<void> {
    if (!supabase || !userId || !content) return;
    try {
        await supabase
            .from('conversation_history')
            .insert({
                user_id: userId,
                role,
                content: content.substring(0, 4000),
                created_at: new Date().toISOString()
            });
    } catch (err: any) {
        logger.debug('SUPABASE', `Failed to save conversation history: ${err.message}`);
    }
}

/**
 * Read setting value from Supabase `bot_settings`
 */
export async function getSupabaseSetting(key: string, fallback = ''): Promise<string> {
    if (!supabase) return fallback;
    try {
        const { data, error } = await supabase
            .from('bot_settings')
            .select('value')
            .eq('key', key)
            .maybeSingle();

        if (error || !data) return fallback;
        return data.value || fallback;
    } catch (e) {
        return fallback;
    }
}

/**
 * Write setting value to Supabase `bot_settings`
 */
export async function setSupabaseSetting(key: string, value: string, updatedBy?: number): Promise<boolean> {
    if (!supabase) return false;
    try {
        const { error } = await supabase
            .from('bot_settings')
            .upsert({
                key,
                value,
                updated_by: updatedBy || null,
                updated_at: new Date().toISOString()
            }, { onConflict: 'key' });

        return !error;
    } catch (e) {
        return false;
    }
}

/**
 * Update user preferences in Supabase `user_prefs` table
 */
export async function updateUserPrefsInSupabase(userId: number, updates: {
    gender?: string;
    speed?: number;
    tts_model?: string;
}): Promise<void> {
    if (!supabase || !userId) return;
    try {
        await supabase
            .from('user_prefs')
            .upsert({
                user_id: userId,
                ...updates,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });
    } catch (err: any) {
        logger.debug('SUPABASE', `Failed to update user_prefs: ${err.message}`);
    }
}

export interface SupabaseConversationItem {
    id: number;
    userId: number;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
}

/**
 * Fetch recent conversations from Supabase
 */
export async function fetchRecentConversations(limit = 8, userId?: number): Promise<SupabaseConversationItem[]> {
    if (!supabase) return [];
    try {
        let query = supabase
            .from('conversation_history')
            .select('id, user_id, role, content, created_at')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (userId) {
            query = query.eq('user_id', userId);
        }

        const { data, error } = await query;
        if (error || !data) return [];

        return data.map(r => ({
            id: r.id,
            userId: r.user_id,
            role: r.role,
            content: r.content,
            createdAt: r.created_at
        }));
    } catch (e) {
        return [];
    }
}

export interface SupabaseUserProfile {
    userId: number;
    username?: string;
    firstName?: string;
    gender?: string;
    speed?: number;
    ttsModel?: string;
    lastActive?: string;
    createdAt?: string;
    updatedAt?: string;
    isSubscriber: boolean;
    dialogueCount: number;
    donationCount: number;
    totalDonated: number;
}

/**
 * Fetch comprehensive user profile from Supabase
 */
export async function fetchUserFullProfile(userId: number): Promise<SupabaseUserProfile | null> {
    if (!supabase || !userId) return null;
    try {
        const [prefsRes, subRes, convRes, donRes] = await Promise.all([
            supabase.from('user_prefs').select('*').eq('user_id', userId).maybeSingle(),
            supabase.from('subscribers').select('chat_id').eq('chat_id', userId).maybeSingle(),
            supabase.from('conversation_history').select('*', { count: 'exact', head: true }).eq('user_id', userId),
            supabase.from('donations').select('amount, status').eq('user_id', userId)
        ]);

        const pref = prefsRes.data;
        if (!pref && !subRes.data && (convRes.count || 0) === 0) {
            return null;
        }

        const donations = donRes.data || [];
        const completedDons = donations.filter(d => d.status === 'completed');
        const totalDonated = completedDons.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

        return {
            userId,
            username: pref?.username,
            firstName: pref?.first_name,
            gender: pref?.gender,
            speed: pref?.speed,
            ttsModel: pref?.tts_model,
            lastActive: pref?.last_active,
            createdAt: pref?.created_at,
            updatedAt: pref?.updated_at,
            isSubscriber: !!subRes.data,
            dialogueCount: convRes.count || 0,
            donationCount: completedDons.length,
            totalDonated: Math.round(totalDonated * 100) / 100
        };
    } catch (e) {
        logger.error('SUPABASE', `Failed to fetch profile for user ${userId}`, e);
        return null;
    }
}

export interface SupabaseDonationItem {
    id: number;
    userId: number;
    username?: string;
    fullName?: string;
    amount: number;
    currency: string;
    tier: string;
    note?: string;
    status: string;
    createdAt: string;
    cups?: number;
}

/**
 * Fetch detailed donations analytics and records from Supabase
 */
export async function fetchDonationsAnalytics(): Promise<{
    totalRevenue: number;
    completedCount: number;
    pendingCount: number;
    donations: SupabaseDonationItem[];
} | null> {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('donations')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error || !data) return null;

        let totalRevenue = 0;
        let completedCount = 0;
        let pendingCount = 0;

        const list: SupabaseDonationItem[] = data.map(d => {
            const amount = Number(d.amount) || 0;
            if (d.status === 'completed') {
                totalRevenue += amount;
                completedCount++;
            } else {
                pendingCount++;
            }
            return {
                id: d.id,
                userId: d.user_id,
                username: d.username,
                fullName: d.full_name,
                amount,
                currency: d.currency || 'USD',
                tier: d.tier || 'coffee',
                note: d.note,
                status: d.status,
                createdAt: d.created_at,
                cups: d.cups
            };
        });

        return {
            totalRevenue: Math.round(totalRevenue * 100) / 100,
            completedCount,
            pendingCount,
            donations: list
        };
    } catch (e) {
        return null;
    }
}
