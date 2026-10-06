/**
 * Truncates text in the middle with an ellipsis so both ends stay visible; returns the text
 * unchanged when it already fits `maxLength`.
 */
export function middleTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return "…";
  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
