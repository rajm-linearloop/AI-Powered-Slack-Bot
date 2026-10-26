import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Validates Slack request signatures using HMAC-SHA256.
 *
 * Slack signs every request with the app's signing secret. This guard
 * rejects any request that doesn't have a valid signature, preventing
 * forged webhook calls.
 *
 * The raw body must be available on the request — we configure Express
 * to preserve it via rawBody option in main.ts.
 */
@Injectable()
export class SlackSignatureGuard implements CanActivate {
  private readonly logger = new Logger(SlackSignatureGuard.name);
  private readonly signingSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.signingSecret = this.configService.getOrThrow<string>(
      'slack.signingSecret',
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const timestamp = request.headers['x-slack-request-timestamp'] as string;
    const slackSignature = request.headers['x-slack-signature'] as string;

    if (!timestamp || !slackSignature) {
      this.logger.warn('Missing Slack signature headers');
      throw new UnauthorizedException('Missing Slack signature headers');
    }

    // Reject requests older than 5 minutes to prevent replay attacks
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    if (parseInt(timestamp, 10) < fiveMinutesAgo) {
      this.logger.warn('Slack request timestamp too old');
      throw new UnauthorizedException('Request timestamp expired');
    }

    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      this.logger.error(
        'Raw body not available — check rawBody config in main.ts',
      );
      throw new UnauthorizedException('Cannot verify signature');
    }

    const sigBaseString = `v0:${timestamp}:${rawBody.toString()}`;
    const mySignature =
      'v0=' +
      createHmac('sha256', this.signingSecret)
        .update(sigBaseString)
        .digest('hex');

    const mySigBuffer = Buffer.from(mySignature, 'utf8');
    const slackSigBuffer = Buffer.from(slackSignature, 'utf8');

    if (
      mySigBuffer.length !== slackSigBuffer.length ||
      !timingSafeEqual(mySigBuffer, slackSigBuffer)
    ) {
      this.logger.warn('Invalid Slack signature');
      throw new UnauthorizedException('Invalid Slack signature');
    }

    return true;
  }
}
