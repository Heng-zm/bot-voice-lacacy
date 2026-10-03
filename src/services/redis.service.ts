import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;
let isConnected = false;

if (config.REDIS_URL) {
    try {
        const isTls = config.REDIS_URL.startsWith('rediss://');
        redisClient = new Redis(config.REDIS_URL, {
            tls: isTls ? { rejectUnauthorized: false } : undefined,
            maxRetriesPerRequest: 5,
            enableAutoPipelining: true,
            connectTimeout: 10000,
            keepAlive: 30000,
            retryStrategy(times) {
                const delay = Math.min(times * 150, 3000);
                return delay;
            },
            reconnectOnError(err) {
                const targetError = 'READONLY';
                if (err.message.includes(targetError)) {
                    return true;
                }
                return false;
            },
            lazyConnect: false,
        });

        redisClient.on('connect', () => {
            logger.info('REDIS', 'Connected to Redis server');
        });

        redisClient.on('ready', () => {
            isConnected = true;
            logger.success('REDIS', 'Redis client ready for commands');
        });

        redisClient.on('error', (err: any) => {
            isConnected = false;
            logger.error('REDIS', 'Redis connection error', err);
        });

        redisClient.on('close', () => {
            isConnected = false;
            logger.warn('REDIS', 'Redis connection closed');
        });

        redisClient.on('reconnecting', (ms: number) => {
            logger.info('REDIS', `Reconnecting to Redis in ${ms}ms...`);
        });
    } catch (e: any) {
        logger.error('REDIS', 'Failed to initialize Redis client', e);
        redisClient = null;
        isConnected = false;
    }
} else {
    logger.warn('REDIS', 'REDIS_URL is not set in environment.');
}

export function getRedisClient(): Redis | null {
    return redisClient;
}

export function isRedisConnected(): boolean {
    return isConnected && redisClient !== null;
}

export async function pingRedis(): Promise<{ connected: boolean; latencyMs?: number; error?: string }> {
    if (!redisClient || !isConnected) {
        return { connected: false, error: 'Redis client not connected' };
    }
    const start = Date.now();
    try {
        const pong = await redisClient.ping();
        const latencyMs = Date.now() - start;
        return { connected: pong === 'PONG', latencyMs };
    } catch (err: any) {
        return { connected: false, error: err.message };
    }
}

export async function redisGet<T>(key: string): Promise<T | null> {
    if (!redisClient || !isConnected) return null;
    try {
        const raw = await redisClient.get(key);
        if (raw === null || raw === undefined) return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            return raw as unknown as T;
        }
    } catch (err) {
        logger.error('REDIS', `redisGet failed for key: ${key}`, err);
        return null;
    }
}

export async function redisGetRaw(key: string): Promise<string | null> {
    if (!redisClient || !isConnected) return null;
    try {
        return await redisClient.get(key);
    } catch (err) {
        logger.error('REDIS', `redisGetRaw failed for key: ${key}`, err);
        return null;
    }
}

export async function redisKeys(pattern: string): Promise<string[]> {
    if (!redisClient || !isConnected) return [];
    try {
        const keys: string[] = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = nextCursor;
            keys.push(...batch);
        } while (cursor !== '0');
        return keys;
    } catch (err) {
        logger.error('REDIS', `redisKeys failed for pattern: ${pattern}`, err);
        return [];
    }
}

export async function redisSet(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
    if (!redisClient || !isConnected) return false;
    try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (ttlSeconds && ttlSeconds > 0) {
            await redisClient.set(key, serialized, 'EX', ttlSeconds);
        } else {
            await redisClient.set(key, serialized);
        }
        return true;
    } catch (err) {
        logger.error('REDIS', `redisSet failed for key: ${key}`, err);
        return false;
    }
}

export async function redisDel(key: string): Promise<boolean> {
    if (!redisClient || !isConnected) return false;
    try {
        await redisClient.del(key);
        return true;
    } catch (err) {
        logger.error('REDIS', `redisDel failed for key: ${key}`, err);
        return false;
    }
}

export async function redisIncr(key: string, ttlSeconds?: number): Promise<number | null> {
    if (!redisClient || !isConnected) return null;
    try {
        const count = await redisClient.incr(key);
        if (count === 1 && ttlSeconds && ttlSeconds > 0) {
            await redisClient.expire(key, ttlSeconds);
        }
        return count;
    } catch (err) {
        logger.error('REDIS', `redisIncr failed for key: ${key}`, err);
        return null;
    }
}

export async function redisSAdd(key: string, member: string | number): Promise<boolean> {
    if (!redisClient || !isConnected) return false;
    try {
        await redisClient.sadd(key, String(member));
        return true;
    } catch (err) {
        logger.error('REDIS', `redisSAdd failed for key: ${key}`, err);
        return false;
    }
}

export async function redisSCard(key: string): Promise<number> {
    if (!redisClient || !isConnected) return 0;
    try {
        return await redisClient.scard(key);
    } catch (err) {
        logger.error('REDIS', `redisSCard failed for key: ${key}`, err);
        return 0;
    }
}

export async function redisSMembers(key: string): Promise<string[]> {
    if (!redisClient || !isConnected) return [];
    try {
        return await redisClient.smembers(key);
    } catch (err) {
        logger.error('REDIS', `redisSMembers failed for key: ${key}`, err);
        return [];
    }
}
