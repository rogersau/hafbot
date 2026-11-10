import { PNG } from "pngjs";

// Locally generated solid-color tiles: no real people, destinations, QR codes or victim data.
export function imageFixture(index = 0, upload = 1, deflateLevel = 9) {
  const png = new PNG({ width: 4, height: 4 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set([index * 40, 80, 120, 255], offset);
  }
  const bytes = PNG.sync.write(png, { deflateLevel });
  return {
    bytes,
    attachment: {
      id: String(upload * 10 + index),
      filename: `harmless-tile-${upload}-${index}.png`,
      content_type: "image/png",
      size: bytes.byteLength,
      url: `https://cdn.discordapp.com/attachments/123/${upload * 10 + index}/tile-${upload}.png?ex=${upload}`,
    },
  };
}

export function fixtureFetch(fixtures: ReturnType<typeof imageFixture>[]): typeof fetch {
  const files = new Map(fixtures.map((fixture) => [fixture.attachment.url, fixture.bytes]));
  return (async (input: RequestInfo | URL) => {
    const bytes = files.get(String(input));
    if (!bytes) throw new Error("Unexpected fixture URL; no network permitted.");
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
    });
  }) as typeof fetch;
}
