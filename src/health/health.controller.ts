import {
  Controller,
  Get,
  Logger,
  OnModuleDestroy,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly logger = new Logger(HealthController.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.redis = new Redis({
      host: this.configService.getOrThrow<string>('redis.host'),
      port: this.configService.getOrThrow<number>('redis.port'),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    this.redis?.on?.('error', (err: any) => {
      this.logger.warn(`Redis health client event: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }

  @Get()
  async check() {
    let database = 'down';
    let redis = 'down';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch (e) {
      this.logger.error('Database health check failed', e);
    }

    try {
      await this.redis.ping();
      redis = 'up';
    } catch (e) {
      this.logger.error('Redis health check failed', e);
    }

    const isHealthy = database === 'up' && redis === 'up';
    const status = isHealthy ? 'up' : 'down';

    if (!isHealthy) {
      throw new HttpException(
        {
          status,
          timestamp: new Date().toISOString(),
          dependencies: { database, redis },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      dependencies: {
        database,
        redis,
      },
    };
  }
}
