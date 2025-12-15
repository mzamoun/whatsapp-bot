

let SPAM_TEXT_TO_CHECK = "groupe bourse actions https chat whatsapp com"
SPAM_TEXT_TO_CHECK += "\ngroupe bourse française gratuit https chat whatsapp com"

function containsAllWordsOfOneLine(text, spamText) {
  if (!text) return false;

  // normalisation (minuscule + suppression espaces multiples)
  const normalizedText = text.toLowerCase();

  const lines = spamText
    .toLowerCase()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // au moins une ligne doit matcher
  return lines.some(line => {
    const words = line.split(/\s+/);

    // tous les mots de la ligne doivent être présents
    return words.every(word => normalizedText.includes(word));
  });
}

const text1 = "rejoignez ce groupe bourse actions sur  chat whatsapp com";
const text2 = "groupe bourse française gratuit sur https chat whatsapp com";
const text3 = "bourse crypto telegram";

console.log(containsAllWordsOfOneLine(text1, SPAM_TEXT_TO_CHECK)); // true
console.log(containsAllWordsOfOneLine(text2, SPAM_TEXT_TO_CHECK)); // true
console.log(containsAllWordsOfOneLine(text3, SPAM_TEXT_TO_CHECK)); // false
