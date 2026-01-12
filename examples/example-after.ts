/**
 * Effect-based data ingestion - everything is explicit
 * 
 * TypeScript forces you to handle errors and dependencies.
 * The type signature tells you exactly what can go wrong.
 */

import { Effect, Context, Layer, Data, pipe, Console } from 'effect';

// 1. Explicit Error Types - TypeScript knows exactly what can go wrong
// ------------------------------------------------------------------------
class NetworkError extends Data.TaggedError('NetworkError')<{
  message: string;
  url: string;
}> {}

class RateLimitError extends Data.TaggedError('RateLimitError')<{
  message: string;
  url: string;
}> {}

class CaptchaError extends Data.TaggedError('CaptchaError')<{
  message: string;
  url: string;
}> {}

type IngestionError = NetworkError | RateLimitError | CaptchaError;

// 2. Explicit Dependencies - TypeScript knows what the function needs
// ------------------------------------------------------------------------
interface HttpClient {
  fetch: (url: string) => Effect.Effect<Response, NetworkError, never>;
}

const HttpClient = Context.GenericTag<HttpClient>('HttpClient');

const HttpClientLive = Layer.succeed(
  HttpClient,
  HttpClient.of({
    fetch: (url: string) =>
      Effect.tryPromise({
        try: async () => fetch(url),
        catch: (error: unknown) =>
          new NetworkError({
            message: `Failed to fetch ${url}`,
            url,
          }),
      }),
  })
);

// 3. Fetching with Effect -- everything you need to know is in the type signature
// ----------------------------------------------------------------------------
interface DataSource {
  url: string;
  name: string;
} 

interface IngestedData {
  source: string;
  content: string;
}

/**
 * Type signature: Effect<IngestedData, IngestionError, HttpClient>
 * 
 * - Success: IngestedData (what it produces)
 * - Error: IngestionError (specific ways it can fail)
 * - Requirements: HttpClient (what it depends on)
 * 
 * TypeScript will NOT let you call this without:
 * 1. Providing HttpClient (the dependency)
 * 2. Handling the possible errors
 */
const fetchFromSource = (
  source: DataSource
): Effect.Effect<IngestedData, IngestionError, HttpClient> =>
  pipe(
    HttpClient,
    Effect.flatMap((http) => http.fetch(source.url)),
    Effect.flatMap((response): Effect.Effect<string, IngestionError, never> => {
      if (response.status === 429) {
        return Effect.fail(
          new RateLimitError({
            message: `Rate limited for ${source.name}`,
            url: source.url,
          })
        );
      }
      
      if (response.status === 403) {
        return Effect.fail(
          new CaptchaError({
            message: `Captcha challenge for ${source.name}`,
            url: source.url,
          })
        );
      }
      
      if (!response.ok) {
        return Effect.fail(
          new NetworkError({
            message: `HTTP ${response.status} for ${source.name}`,
            url: source.url,
          })
        );
      }
      
      return Effect.tryPromise({
        try: async () => await response.text(),
        catch: (error: unknown) =>
          new NetworkError({
            message: `Failed to read response from ${source.name}`,
            url: source.url,
          }),
      });
    }),
    Effect.flatMap((content: string) =>
      Effect.succeed({
        source: source.name,
        content,
      })
    )
  );

// 4. Usage - TypeScript Enforces Everything
// ----------------------------------------------------------------------------
const program = pipe(
  fetchFromSource({
    url: 'https://api.example.com/data',
    name: 'Source 1',
  }),
  Effect.provide(HttpClientLive), // Provide the dependency
  Effect.catchAll((error: IngestionError) => {
    // TypeScript knows exactly which error types are possible
    if (error._tag === 'RateLimitError') {
      return pipe(
        Console.error(`Rate limit hit: ${error.message}`),
        Effect.flatMap(() =>
          Effect.succeed({ source: 'fallback', content: 'Rate limited - using cached data' })
        )
      );
    } else if (error._tag === 'CaptchaError') {
      return pipe(
        Console.error(`CAPTCHA challenge: ${error.message}`),
        Effect.flatMap(() =>
          Effect.succeed({ source: 'fallback', content: 'CAPTCHA required - manual intervention needed' })
        )
      );
    } else {
      // NetworkError or other errors
      return pipe(
        Console.error(`Network error: ${error.message}`),
        Effect.flatMap(() =>
          Effect.succeed({ source: 'fallback', content: 'Network error - retry later' })
        )
      );
    }
  })
);

// Aaaand finally....Effect.runPromise executes the Effect program and returns a Promise
Effect.runPromise(program).catch((error: unknown) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
