export function stripMdxSyntax(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Remove import/export lines (must start at beginning of line)
    if (/^import\s/.test(line) || /^export\s/.test(line)) {
      continue;
    }

    // Escape JSX tags (uppercase first letter) to prevent rehype-raw from processing them
    const escaped = line.replace(
      /<(\/?)([A-Z][A-Za-z0-9.]*)/g,
      "&lt;$1$2",
    );
    result.push(escaped);
  }

  return result.join("\n");
}
