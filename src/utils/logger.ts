import fs from 'fs';
import path from 'path';

export interface LogEntry {
    timestamp: string;
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'SUCCESS';
    tag: string;
    message: string;
    context?: any;
    errorStack?: string;
}

// Colors for terminal output
const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[90m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgRed: '\x1b[41m\x1b[1;37m',
    bgYellow: '\x1b[43m\x1b[1;30m',
    bgGreen: '\x1b[42m\x1b[1;30m',
    bgCyan: '\x1b[46m\x1b[1;30m',
};

class Logger {
    private logsDir: string;
    private serverLogFile: string;
    private errorLogFile: string;
    private recentLogs: LogEntry[] = [];
    private recentErrors: LogEntry[] = [];
    private maxMemoryLogs: number = 100;
    private maxMemoryErrors: number = 50;

    constructor() {
        this.logsDir = path.resolve(__dirname, '../../logs');
        this.serverLogFile = path.join(this.logsDir, 'server.log');
        this.errorLogFile = path.join(this.logsDir, 'error.log');

        this.ensureLogsDirectory();
    }

    private ensureLogsDirectory() {
        try {
            if (!fs.existsSync(this.logsDir)) {
                fs.mkdirSync(this.logsDir, { recursive: true });
            }
        } catch (e) {
            console.error('Failed to create logs directory:', e);
        }
    }

    private getTimestamp(): string {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
    }

    private stripAnsi(text: string): string {
        return text.replace(/\x1b\[[0-9;]*m/g, '');
    }

    public maskSecrets(text: string): string {
        if (!text) return '';
        return text
            // Telegram Bot Token pattern: 123456789:ABCdef...
            .replace(/\b(\d{8,11}):([A-Za-z0-9_-]{35})\b/g, '$1:***********************************')
            // Gemini API Key pattern: AIzaSy...
            .replace(/\b(AIzaSy[A-Za-z0-9_-]{33})\b/g, 'AIzaSy*********************************')
            // Redis connection URI passwords: rediss://user:password@host
            .replace(/(redis[s]?:\/\/[^:]+:)[^@\s]+(@)/gi, '$1*****$2')
            // Supabase JWT keys
            .replace(/(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)[A-Za-z0-9_-]+/g, '$1*****');
    }

    private logWriteCounter: number = 0;

    private appendToFile(filePath: string, line: string) {
        try {
            const cleanLine = this.maskSecrets(this.stripAnsi(line)) + '\n';
            fs.appendFileSync(filePath, cleanLine, 'utf8');

            this.logWriteCounter++;
            // Check rotation only once every 500 writes to prevent disk thrashing
            if (this.logWriteCounter % 500 === 0) {
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.size > 5 * 1024 * 1024) {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const lines = content.split('\n');
                        if (lines.length > 10000) {
                            fs.writeFileSync(filePath, lines.slice(-5000).join('\n'), 'utf8');
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {
            // Fail silently on disk write issues to prevent process death
        }
    }

    private recordMemory(entry: LogEntry) {
        this.recentLogs.unshift(entry);
        if (this.recentLogs.length > this.maxMemoryLogs) {
            this.recentLogs.pop();
        }

        if (entry.level === 'ERROR') {
            this.recentErrors.unshift(entry);
            if (this.recentErrors.length > this.maxMemoryErrors) {
                this.recentErrors.pop();
            }
        }
    }

    public info(tag: string, message: string, context?: any) {
        const timestamp = this.getTimestamp();
        const entry: LogEntry = { timestamp, level: 'INFO', tag: tag.toUpperCase(), message, context };
        this.recordMemory(entry);

        const contextStr = context ? ` ${colors.dim}${this.maskSecrets(JSON.stringify(context))}${colors.reset}` : '';
        const consoleLine = `${colors.dim}[${timestamp}]${colors.reset} ${colors.cyan}[INFO]${colors.reset} ${colors.bold}[${entry.tag}]${colors.reset} ${this.maskSecrets(message)}${contextStr}`;
        console.log(consoleLine);

        const fileLine = `[${timestamp}] [INFO] [${entry.tag}] ${message}${context ? ' ' + JSON.stringify(context) : ''}`;
        this.appendToFile(this.serverLogFile, fileLine);
    }

    public success(tag: string, message: string, context?: any) {
        const timestamp = this.getTimestamp();
        const entry: LogEntry = { timestamp, level: 'SUCCESS', tag: tag.toUpperCase(), message, context };
        this.recordMemory(entry);

        const contextStr = context ? ` ${colors.dim}${this.maskSecrets(JSON.stringify(context))}${colors.reset}` : '';
        const consoleLine = `${colors.dim}[${timestamp}]${colors.reset} ${colors.green}[SUCCESS]${colors.reset} ${colors.bold}[${entry.tag}]${colors.reset} ${this.maskSecrets(message)}${contextStr}`;
        console.log(consoleLine);

        const fileLine = `[${timestamp}] [SUCCESS] [${entry.tag}] ${message}${context ? ' ' + JSON.stringify(context) : ''}`;
        this.appendToFile(this.serverLogFile, fileLine);
    }

    public warn(tag: string, message: string, context?: any) {
        const timestamp = this.getTimestamp();
        const entry: LogEntry = { timestamp, level: 'WARN', tag: tag.toUpperCase(), message, context };
        this.recordMemory(entry);

        const contextStr = context ? ` ${colors.dim}${this.maskSecrets(JSON.stringify(context))}${colors.reset}` : '';
        const consoleLine = `${colors.dim}[${timestamp}]${colors.reset} ${colors.yellow}[WARN]${colors.reset} ${colors.bold}[${entry.tag}]${colors.reset} ${colors.yellow}${this.maskSecrets(message)}${colors.reset}${contextStr}`;
        console.warn(consoleLine);

        const fileLine = `[${timestamp}] [WARN] [${entry.tag}] ${message}${context ? ' ' + JSON.stringify(context) : ''}`;
        this.appendToFile(this.serverLogFile, fileLine);
    }

    public debug(tag: string, message: string, context?: any) {
        const timestamp = this.getTimestamp();
        const entry: LogEntry = { timestamp, level: 'DEBUG', tag: tag.toUpperCase(), message, context };
        this.recordMemory(entry);

        const contextStr = context ? ` ${colors.dim}${this.maskSecrets(JSON.stringify(context))}${colors.reset}` : '';
        const consoleLine = `${colors.dim}[${timestamp}]${colors.reset} ${colors.magenta}[DEBUG]${colors.reset} ${colors.bold}[${entry.tag}]${colors.reset} ${this.maskSecrets(message)}${contextStr}`;
        console.log(consoleLine);

        const fileLine = `[${timestamp}] [DEBUG] [${entry.tag}] ${message}${context ? ' ' + JSON.stringify(context) : ''}`;
        this.appendToFile(this.serverLogFile, fileLine);
    }

    public error(tag: string, message: string, error?: any, context?: any) {
        const timestamp = this.getTimestamp();
        let errorStack = '';
        let errorDetails = '';

        if (error instanceof Error) {
            errorStack = error.stack || '';
            errorDetails = error.message;
        } else if (error) {
            errorDetails = typeof error === 'object' ? JSON.stringify(error) : String(error);
        }

        const entry: LogEntry = {
            timestamp,
            level: 'ERROR',
            tag: tag.toUpperCase(),
            message: errorDetails ? `${message} -> ${errorDetails}` : message,
            context,
            errorStack
        };
        this.recordMemory(entry);

        // Highlighted Box for Developer Console
        const border = colors.red + '━'.repeat(75) + colors.reset;
        console.error(border);
        console.error(
            `${colors.bgRed} ❌ ERROR ${colors.reset} ${colors.dim}[${timestamp}]${colors.reset} ` +
            `${colors.bold}${colors.red}[${entry.tag}]${colors.reset} ${colors.bold}${this.maskSecrets(message)}${colors.reset}`
        );
        if (errorDetails && errorDetails !== message) {
            console.error(`   ${colors.yellow}Reason:${colors.reset} ${this.maskSecrets(errorDetails)}`);
        }
        if (context) {
            console.error(`   ${colors.cyan}Context:${colors.reset} ${this.maskSecrets(JSON.stringify(context))}`);
        }
        if (errorStack) {
            // Trim stack to highlight user code
            const stackLines = errorStack.split('\n').slice(1, 6).join('\n');
            console.error(`   ${colors.dim}Stack trace:${colors.reset}\n${colors.dim}${this.maskSecrets(stackLines)}${colors.reset}`);
        }
        console.error(border);

        // Append to both server.log and error.log
        const errorFileLine = 
            `[${timestamp}] [ERROR] [${entry.tag}] ${entry.message}\n` +
            (context ? `Context: ${JSON.stringify(context)}\n` : '') +
            (errorStack ? `Stack:\n${errorStack}\n` : '') +
            '-'.repeat(50);

        this.appendToFile(this.serverLogFile, errorFileLine);
        this.appendToFile(this.errorLogFile, errorFileLine);
    }

    /**
     * Formats incoming Telegram updates cleanly in the terminal
     */
    public logUpdate(updateId: number, user: any, actionType: string, summary: string) {
        const username = user?.username ? `@${user.username}` : user?.first_name || 'Anonymous';
        const userId = user?.id || 'unknown';
        this.info('UPDATE', `👤 ${username} (${userId}) | [${actionType}] ${summary}`, { updateId });
    }

    /**
     * Get recent errors for Admin & Developer Telegram inspector
     */
    public getRecentErrors(): LogEntry[] {
        return [...this.recentErrors];
    }

    /**
     * Get recent logs
     */
    public getRecentLogs(): LogEntry[] {
        return [...this.recentLogs];
    }

    /**
     * Clear error history
     */
    public clearErrors() {
        this.recentErrors = [];
    }

    /**
     * Get log file sizes for telemetry
     */
    public getLogFileStats() {
        let serverLogSize = 0;
        let errorLogSize = 0;
        try {
            if (fs.existsSync(this.serverLogFile)) serverLogSize = fs.statSync(this.serverLogFile).size;
            if (fs.existsSync(this.errorLogFile)) errorLogSize = fs.statSync(this.errorLogFile).size;
        } catch (e) {}

        return {
            serverLogMb: (serverLogSize / 1024 / 1024).toFixed(2),
            errorLogMb: (errorLogSize / 1024 / 1024).toFixed(2),
            errorCountInMemory: this.recentErrors.length
        };
    }
}

export const logger = new Logger();
