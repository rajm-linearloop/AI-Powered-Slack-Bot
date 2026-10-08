import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  UseGuards,
  Req,
} from '@nestjs/common';
import { SlackSignatureGuard } from '../common/guards/slack-signature.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { CommandsService } from './commands.service.js';
import type { SlackCommandPayload } from '../common/types/index.js';

@Controller('api/slack')
export class CommandsController {
  private readonly logger = new Logger(CommandsController.name);

  constructor(private readonly commandsService: CommandsService) {}

  /**
   * Slack Commands API webhook.
   *
   * Must respond within 3 seconds. Acknowledges immediately (returns 200)
   * and processes the command asynchronously.
   */
  @Post('commands')
  @UseGuards(SlackSignatureGuard, RateLimitGuard)
  @HttpCode(200)
  handleCommand(@Body() body: SlackCommandPayload): string {
    // Note: Since Slack sends commands as application/x-www-form-urlencoded,
    // the @Body() decorator needs express to parse it properly.
    // We configure Express urlencoded parser in main.ts.

    this.logger.log(`Received command: ${body.command}`);

    // Process asynchronously
    void this.commandsService.executeCommand(body);

    // Empty 200 response tells Slack to hide the user's command invocation
    // from the channel (unless it's /ask where we manually echo it back later).
    return '';
  }
}
