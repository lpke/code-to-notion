import { APIResponseError, APIErrorCode } from "@notionhq/client";
import * as logger from "./logger.js";

interface QueueItem<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Rate limiter with concurrency control and 429 retry handling.
 * Limits concurrent requests and pauses all requests on rate limit.
 */
export class RateLimiter {
  private concurrency: number;
  private activeCount = 0;
  private paused = false;
  private queue: QueueItem<unknown>[] = [];
  private pausePromise: Promise<void> | null = null;

  constructor(concurrency: number = 2) {
    this.concurrency = Math.min(Math.max(concurrency, 1), 3);
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    while (
      this.activeCount < this.concurrency &&
      this.queue.length > 0 &&
      !this.paused
    ) {
      const item = this.queue.shift()!;
      this.execute(item);
    }
  }

  private async execute(item: QueueItem<unknown>): Promise<void> {
    this.activeCount++;

    try {
      // Wait if we're paused due to rate limiting
      if (this.pausePromise) {
        await this.pausePromise;
      }

      const result = await item.fn();
      item.resolve(result);
    } catch (err: unknown) {
      if (
        err instanceof APIResponseError &&
        err.code === APIErrorCode.RateLimited
      ) {
        // Parse Retry-After header
        let retryAfterMs = 1000;
        const headers = err.headers as Record<string, string> | { get?: (key: string) => string | null } | undefined;
        let retryAfter: string | null | undefined;
        if (headers && typeof headers === "object") {
          if ("get" in headers && typeof headers.get === "function") {
            retryAfter = headers.get("retry-after") ?? headers.get("Retry-After");
          } else {
            const h = headers as Record<string, string>;
            retryAfter = h["retry-after"] ?? h["Retry-After"];
          }
        }
        if (retryAfter) {
          const seconds = parseFloat(retryAfter);
          if (!isNaN(seconds)) {
            retryAfterMs = seconds * 1000;
          }
        }

        logger.warn(
          `Rate limited by Notion API. Pausing all requests for ${(retryAfterMs / 1000).toFixed(1)}s...`,
        );

        // Pause all requests
        if (!this.pausePromise) {
          this.paused = true;
          this.pausePromise = new Promise((resolve) =>
            setTimeout(() => {
              this.paused = false;
              this.pausePromise = null;
              resolve();
            }, retryAfterMs),
          );
        }

        await this.pausePromise;

        // Re-queue this item for retry
        this.activeCount--;
        this.queue.unshift(item);
        this.drain();
        return;
      }

      // Non-rate-limit error: reject
      item.reject(err);
    }

    this.activeCount--;
    this.drain();
  }
}
