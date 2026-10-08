import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.redis = new Redis({
      host: this.configService.getOrThrow<string>('redis.host'),
      port: this.configService.getOrThrow<number>('redis.port'),
      maxRetriesPerRequest: 3,
    });
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

    const status = database === 'up' && redis === 'up' ? 'up' : 'down';

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
