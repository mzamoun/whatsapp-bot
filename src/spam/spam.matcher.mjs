export function containsAllWordsOfOneLine(text, spamText) {
  if (!text) return false;

  const normalizedText = text.toLowerCase();

  return spamText
    .toLowerCase()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .some(line =>
      line.split(/\s+/).every(word =>
        normalizedText.includes(word)
      )
    );
}
