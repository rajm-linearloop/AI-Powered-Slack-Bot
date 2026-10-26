import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BetterBugsService } from './betterbugs.service.js';
import { BetterBugsLinkParser } from './betterbugs-link.parser.js';

@Module({
  imports: [ConfigModule],
  providers: [BetterBugsService, BetterBugsLinkParser],
  exports: [BetterBugsService, BetterBugsLinkParser],
})
export class BetterBugsModule {}
