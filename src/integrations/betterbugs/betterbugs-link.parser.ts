import { Injectable } from '@nestjs/common';

export interface ExtractedBugLink {
  bugId: string;
  url: string;
}

export interface LinkParseResult {
  hasLink: boolean;
  isAmbiguous: boolean;
  bugId?: string;
  url?: string;
  allLinks: ExtractedBugLink[];
}

@Injectable()
export class BetterBugsLinkParser {
  // Regex to match BetterBugs session or bug URLs:
  // e.g. https://app.betterbugs.io/session/bug-abc123
  // or   https://app.betterbugs.io/bugs/bug-abc123
  // Also handles Slack's <URL|label> or <URL> formatting
  private readonly URL_REGEX =
    /(?:https?:\/\/)?app\.betterbugs\.io\/(?:session|bugs)\/([a-zA-Z0-9_-]+)/gi;

  /**
   * Parse text from a Slack message to detect and extract BetterBugs session or bug links.
   */
  parse(text: string): LinkParseResult {
    if (!text || typeof text !== 'string') {
      return { hasLink: false, isAmbiguous: false, allLinks: [] };
    }

    const allLinks: ExtractedBugLink[] = [];
    let match: RegExpExecArray | null;

    // Reset regex index for global matching
    this.URL_REGEX.lastIndex = 0;

    while ((match = this.URL_REGEX.exec(text)) !== null) {
      const bugId = match[1];
      const fullUrl = `https://app.betterbugs.io/session/${bugId}`;

      // Avoid duplicates
      if (!allLinks.some((l) => l.bugId === bugId)) {
        allLinks.push({ bugId, url: fullUrl });
      }
    }

    if (allLinks.length === 0) {
      return { hasLink: false, isAmbiguous: false, allLinks: [] };
    }

    const isAmbiguous = allLinks.length > 1;

    return {
      hasLink: true,
      isAmbiguous,
      bugId: allLinks[0].bugId,
      url: allLinks[0].url,
      allLinks,
    };
  }

  /**
   * Quick boolean check if text mentions a BetterBugs link.
   */
  hasBetterBugsLink(text: string): boolean {
    return this.parse(text).hasLink;
  }
}
