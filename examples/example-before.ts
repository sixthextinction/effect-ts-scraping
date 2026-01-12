/**
 * Promise-based data ingestion 
 * 
 * What can go wrong? Who knows! TypeScript doesn't tell you.
 * The function signature hides all failure modes.
 */

interface DataSource {
  url: string;
  name: string;
}

interface IngestedData {
  source: string;
  content: string;
}

// This might throw anything - network errors, rate limits, captchas...
// But the type signature doesn't tell you that.
async function fetchFromSource(source: DataSource): Promise<IngestedData> {
  const response = await fetch(source.url);
  
  if (response.status === 429) {
    throw new Error('Rate limited'); // Generic error, no type info
  }
  
  if (response.status === 403) {
    throw new Error('Access denied'); // Could be captcha, could be network
  }
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`); // Generic error
  }
  
  const content = await response.text();
  return {
    source: source.name,
    content,
  };
}

// TypeScript is happy - but we have no idea what can fail
// The compiler won't force us to handle specific error cases
async function main() {
  const data = await fetchFromSource({
    url: 'https://api.example.com/data',
    name: 'Source 1',
  });
  return data;
}

export {};
