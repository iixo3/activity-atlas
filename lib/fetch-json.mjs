/** Bounded retries for temporary network, rate-limit and server failures. */
export async function fetchJsonWithRetry(url, { fetcher = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let retryable = true;
    try {
      const response = await fetcher(url, { headers: { "user-agent": "ActivityAtlas/1.0 research dashboard" }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new Error(`${response.status} ${response.statusText}: ${url}`);
      }
      return await response.json();
    } catch (error) {
      if (!retryable || attempt === 2) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** Optional feeds may retain their own dated history. Return an explicit
 * failure, never a fabricated zero or a newly timestamped cached payload. */
export async function fetchOptionalJson(url, fetcher = fetchJsonWithRetry) {
  try {
    return { data: await fetcher(url), error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
}
