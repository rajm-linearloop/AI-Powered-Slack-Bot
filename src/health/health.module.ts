import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [HealthController],
})
export class HealthModule {}
