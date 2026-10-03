import http from 'http';
import { logger } from '../utils/logger';
import { isRedisConnected } from './redis.service';
import { isSupabaseConfigured } from './supabase.service';

let server: http.Server | null = null;

export function startHealthServer(botUsername?: string): http.Server | null {
    const rawPort = process.env.PORT;
    // Default to port 8080 in production or if PORT env var is explicitly provided
    if (!rawPort && process.env.NODE_ENV !== 'production') {
        return null;
    }

    const port = parseInt(rawPort || '8080', 10);
    if (isNaN(port)) {
        logger.warn('HEALTH', `Invalid PORT specified: ${rawPort}. Health server not started.`);
        return null;
    }

    server = http.createServer((req, res) => {
        const url = req.url || '/';

        if (url === '/health' || url === '/') {
            const memory = process.memoryUsage();
            const payload = {
                status: 'ok',
                service: 'telegram-bot-production',
                bot: botUsername ? `@${botUsername}` : 'active',
                uptimeSeconds: Math.floor(process.uptime()),
                timestamp: new Date().toISOString(),
                memoryMB: {
                    rss: Math.round(memory.rss / 1024 / 1024),
                    heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(memory.heapTotal / 1024 / 1024)
                },
                services: {
                    redis: isRedisConnected(),
                    supabase: isSupabaseConfigured()
                }
            };

            const jsonResponse = JSON.stringify(payload, null, 2);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(jsonResponse)
            });
            res.end(jsonResponse);
            return;
        }

        if (url === '/ping') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('pong');
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    server.listen(port, '0.0.0.0', () => {
        logger.success('HEALTH', `Production Health & Monitoring HTTP server listening on port ${port} (http://0.0.0.0:${port}/health)`);
    });

    server.on('error', (err: any) => {
        logger.error('HEALTH', `Health HTTP server error: ${err.message}`);
    });

    return server;
}

export function stopHealthServer(): Promise<void> {
    return new Promise((resolve) => {
        if (server) {
            server.close(() => {
                logger.info('HEALTH', 'Health HTTP server closed.');
                server = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}
