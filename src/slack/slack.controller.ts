import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { SlackSignatureGuard } from '../common/guards/slack-signature.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { SlackEventService } from './slack-event.service.js';
import type { SlackEventPayload } from '../common/types/index.js';

@Controller('api/slack')
export class SlackController {
  private readonly logger = new Logger(SlackController.name);

  constructor(private readonly slackEventService: SlackEventService) {}

  /**
   * Slack Events API webhook.
   *
   * This endpoint must respond within 3 seconds or Slack will retry.
   * We acknowledge immediately, then process the event asynchronously.
   *
   * Slack sends a url_verification challenge during app setup —
   * we handle it inline since it needs a synchronous response.
   */
  @Post('events')
  @UseGuards(SlackSignatureGuard, RateLimitGuard)
  @HttpCode(200)
  handleEvent(@Body() body: SlackEventPayload): { challenge: string } | string {
    // URL verification challenge (Slack app setup)
    if (body.type === 'url_verification') {
      this.logger.log('Handling Slack URL verification challenge');
      return { challenge: body.challenge! };
    }

    if (body.type === 'event_callback' && body.event) {
      // Fire-and-forget: process asynchronously so we respond within 3s.
      // If the process crashes mid-processing, Slack will retry the event,
      // and our idempotency check will prevent duplicate processing.
      void this.slackEventService.processEvent(body);
    }

    return 'ok';
  }

  /**
   * Slack Interactivity webhook.
   *
   * Receives button clicks from Block Kit cards (e.g., Create Jira Task, Assign to Me).
   */
  @Post('interactions')
  @UseGuards(SlackSignatureGuard, RateLimitGuard)
  @HttpCode(200)
  handleInteraction(@Body() body: any): string {
    let payload = body;
    if (typeof body?.payload === 'string') {
      try {
        payload = JSON.parse(body.payload);
      } catch (e) {
        this.logger.error('Failed to parse interaction payload', e);
        return 'ok';
      }
    }

    if (payload?.type === 'block_actions') {
      void this.slackEventService.processInteraction(payload);
    }

    return 'ok';
  }
}
