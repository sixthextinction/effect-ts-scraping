/**
 * Simplified data ingestion pipeline using Effect-TS with Puppeteer and Bright Data
 * 
 * Demonstrates core Effect concepts:
 * - Typed error handling with tagged errors
 * - Declarative retry logic with schedules
 * - Resource management with acquireUseRelease
 * - Composable pipelines with pipe, flatMap, and andThen
 * 
 * This version removes dependency injection and complex rate limiting to focus on
 * the essential value propositions of Effect.
 */

import {
  Effect,
  Schedule,
  pipe,
  Console,
  Data,
  Duration,
} from 'effect';
import puppeteer, { type Browser } from 'puppeteer';
import * as cheerio from 'cheerio';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Point to your .env directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '../../.env') });

const TARGET_URL = 'https://quotes.toscrape.com/js/'; // or use whatever URL you want to scrape

// ============================================================================
// Proxy Configuration (Optional)
// ============================================================================

// Bright Data HTTP Proxy configuration (from env vars or .env file)
// Optional: if not provided, scraper will run without proxy
const BRIGHT_DATA_CONFIG = {
  customerId: process.env.BRIGHT_DATA_CUSTOMER_ID,
  zone: process.env.BRIGHT_DATA_ZONE,
  password: process.env.BRIGHT_DATA_PASSWORD,
  proxyHost: 'brd.superproxy.io',
  proxyPort: 33335,
};

const isBrightDataConfigured = (): boolean =>
  !!(BRIGHT_DATA_CONFIG.customerId && BRIGHT_DATA_CONFIG.zone && BRIGHT_DATA_CONFIG.password);

interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

const buildProxyConfig = (): ProxyConfig | null => {
  if (!isBrightDataConfigured()) {
    return null;
  }
  const username = `brd-customer-${BRIGHT_DATA_CONFIG.customerId}-zone-${BRIGHT_DATA_CONFIG.zone}`;
  return {
    host: BRIGHT_DATA_CONFIG.proxyHost,
    port: BRIGHT_DATA_CONFIG.proxyPort,
    username,
    password: BRIGHT_DATA_CONFIG.password!,
  };
};

// ============================================================================
// Layer 1: Typed Errors
// ============================================================================

// Data.TaggedError creates error types with a _tag discriminant field
// This enables type-safe error handling with Effect.catchTag
// See: https://effect.website/docs/error-management/expected-errors
class NetworkError extends Data.TaggedError('NetworkError')<{
  message: string;
  url: string;
  cause?: unknown;
}> {}

class TimeoutError extends Data.TaggedError('TimeoutError')<{
  message: string;
  url: string;
  timeout: number;
}> {}

class RateLimitError extends Data.TaggedError('RateLimitError')<{
  message: string;
  url: string;
  retryAfter?: number;
}> {}

class IPBlockError extends Data.TaggedError('IPBlockError')<{
  message: string;
  url: string;
  proxyId?: string;
}> {}

class BrowserError extends Data.TaggedError('BrowserError')<{
  message: string;
  cause?: unknown;
}> {}

class ParseError extends Data.TaggedError('ParseError')<{
  message: string;
  cause?: unknown;
}> {}

// combines all possible error types in our data pipeline
type ScrapingError =
  | NetworkError
  | TimeoutError
  | RateLimitError
  | IPBlockError
  | BrowserError
  | ParseError;

// ============================================================================
// Layer 2: Browser Functions with Puppeteer
// ============================================================================

// Effect.tryPromise converts a Promise-returning function into an Effect
// Errors are caught and converted to typed errors (BrowserError)
const launchBrowser = (
  proxyConfig: ProxyConfig | null
): Effect.Effect<Browser, BrowserError> =>
  Effect.tryPromise({
    try: async () => {
      const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      };

      if (proxyConfig) {
        // configure for Bright Data proxy
        process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // disable SSL validation for Bright Data proxy
        launchOptions.ignoreHTTPSErrors = true; // ignore SSL certificate errors
        launchOptions.args!.push(`--proxy-server=${proxyConfig.host}:${proxyConfig.port}`);
      }

      return await puppeteer.launch(launchOptions);
    },
    catch: (error: unknown) =>
      new BrowserError({
        message: proxyConfig ? 'Failed to launch browser with Bright Data proxy' : 'Failed to launch browser',
        cause: error,
      }),
  });

// Effect.acquireUseRelease manages resource lifecycle: acquire, use, and release
// Ensures cleanup happens even if errors occur (like try/finally)
// See: https://effect.website/docs/resource-management/introduction
// This function manages the PAGE lifecycle: creates page, navigates, gets content, closes page
const navigatePageAndGetContent = (
  browser: Browser,
  url: string,
  proxyConfig: ProxyConfig | null,
  timeout: number = 10000
): Effect.Effect<string, BrowserError | TimeoutError | IPBlockError | RateLimitError | NetworkError> =>
  Effect.acquireUseRelease(
    // step 1: acquire: create the page
    Effect.tryPromise({
      try: async () => {
        const page = await browser.newPage();
        if (proxyConfig) {
          await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password }); // authenticate with Bright Data proxy
        }
        return page;
      },
      catch: (error: unknown) =>
        new BrowserError({
          message: 'Failed to create page or authenticate',
          cause: error,
        }),
    }),
    // step 2: use: navigate and get content
    (page) =>
      Effect.tryPromise({
        try: async () => {
          const response = await page.goto(url, {
            waitUntil: 'networkidle2', // use 'load' if 'networkidle2' fails - proxies can have background requests that never stop
            timeout: Math.max(timeout, 30000), // using an extended 30s timeout for proxy connections
          });

          // check for HTTP errors that indicate blocks/rate limits
          if (response) {
            const status = response.status();
            if (status === 429) {
              throw new RateLimitError({
                message: `Rate limited: ${url}`,
                url,
              });
            }
            if (status === 403) {
              throw new IPBlockError({
                message: `IP blocked: ${url}`,
                url,
              });
            }
            if (status >= 400) {
              throw new NetworkError({
                message: `HTTP error ${status}: ${url}`,
                url,
              });
            }
          }

          return await page.content();
        },
        catch: (error: unknown) => {
          if (error instanceof RateLimitError || error instanceof IPBlockError) {
            return error;
          }
          if (error instanceof NetworkError) {
            return error;
          }
          if (error instanceof Error && error.message.includes('timeout')) {
            return new TimeoutError({
              message: `Navigation timeout after ${timeout}ms`,
              url,
              timeout,
            });
          }
          return new BrowserError({
            message: 'Failed to navigate or get content',
            cause: error,
          });
        },
      }),
    // step 3: release: always close the page, even on error
    (page) =>
      pipe(
        Effect.tryPromise({
          try: async () => await page.close(),
          catch: () => new Error('Failed to close page'),
        }),
        Effect.catchAll(() => Effect.void) // ignore close errors
      )
  );

// Main function to scrape a URL - manages browser lifecycle (launches browser, navigates page, closes browser)
// Uses pipeline style with pipe and flatMap instead of Effect.gen
const scrapeUrl = (
  url: string,
  options?: { timeout?: number }
): Effect.Effect<string, BrowserError | TimeoutError | IPBlockError | RateLimitError | NetworkError> => {
  const proxyConfig = buildProxyConfig();
  const timeout = options?.timeout || 10000;
  // Bright Data automatically rotates IPs on each request, so retry on IP block gets new IP
  // If proxy is not configured, runs without proxy
  return Effect.acquireUseRelease(
    launchBrowser(proxyConfig),
    (browser) => navigatePageAndGetContent(browser, url, proxyConfig, timeout),
    (browser) =>
      pipe(
        Effect.tryPromise({
          try: async () => await browser.close(),
          catch: () => new Error('Failed to close browser'),
        }),
        Effect.catchAll(() => Effect.void)
      )
  );
};

// ============================================================================
// Layer 3: Retry Logic
// ============================================================================

// Network errors, timeouts, rate limits, IP blocks, and browser errors are retryable
// Parse errors are fatal (logic error, not transient)
const retryableErrors = [
  'NetworkError',
  'TimeoutError',
  'RateLimitError',
  'IPBlockError',
  'BrowserError',
] as const;

// Schedule defines retry policies: exponential backoff with max 3 retries
// Schedule.intersect combines multiple schedules (both must be satisfied)
// See: https://effect.website/docs/error-management/retrying
const retryPolicy = pipe(
  Schedule.exponential(Duration.seconds(1)),
  Schedule.intersect(Schedule.recurs(3))
);

const isRetryableError = (error: ScrapingError): boolean =>
  retryableErrors.includes(error._tag as any);

// Effect.retry retries an effect according to a Schedule policy
// The 'until' predicate determines which errors should trigger retries
// See: https://effect.website/docs/error-management/retrying
const retryIfRetryable = <A, E extends ScrapingError, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    schedule: retryPolicy,
    until: (error) => isRetryableError(error),
  });

// ============================================================================
// Layer 4: Rate Limiting
// ============================================================================

// Simple rate limiting: just add a delay between requests
// Effect<A, E, R> is just Effect ecosystem convention for Effect<Success, Error, Requirements>
const withSimpleRateLimit = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  pipe(
    Effect.sleep(Duration.millis(100)), // 100ms delay between requests
    Effect.flatMap(() => effect)
  );

// ============================================================================
// Scraping Logic
// ============================================================================

interface ScrapingResult {
  title: string;
  spans: string[];
  url: string;
}

// Effect.try converts a synchronous function that may throw into an Effect
// Errors are caught and converted to typed errors (ParseError)
const parseHtml = (html: string): Effect.Effect<ScrapingResult, ParseError> =>
  Effect.try({
    try: () => {
      const $ = cheerio.load(html);
      const title = $('h1').text().trim();
      const spans = $('span')
        .map((_i: number, el: any) => $(el).text().trim())
        .get()
        .filter((s: string) => s.length > 0);

      return {
        title,
        spans,
        url: TARGET_URL,
      };
    },
    catch: (error: unknown) =>
      new ParseError({
        message: 'Failed to parse HTML',
        cause: error,
      }),
  });

// Pipeline style composition: chain effects sequentially using pipe and flatMap
// Effect.flatMap chains effects where each step depends on the previous result
const scrapeWithRetry = (): Effect.Effect<ScrapingResult, ScrapingError> =>
  pipe(
    withSimpleRateLimit(scrapeUrl(TARGET_URL, { timeout: 30000 })),
    retryIfRetryable,
    Effect.flatMap(parseHtml)
  );

// ============================================================================
// Composing the Pipeline
// ============================================================================

// pipe composes functions sequentially, passing output of one as input to next
// Makes Effect operations readable left-to-right instead of nested
// See: https://effect.website/docs/getting-started/building-pipelines
const program = pipe(
  scrapeWithRetry(),
  // Effect.tap runs a side effect without changing the value
  // Chain multiple console logs using pipe and flatMap
  Effect.tap((result: ScrapingResult) =>
    pipe(
      Console.log('Scraping successful!'),
      Effect.flatMap(() => Console.log(JSON.stringify(result, null, 2)))
    )
  ),
  // Effect.catchAll handles all errors, converting them to success or different errors
  // Chain error handling operations using pipe and flatMap
  Effect.catchAll((error: ScrapingError) =>
    pipe(
      Console.error('Pipeline failed:', error),
      Effect.flatMap(() => Effect.sync(() => process.exit(1))) // Effect.sync wraps synchronous code
    )
  )
);

// Effect.runPromise executes the Effect program and returns a Promise
// This is the entry point that runs the entire pipeline
Effect.runPromise(program).catch((error: unknown) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
