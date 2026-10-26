/**
 * Converts standard Markdown syntax into Slack mrkdwn syntax.
 *
 * Slack's mrkdwn formatting differs from standard CommonMark:
 * - Bold: Slack requires single asterisks (*bold*), whereas standard Markdown uses double (**bold**).
 * - Headers: Slack does not support #, ##, ### headers; they must be converted to bold (*Header*).
 * - Links: Slack uses <url|label> instead of [label](url).
 * - Code blocks and inline code are preserved untouched.
 */
export function formatSlackMrkdwn(text: string): string {
  if (!text) return '';

  // Split code blocks so we don't accidentally format content inside ``` or `
  const codeBlockRegex = /(```[\s\S]*?```|`[^`\n]*`)/g;
  const parts = text.split(codeBlockRegex);

  return parts
    .map((part, index) => {
      // Odd indices are code blocks or inline code — preserve them exactly as-is
      if (index % 2 === 1) {
        return part;
      }

      let formatted = part;

      // 1. Convert markdown headers: "### Title" or "## Title" or "# Title" -> "*Title*"
      formatted = formatted.replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, '*$1*');

      // 2. Convert standard markdown bold: "**bold**" or "__bold__" -> "*bold*"
      formatted = formatted.replace(/\*\*(.+?)\*\*/g, '*$1*');
      formatted = formatted.replace(/__(.+?)__/g, '*$1*');

      // 3. Convert standard markdown links: "[label](url)" -> "<url|label>"
      formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<$2|$1>');

      return formatted;
    })
    .join('');
}
