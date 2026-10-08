import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module.js';
import { JiraService } from './jira.service.js';

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [JiraService],
  exports: [JiraService],
})
export class JiraModule {}
