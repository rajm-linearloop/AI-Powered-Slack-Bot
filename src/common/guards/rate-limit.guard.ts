import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * Redis-backed rate limiter scoped per Slack user.
 *
 * Uses a sliding-window counter pattern: each user gets a Redis key
 * with a TTL. If the count exceeds the configured max within the window,
 * the request is silently dropped (we don't want to error in Slack).
 */
@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly redis: Redis;
  private readonly ttl: number;
  private readonly max: number;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.getOrThrow<string>('redis.host'),
      port: this.configService.getOrThrow<number>('redis.port'),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    this.redis?.on?.('error', (err: any) => {
      this.logger.warn(`Redis rate limit client event: ${err.message}`);
    });
    this.ttl = this.configService.getOrThrow<number>('rateLimit.ttl');
    this.max = this.configService.getOrThrow<number>('rateLimit.max');
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const body = request.body;

    // URL verification challenge from Slack app setup must never be rate limited
    if (body?.type === 'url_verification') {
      return true;
    }

    // Extract user ID from event, command, or interactive block action payload
    let userId = body?.event?.user || body?.user_id;

    if (!userId && body?.payload) {
      try {
        const parsed =
          typeof body.payload === 'string'
            ? JSON.parse(body.payload)
            : body.payload;
        userId = parsed?.user?.id;
      } catch {
        // fallback to unknown if parsing fails
      }
    }

    const key = `rate_limit:${userId || 'unknown'}`;

    try {
      const results = await this.redis
        .pipeline()
        .incr(key)
        .ttl(key)
        .exec();

      if (!results) {
        return true;
      }

      const current = (results[0][1] as number) || 1;
      const keyTtl = (results[1][1] as number) || -1;

      // Ensure key always has an expiry even if previous write was interrupted
      if (keyTtl === -1) {
        await this.redis.expire(key, this.ttl);
      }

      if (current > this.max) {
        this.logger.warn(
          `Rate limit exceeded for user ${userId}: ${current}/${this.max}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      // If Redis is down, allow the request through — fail open for availability
      this.logger.error('Rate limit check failed, allowing request', error);
      return true;
    }
  }
}
