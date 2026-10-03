/**
 * Concurrency Semaphore and Queue Controller
 * Limits simultaneous heavy operations (yt-dlp, ffmpeg, Gemini API calls)
 * to ensure 10+ concurrent users never overwhelm CPU, RAM, or external APIs.
 */
export class ConcurrencyLimiter {
    private activeCount = 0;
    private queue: Array<() => void> = [];

    constructor(private readonly maxConcurrent: number) {}

    public get active(): number {
        return this.activeCount;
    }

    public get waiting(): number {
        return this.queue.length;
    }

    public async acquire(): Promise<() => void> {
        if (this.activeCount < this.maxConcurrent) {
            this.activeCount++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                this.activeCount--;
                this.next();
            };
        }

        return new Promise<() => void>((resolve) => {
            this.queue.push(() => {
                this.activeCount++;
                let released = false;
                resolve(() => {
                    if (released) return;
                    released = true;
                    this.activeCount--;
                    this.next();
                });
            });
        });
    }

    private next(): void {
        if (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
            const nextResolve = this.queue.shift();
            if (nextResolve) nextResolve();
        }
    }
}

// Global limiters tuned for high concurrent stability
export const downloadLimiter = new ConcurrencyLimiter(3); // Max 3 concurrent yt-dlp/ffmpeg processes
export const aiLimiter = new ConcurrencyLimiter(6);       // Max 6 concurrent Gemini API calls
export const ttsLimiter = new ConcurrencyLimiter(5);      // Max 5 concurrent Edge Neural TTS syntheses
