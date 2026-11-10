export interface RecordedFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type FetchResult = Response | Error | ((request: Request) => Response | Promise<Response>);

/** A deterministic fetch seam; production code receives this function rather than mutating global fetch. */
export class RecordingFetch {
  readonly requests: RecordedFetchRequest[] = [];
  #results: FetchResult[] = [];

  respond(response: Response | ((request: Request) => Response | Promise<Response>)): void {
    this.#results.push(response);
  }

  fail(error: Error): void {
    this.#results.push(error);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    this.requests.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body:
        request.method === "GET" || request.method === "HEAD" ? null : await request.clone().text(),
    });
    const result = this.#results.shift();
    if (!result) throw new Error(`Unexpected fetch: ${request.method} ${request.url}`);
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result(request) : result.clone();
  };
}
