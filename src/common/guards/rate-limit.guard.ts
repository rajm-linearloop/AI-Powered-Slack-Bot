import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
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
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly redis: Redis;
  private readonly ttl: number;
  private readonly max: number;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.getOrThrow<string>('redis.host'),
      port: this.configService.getOrThrow<number>('redis.port'),
      maxRetriesPerRequest: 3,
    });
    this.ttl = this.configService.getOrThrow<number>('rateLimit.ttl');
    this.max = this.configService.getOrThrow<number>('rateLimit.max');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const body = request.body;

    // Extract user ID from either event or command payload
    const userId = body?.event?.user || body?.user_id || 'unknown';
    const key = `rate_limit:${userId}`;

    try {
      const current = await this.redis.incr(key);
      if (current === 1) {
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
