import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";
import {
  getDefaultAutoSelectFamily,
  setDefaultAutoSelectFamily,
  type AddressInfo,
  type LookupFunction,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentFeedReader } from "../src/community-tools/feeds";

test("default feed transport connects with automatic family selection and retains DNS pinning and redirect checks", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "haf-feed-tls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=feed.example",
      "-addext",
      "subjectAltName=DNS:feed.example",
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath);
  const serverNames: string[] = [];
  let requests = 0;
  let redirect = false;
  const server = https.createServer({ key: readFileSync(keyPath), cert }, (_request, response) => {
    requests++;
    if (redirect) {
      response.writeHead(302, { location: "https://blocked.example/feed.xml" });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/rss+xml" });
      response.end(
        "<rss><item><guid>patch-1</guid><title>New patch</title><link>https://game.example/patch</link></item></rss>",
      );
    }
  });
  server.on("secureConnection", (socket) => serverNames.push(socket.servername || ""));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const autoSelect = getDefaultAutoSelectFamily();
  setDefaultAutoSelectFamily(true);
  t.after(() => setDefaultAutoSelectFamily(autoSelect));
  const resolvedHosts: string[] = [];
  t.mock.method(dns, "lookup", (async (hostname: string) => {
    resolvedHosts.push(hostname);
    return [{ address: hostname === "blocked.example" ? "127.0.0.1" : "8.8.8.8", family: 4 }];
  }) as unknown as typeof dns.lookup);

  const realRequest = https.request;
  const pinnedAddresses: string[] = [];
  t.mock.method(https, "request", ((
    url: URL,
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => {
    const pinnedLookup = options.lookup;
    assert.ok(pinnedLookup);
    const routeToFixture: LookupFunction = (hostname, lookupOptions, callback) => {
      pinnedLookup(hostname, lookupOptions, (error, address, family) => {
        if (error) return callback(error, address, family);
        // Route the approved public address to the local TLS fixture while
        // preserving exactly the callback shape Node requested and received.
        if (Array.isArray(address)) {
          pinnedAddresses.push(...address.map((item) => item.address));
          callback(
            null,
            address.map((item) => ({ ...item, address: "127.0.0.1" })),
          );
        } else {
          pinnedAddresses.push(address);
          callback(null, "127.0.0.1", family);
        }
      });
    };
    return realRequest(
      url,
      { ...options, lookup: routeToFixture, port, ca: cert, agent: false },
      onResponse,
    );
  }) as typeof https.request);

  const reader = new ContentFeedReader();
  const feed = {
    id: "patches",
    enabled: true,
    name: "Patches",
    provider: "rss" as const,
    source: "https://feed.example/feed.xml",
    channelId: "100",
    notifyRoleIds: [],
  };
  assert.deepEqual(await reader.read(feed), [
    { id: "patch-1", title: "New patch", url: "https://game.example/patch" },
  ]);
  assert.deepEqual(pinnedAddresses, ["8.8.8.8"]);
  assert.deepEqual(serverNames, ["feed.example"]);
  redirect = true;
  await assert.rejects(() => reader.read(feed), /only to public IPv4 addresses/);
  assert.deepEqual(resolvedHosts, ["feed.example", "feed.example", "blocked.example"]);
  assert.equal(requests, 2, "the redirect to a private address must not connect");
});
