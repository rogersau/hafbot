import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { fingerprintImageAttachments } from "../src/services/bot-defense/attachment-fingerprint";
import { fingerprintRateMessage } from "../src/services/bot-defense/message-filter";
import { fixtureFetch, imageFixture } from "./support/bot-defense-image-fixtures";

test("exact image sets match after reupload, rename, signed URL changes and reorder", async () => {
  const first = Array.from({ length: 4 }, (_, index) => imageFixture(index, 1));
  const second = Array.from({ length: 4 }, (_, index) => imageFixture(index, 2)).reverse();
  const fetcher = fixtureFetch([...first, ...second]);
  const fingerprint = await fingerprintImageAttachments(
    first.map((f) => f.attachment),
    fetcher,
  );
  assert.match(fingerprint!, /^[a-f0-9]{64}$/);
  assert.equal(
    fingerprint,
    await fingerprintImageAttachments(
      second.map((f) => f.attachment),
      fetcher,
    ),
  );
  assert.notEqual(fingerprint, await fingerprintRateMessage(fingerprint!));
});

test("changed bytes, missing images and duplicate multiplicity do not match", async () => {
  const first = imageFixture(0);
  const other = imageFixture(1);
  const fetcher = fixtureFetch([first, other]);
  const fingerprint = await fingerprintImageAttachments([first.attachment], fetcher);
  assert.notEqual(fingerprint, await fingerprintImageAttachments([other.attachment], fetcher));
  assert.notEqual(
    fingerprint,
    await fingerprintImageAttachments([first.attachment, first.attachment], fetcher),
  );
  assert.notEqual(
    await fingerprintImageAttachments([first.attachment, other.attachment], fetcher),
    await fingerprintImageAttachments([first.attachment, first.attachment], fetcher),
  );
});

test("visually identical PNGs with different compression do not match", async () => {
  const original = imageFixture(0, 1, 9);
  const recompressed = imageFixture(0, 2, 0);
  assert.notDeepEqual(original.bytes, recompressed.bytes);
  const fetcher = fixtureFetch([original, recompressed]);
  assert.notEqual(
    await fingerprintImageAttachments([original.attachment], fetcher),
    await fingerprintImageAttachments([recompressed.attachment], fetcher),
  );
});

test("empty, mixed, malformed, unsupported, too many and oversized attachments skip all downloads", async () => {
  const image = imageFixture().attachment;
  let fetches = 0;
  const fetcher = (async () => {
    fetches += 1;
    throw new Error("must not fetch");
  }) as typeof fetch;
  for (const attachments of [
    [],
    [null],
    [image, { ...image, content_type: "application/pdf" }],
    [{ ...image, content_type: "image/svg+xml" }],
    [{ ...image, size: 0 }],
    [{ ...image, size: 1.5 }],
    [{ ...image, size: "100" }],
    [{ ...image, size: 5 * 1024 * 1024 + 1 }],
    [
      { ...image, size: 3 * 1024 * 1024 },
      { ...image, size: 3 * 1024 * 1024 },
    ],
    Array.from({ length: 11 }, () => image),
  ]) {
    assert.equal(await fingerprintImageAttachments(attachments, fetcher), null);
  }
  assert.equal(fetches, 0);
});

test("untrusted hosts, credentials, ports, schemes and non-attachment paths never fetch", async () => {
  const image = imageFixture().attachment;
  let fetches = 0;
  const fetcher = (async () => {
    fetches += 1;
    throw new Error("must not fetch");
  }) as typeof fetch;
  for (const url of [
    "http://cdn.discordapp.com/attachments/123/456/test.png",
    "https://127.0.0.1/attachments/123/456/test.png",
    "https://cdn.discordapp.com.evil.invalid/attachments/123/456/test.png",
    "https://cdn.discordapp.com@evil.invalid/attachments/123/456/test.png",
    "https://user:password@cdn.discordapp.com/attachments/123/456/test.png",
    "https://cdn.discordapp.com:8443/attachments/123/456/test.png",
    "https://cdn.discordapp.com/other/test.png",
    "https://cdn.discordapp.com/attachments/123/456/test.png#fragment",
    "data:image/png;base64,AAAA",
    "not a URL",
  ])
    assert.equal(await fingerprintImageAttachments([{ ...image, url }], fetcher), null);
  assert.equal(fetches, 0);
});

test("attachment requests use a deadline, reject redirects and send no bot credentials", async () => {
  const fixture = imageFixture();
  for (const host of ["cdn.discordapp.com", "media.discordapp.net"]) {
    const attachment = {
      ...fixture.attachment,
      url: fixture.attachment.url.replace("cdn.discordapp.com", host),
    };
    const fetcher = (async (_input, init) => {
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, undefined);
      assert.ok(init?.signal);
      assert.equal(init?.headers, undefined);
      return new Response(new Uint8Array(fixture.bytes));
    }) as typeof fetch;
    assert.ok(await fingerprintImageAttachments([attachment], fetcher));
  }
});

test("failed, redirected, partial and oversized responses never yield a partial-set fingerprint", async () => {
  const fixture = imageFixture();
  const responses = [
    () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 302, headers: { location: "https://example.invalid" } }),
    () => new Response(new Uint8Array(fixture.bytes), { headers: { "content-length": "999" } }),
    () => new Response(new Uint8Array(fixture.bytes).slice(1)),
    () => new Response(new Uint8Array(fixture.bytes.byteLength + 1)),
    () => {
      throw new Error("CDN unavailable");
    },
  ];
  for (const response of responses) {
    let calls = 0;
    const fetcher = (async () =>
      ++calls === 1 ? new Response(new Uint8Array(fixture.bytes)) : response()) as typeof fetch;
    assert.equal(
      await fingerprintImageAttachments([fixture.attachment, fixture.attachment], fetcher),
      null,
    );
  }
});

test("oversized streamed bodies are canceled before accepting a fingerprint", async () => {
  const fixture = imageFixture();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(fixture.bytes.byteLength + 1));
    },
    cancel() {
      canceled = true;
    },
  });
  const fetcher = (async () => new Response(body)) as typeof fetch;
  assert.equal(await fingerprintImageAttachments([fixture.attachment], fetcher), null);
  assert.equal(canceled, true);
});

test("concurrency is capped without queued downloads and capacity is restored", async () => {
  const fixture = imageFixture();
  const release: Array<() => void> = [];
  const fetcher = (async () => {
    await new Promise<void>((resolve) => release.push(resolve));
    return new Response(new Uint8Array(fixture.bytes));
  }) as typeof fetch;
  const running = Array.from({ length: 4 }, () =>
    fingerprintImageAttachments([fixture.attachment], fetcher),
  );
  assert.equal(await fingerprintImageAttachments([fixture.attachment], fetcher), null);
  assert.equal(release.length, 4);
  for (const resolve of release) resolve();
  assert.ok((await Promise.all(running)).every(Boolean));
  assert.ok(await fingerprintImageAttachments([fixture.attachment], fixtureFetch([fixture])));
});

test("a stalled CDN request aborts at the per-message deadline and releases capacity", async () => {
  const fixture = imageFixture();
  let aborted = false;
  const fetcher = (async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    })) as typeof fetch;
  assert.equal(await fingerprintImageAttachments([fixture.attachment], fetcher), null);
  assert.equal(aborted, true);
  assert.ok(await fingerprintImageAttachments([fixture.attachment], fixtureFetch([fixture])));
});
