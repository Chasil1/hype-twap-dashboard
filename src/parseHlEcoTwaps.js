function normalizeText(text) {
  return text
    .replace(/\u00a0|\u202f/g, ' ')
    .replace(/\u2212/g, '-')
    .replace(/\r/g, '')
    .trim();
}

function parseMoney(raw) {
  const normalized = raw.replace(/\u00a0|\u202f/g, ' ').replace(/\u2212/g, '-');
  const sign = normalized.includes('-') ? -1 : 1;
  const digits = normalized.replace(/[^\d.]/g, '');

  if (!digits) {
    throw new Error(`Could not parse money value from "${raw}"`);
  }

  return sign * Number(digits);
}

function parseIntegerAfter(text, label) {
  const pattern = new RegExp(`${label}\\s*\\n\\s*([\\d ]+)`, 'i');
  const match = text.match(pattern);

  if (!match) {
    throw new Error(`Could not find ${label}`);
  }

  return Number(match[1].replace(/\s/g, ''));
}

function parseMoneyAfter(text, label) {
  const pattern = new RegExp(`${label}\\s*\\n\\s*([+\\-$\\d ,.]+)`, 'i');
  const match = text.match(pattern);

  if (!match) {
    throw new Error(`Could not find ${label}`);
  }

  return parseMoney(match[1]);
}

function parseInlineMoney(text, label) {
  const pattern = new RegExp(`^\\s*${label}\\s+([+\\-$\\d ,.]+)`, 'im');
  const match = text.match(pattern);

  if (!match) {
    throw new Error(`Could not find ${label}`);
  }

  return parseMoney(match[1]);
}

export function parseHlEcoTwaps(pageText) {
  const text = normalizeText(pageText);

  return {
    twapNet1h: parseMoneyAfter(text, 'NEXT 1H'),
    twapNet24h: parseMoneyAfter(text, 'NEXT 24H'),
    twapBuy24h: parseInlineMoney(text, 'Buy'),
    twapSell24h: parseInlineMoney(text, 'Sell'),
    activeBuyCount: parseIntegerAfter(text, 'ACTIVE BUY TWAPS'),
    activeSellCount: parseIntegerAfter(text, 'ACTIVE SELL TWAPS')
  };
}
