import test from "node:test";
import assert from "node:assert/strict";
import { asBlob, lastSegment } from "../../apps/web/src/lib/blob-util.ts";

/**
 * The two pure helpers on the bytes path.
 *
 * The rest of that path - a Blob crossing `postMessage`, XHR upload progress,
 * handing a file to the browser to save - only exists in a browser and is not
 * reachable from here. These two are the parts that decide what an app is
 * *allowed to hand over*, and they run before anything touches the network.
 */

test("asBlob accepts the shapes an app actually has", () => {
  // A File from an <input>, a Blob from a canvas, an ArrayBuffer from fetch, a
  // typed array from anything that does maths.
  assert.equal(asBlob(new Blob(["hi"])).size, 2);
  assert.equal(asBlob(new Uint8Array([1, 2, 3])).size, 3);
  assert.equal(asBlob(new Uint8Array([1, 2, 3]).buffer).size, 3);
  assert.equal(asBlob(new Uint16Array([1, 2, 3])).size, 6);
  assert.equal(asBlob(new DataView(new ArrayBuffer(8))).size, 8);
  assert.equal(asBlob(new Blob([])).size, 0);
});

test("asBlob preserves the bytes exactly", async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
  const back = new Uint8Array(await asBlob(bytes).arrayBuffer());
  assert.deepEqual([...back], [...bytes]);
});

test("asBlob refuses anything else, with a message an app author can act on", () => {
  for (const bad of [null, undefined, 42, "a string", {}, [], true]) {
    assert.throws(
      () => asBlob(bad),
      /Blob, File, ArrayBuffer or typed array/,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

test("lastSegment names the file for the upload", () => {
  assert.equal(lastSegment("media/holiday.jpg"), "holiday.jpg");
  assert.equal(lastSegment("/a/b/c.bin"), "c.bin");
  assert.equal(lastSegment("solo.txt"), "solo.txt");
  assert.equal(lastSegment("trailing/slash/"), "slash");
  // Never empty: a multipart part with no filename is not a file upload.
  assert.equal(lastSegment(""), "download");
  assert.equal(lastSegment("/"), "download");
  assert.equal(lastSegment("///"), "download");
});
