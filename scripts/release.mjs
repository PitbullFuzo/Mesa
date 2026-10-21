// Release helpers (plain Node, no dependencies): the version bump and the zip writer.
import { deflateRawSync } from 'node:zlib';

const SEMVER = /^\d+\.\d+\.\d+$/;

/** manifest.json, package.json and versions.json for a new version, as text. Throws on a bad version. */
export function bumpedFiles(version, { manifest, pkg, versions }) {
  if (!SEMVER.test(version))
    throw new Error(`"${version}" is not a version like 1.2.3.`);
  const manifestJson = JSON.parse(manifest);
  const packageJson = JSON.parse(pkg);
  const versionsJson = JSON.parse(versions);
  if (versionsJson[version] !== undefined)
    throw new Error(`Version ${version} is already in versions.json.`);
  manifestJson.version = version;
  packageJson.version = version;
  // versions.json maps each plugin version to the oldest Obsidian that runs it.
  versionsJson[version] = manifestJson.minAppVersion;
  const text = (value) => JSON.stringify(value, null, 2) + '\n';
  return {
    manifest: text(manifestJson),
    pkg: text(packageJson),
    versions: text(versionsJson),
  };
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip file (deflate) holding exactly these `{ name, data }` entries, in this order. */
export function makeZip(entries) {
  // A fixed timestamp keeps the zip identical for identical files (1980-01-01).
  const time = 0,
    date = (1 << 5) | 1;
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
