/** Settle the caller even if transport or response-body reading ignores abort. */
export async function requestWithTimeout<T>(run: (signal: AbortSignal) => Promise<T>, milliseconds: number, message: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(message)); controller.abort(); }, milliseconds);
  });
  try { return await Promise.race([Promise.resolve().then(() => run(controller.signal)), expired]); }
  finally { clearTimeout(timer!); }
}
