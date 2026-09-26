import * as assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { packageExtension } from "../task/pack-extension";

// Read the length-delimited fields used by the CRX3 header independently of the packager.
function fields(data: Buffer): Map<number, Buffer> {
  let offset = 0;
  const result = new Map<number, Buffer>();
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      assert.ok(offset < data.length);
      const byte = data[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    throw new Error("Invalid CRX3 header varint");
  };
  while (offset < data.length) {
    const tag = varint();
    assert.equal(tag & 7, 2);
    const length = varint();
    assert.ok(offset + length <= data.length);
    result.set(tag >>> 3, data.subarray(offset, offset + length));
    offset += length;
  }
  return result;
}

function verifyCrx(crx: Buffer, zip: Buffer, extensionId: string): void {
  assert.equal(crx.toString("ascii", 0, 4), "Cr24");
  assert.equal(crx.readUInt32LE(4), 3);
  const headerEnd = 12 + crx.readUInt32LE(8);
  const header = fields(crx.subarray(12, headerEnd));
  const proof = fields(header.get(2)!);
  const publicKey = proof.get(1)!;
  const signature = proof.get(2)!;
  const signedData = header.get(10000)!;
  const id = createHash("sha256").update(publicKey).digest().subarray(0, 16);
  assert.deepEqual(fields(signedData).get(1), id);
  assert.equal(extensionId, Array.from(id).map((byte) =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join(""));
  assert.deepEqual(crx.subarray(headerEnd), zip, "ZIP must be exactly the archive signed in the CRX");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedData.length);
  const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0"), size, signedData, zip]);
  const key = createPublicKey({ key: publicKey, type: "spki", format: "der" });
  assert.ok(verify("sha256", payload, key, signature), "CRX signature must be valid");
  payload[payload.length - 1] ^= 1;
  assert.equal(verify("sha256", payload, key, signature), false, "Changes must invalidate the signature");
}

function zipEntries(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const nameLength = zip.readUInt16LE(offset + 28);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    const local = zip.readUInt32LE(offset + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressed = zip.subarray(start, start + zip.readUInt32LE(offset + 20));
    assert.ok(method === 0 || method === 8);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(data.length, zip.readUInt32LE(offset + 24));
    assert.equal(crc32(data), zip.readUInt32LE(offset + 16));
    assert.equal(entries.has(name), false, "ZIP entries must not be duplicated");
    entries.set(name, data);
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  return entries;
}

export async function verifyPackaging(extensionRoot: string): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "json-formatter-package-"));
  try {
    const sourceDirectory = path.join(temporary, "dist");
    await cp(extensionRoot, sourceDirectory, { recursive: true });
    const options = {
      sourceDirectory,
      outputDirectory: path.join(temporary, "release"),
      keyPath: path.join(temporary, ".keys", "signing.pem"),
      createKey: true
    };
    const first = await packageExtension(options);
    assert.equal(first.createdKey, true);
    const keyHash = createHash("sha256").update(await readFile(first.keyPath)).digest("hex");
    const crx = await readFile(first.crxPath);
    const zip = await readFile(first.zipPath);
    verifyCrx(crx, zip, first.extensionId);
    const entries = zipEntries(zip);
    assert.ok(entries.has("manifest.json"), "The manifest must be at the archive root");
    const sourceFiles = (await readdir(sourceDirectory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(sourceDirectory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    assert.deepEqual([...entries.keys()].sort(), sourceFiles.sort());
    for (const [name, data] of entries) {
      assert.deepEqual(data, await readFile(path.join(sourceDirectory, name)));
      assert.doesNotMatch(name, /(?:^|\/)(?:\.keys|node_modules|tests)(?:\/|$)|\.(?:pem|key|ts|map)$/);
    }

    const second = await packageExtension({ ...options, createKey: false });
    assert.equal(second.createdKey, false);
    assert.equal(second.extensionId, first.extensionId);
    assert.equal(createHash("sha256").update(await readFile(first.keyPath)).digest("hex"), keyHash);
    assert.deepEqual(await readFile(second.crxPath), crx, "Repackaging must preserve the signed artifact");
    assert.deepEqual(await readFile(second.zipPath), zip);
    assert.deepEqual((await readdir(options.outputDirectory)).sort(),
      [path.basename(first.crxPath), path.basename(first.zipPath)].sort());

    await assert.rejects(packageExtension({ ...options, keyPath: path.join(temporary, "missing.pem"), createKey: false }), /Signing key is missing/);
    await rename(first.keyPath, `${first.keyPath}.backup`);
    await assert.rejects(packageExtension(options), /Restore the original key/);
    await writeFile(first.keyPath, "not a private key");
    await assert.rejects(packageExtension(options), /Invalid signing key/);
    assert.equal(await readFile(first.keyPath, "utf8"), "not a private key");
    await rename(`${first.keyPath}.backup`, first.keyPath);
    await assert.rejects(packageExtension({ ...options, keyPath: path.join(sourceDirectory, "signing.pem") }), /must be separate/);
    await assert.rejects(packageExtension({ ...options, keyPath: path.join(options.outputDirectory, "signing.pem") }), /must be separate/);
    await writeFile(path.join(sourceDirectory, "accidental.pem"), "must not ship");
    await assert.rejects(packageExtension(options), /Refusing to package/);
    assert.deepEqual(await readFile(first.crxPath), crx, "Failed packaging must leave the previous release intact");
    console.log("Packaging tests passed: archive contents, CRX3 signature, stable identity, and key protection.");
  } finally {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("json-formatter-package-"));
    await rm(temporary, { recursive: true, force: true });
  }
}
