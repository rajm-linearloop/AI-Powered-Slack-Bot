import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (err: any) {
      this.logger.warn(
        `Prisma initial database connection failed (will retry on query): ${err?.message || err}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch(() => {});
  }
}
