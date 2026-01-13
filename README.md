# Data Ingestion Pipelines with Effect-TS

This repo is accompaniment for my blog post on Fault tolerant web data pipelines.

[You can read it here.](https://javascript.plainenglish.io/building-a-fault-tolerant-web-data-ingestion-pipeline-with-effect-ts-0bc5494282ba)


Proof of concept for a fault-tolerant web data pipeline built with Effect + proxies (Bright Data for general unblocking + CAPTCHA solving), demonstrating typed error handling, resource management, retry logic, and composable pipelines.

If you want to learn, some examples are provided in ./examples

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure Bright Data proxy (optional):
   - **To use Bright Data proxy**: Copy `.env.example` to `.env` and add your credentials:
     ```
     BRIGHT_DATA_CUSTOMER_ID=your_customer_id
     BRIGHT_DATA_ZONE=your_zone_name
     BRIGHT_DATA_PASSWORD=your_password
     ```
   - **To run without proxy**: Simply don't create a `.env` file or leave the Bright Data variables unset. The scraper will run directly without a proxy.

3. Run pipeline:
```bash
npm run full-pipeline      # complete scraping pipeline
```

---

# What's Implemented:
-------------------------------------

## A: Typed Errors
- **Error types**: Defined using `Data.TaggedError` - NetworkError, TimeoutError, RateLimitError, IPBlockError, BrowserError, ParseError
- **Type-safe error handling**: Errors are in function signatures as `Effect<Success, Error, Requirements>` - enables `catchTag` for type-safe error handling
- **Error union type**: `ScrapingError` combines all possible error types in the pipeline

## B: Browser Functions with Puppeteer
- **Browser lifecycle**: `launchBrowser()` creates Puppeteer browser with Bright Data proxy configuration
- **Page lifecycle**: `navigatePageAndGetContent()` uses `Effect.acquireUseRelease` to manage page lifecycle - creates page, navigates, gets content, always closes page even on error
- **Resource management**: `scrapeUrl()` uses `acquireUseRelease` to manage browser lifecycle - launches browser, navigates page, always closes browser even on error
- **HTTP error detection**: Maps HTTP status codes to typed errors (429 = RateLimitError, 403 = IPBlockError, >=400 = NetworkError)
- **Proxy authentication**: Bright Data proxy credentials configured via `page.authenticate()`

## C: Retry Logic
- **Retry policy**: Uses `Schedule.exponential(Duration.seconds(1))` intersected with `Schedule.recurs(3)` - exponential backoff with max 3 retries
- **Error filtering**: `retryableErrors` array defines which errors trigger retries (NetworkError, TimeoutError, RateLimitError, IPBlockError, BrowserError) - ParseError is fatal
- **Declarative retries**: `Effect.retry` with `until` predicate - retries only retryable errors, fails fast on fatal errors

## D: Rate Limiting (Simple)
- **Request delay**: `withSimpleRateLimit()` adds 100ms delay between requests using `Effect.sleep`
- **Composable**: Wraps any effect to add rate limiting - can be composed with retry logic

## E: Scraping Logic
- **HTML parsing**: `parseHtml()` uses cheerio to extract title and spans from HTML - errors converted to ParseError
- **Pipeline composition**: `scrapeWithRetry()` chains rate limiting, scraping, retry logic, and parsing using `pipe` and `flatMap`
- **Main program**: Composes entire pipeline with logging and error handling using `Effect.tap` and `Effect.catchAll`

---

# Why the Effect Version Is Better for Production
-------------------------------------

Compared to a vanilla TypeScript implementation, the Effect-based pipeline has a few big advantages:

-   Errors are part of the type system and MUST be handled or intentionally propagated
-   Resource lifecycles are enforced by construction
-   Retry behavior is declarative, composable, and constrained by error types
-   Failure modes are explicit and discoverable at compile time
-   Cross-cutting concerns (retries, rate limits, cleanup) compose without refactoring core logic
-   Structured errors make debugging and observability far easier
-   Concurrency is safer by default, especially around shared resources

None of this makes building with Effect-TS _easier_. The learning curve is very steep. But once the system is in place, entire categories of production bugs in web data pipelines simply stop existing. I'd say it's well worth learning.
