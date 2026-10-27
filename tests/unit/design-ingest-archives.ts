// In-memory zip and tar writers for tests/unit/design-ingest.test.ts. Every fixture, good or
// hostile, is built here at test time, so no binary archive is committed. Each override exists to
// write one shape the ingest tool must refuse.
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

const encoder = new TextEncoder();
const bytes = (value: string | Uint8Array = '') => Buffer.from(typeof value === 'string' ? encoder.encode(value) : value);

export interface ZipEntry {
  /** A string is written as UTF-8; bytes are written as they are. A directory's name ends in `/`. */
  name: string | Uint8Array;
  data?: string | Uint8Array;
  /** 0 stored (the default), 8 deflate, or any other method number, written as it is. */
  method?: number;
  /** General-purpose bits, added to the UTF-8 and data-descriptor bits. */
  flags?: number;
  /** Bit 11. By default it is set for a string name with a non-ASCII character. */
  utf8?: boolean;
  /** The external attributes' high 16 bits, from a Unix host (made-by 3). */
  unixMode?: number;
  /** Written instead of the data's CRC-32, in both headers. */
  crc?: number;
  /** Written instead of the uncompressed size, in both headers. */
  size?: number;
  /** Written instead of the compressed size, in both headers. */
  compressedSize?: number;
  /** Compressed bytes written as they are, instead of compressing `data`. */
  compressed?: Uint8Array;
  /** A local-header name that differs from the central directory's. */
  localName?: string;
  /** A local-header method that differs from the central directory's. */
  localMethod?: number;
  /** Local-header general-purpose bits that differ from the central directory's. */
  localFlags?: number;
  /** Written in the data descriptor instead of the CRC the headers carry. */
  descriptorCrc?: number;
  /** The central record points at this offset, and no local header is written for the entry. */
  at?: number;
  /** Bit 3: the local header carries no CRC or sizes; a signed data descriptor follows the data. */
  descriptor?: boolean;
  /** The central record's disk number. */
  disk?: number;
}

export interface ZipOptions {
  /** The end record's disk numbers. */
  disk?: number;
  /** The end record's entry counts, instead of the real count. */
  count?: number;
  /** Write a zip64 end-of-central-directory locator before the end record. */
  zip64Locator?: boolean;
}

export function zip(entries: ZipEntry[], options: ZipOptions = {}): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  entries.forEach((entry, index) => {
    const name = bytes(entry.name);
    const data = bytes(entry.data);
    const method = entry.method ?? 0;
    const body = entry.compressed ? Buffer.from(entry.compressed) : method === 8 ? deflateRawSync(data) : data;
    const crc = (entry.crc ?? crc32(data)) >>> 0;
    const size = entry.size ?? data.length;
    const compressedSize = entry.compressedSize ?? body.length;
    const utf8 = entry.utf8 ?? (typeof entry.name === 'string' && /[^\x00-\x7f]/.test(entry.name));
    const flags = (entry.flags ?? 0) | (utf8 ? 0x800 : 0) | (entry.descriptor ? 0x8 : 0);
    offsets.push(entry.at ?? offset);
    if (entry.at === undefined) {
      const localName = entry.localName === undefined ? name : bytes(entry.localName);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(entry.localFlags ?? flags, 6);
      local.writeUInt16LE(entry.localMethod ?? method, 8);
      if (!entry.descriptor) {
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressedSize, 18);
        local.writeUInt32LE(size, 22);
      }
      local.writeUInt16LE(localName.length, 26);
      const parts = [local, localName, body];
      if (entry.descriptor) {
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE((entry.descriptorCrc ?? crc) >>> 0, 4);
        descriptor.writeUInt32LE(compressedSize, 8);
        descriptor.writeUInt32LE(size, 12);
        parts.push(descriptor);
      }
      const record = Buffer.concat(parts);
      locals.push(record);
      offset += record.length;
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(entry.disk ?? 0, 34);
    central.writeUInt32LE(((entry.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offsets[index]!, 42);
    centrals.push(Buffer.concat([central, name]));
  });
  const directory = Buffer.concat(centrals);
  const parts = [...locals, directory];
  if (options.zip64Locator) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(1, 16);
    parts.push(locator);
  }
  const end = Buffer.alloc(22);
  const count = options.count ?? entries.length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.disk ?? 0, 4);
  end.writeUInt16LE(options.disk ?? 0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  parts.push(end);
  return new Uint8Array(Buffer.concat(parts));
}

export interface TarEntry {
  /** The header's name field (at most 100 bytes). A string is written as UTF-8. */
  name: string | Uint8Array;
  /** The typeflag: '0' by default, '5' a directory, 'x' pax, 'L' GNU long name, and so on. */
  type?: string;
  data?: string | Uint8Array;
  mode?: number;
  linkname?: string;
  /** The POSIX ustar prefix field, joined to the name with a `/`. */
  prefix?: string;
  /** Written instead of the data's length. */
  size?: number;
  /** Written instead of the header's real checksum. */
  checksum?: number;
  /** GNU magic (`ustar  \0`) instead of POSIX (`ustar\0` `00`); `none` writes a v7 header with no magic. */
  magic?: 'posix' | 'gnu' | 'none';
}

const octal = (header: Buffer, at: number, width: number, value: number) =>
  header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, at, width, 'latin1');

export function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512);
  const name = bytes(entry.name);
  if (name.length > 100) throw new Error('a tar header name is at most 100 bytes: use pax() or longName()');
  name.copy(header, 0);
  octal(header, 100, 8, entry.mode ?? 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, entry.size ?? bytes(entry.data).length);
  octal(header, 136, 12, 0);
  bytes(entry.type ?? '0').copy(header, 156);
  if (entry.linkname) bytes(entry.linkname).copy(header, 157);
  const magic = entry.magic ?? 'posix';
  if (magic === 'posix') header.write('ustar\u000000', 257, 'latin1');
  if (magic === 'gnu') header.write('ustar  \u0000', 257, 'latin1');
  if (entry.prefix) bytes(entry.prefix).copy(header, 345);
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${(entry.checksum ?? sum).toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

/** An uncompressed tar: each header, its data padded to 512 bytes, then two zero blocks unless `end` is false. */
export function tar(entries: TarEntry[], { end = true, trailing }: { end?: boolean; trailing?: Uint8Array } = {}): Uint8Array<ArrayBuffer> {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = bytes(entry.data);
    blocks.push(tarHeader(entry), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (end) blocks.push(Buffer.alloc(1024));
  if (trailing) blocks.push(Buffer.from(trailing));
  return new Uint8Array(Buffer.concat(blocks));
}

export const tgz = (entries: TarEntry[], options?: Parameters<typeof tar>[1]): Uint8Array<ArrayBuffer> => new Uint8Array(gzipSync(tar(entries, options)));

/** A pax extended header ('x') carrying these records for the entry that follows it, or a global one ('g'), named as git archive names it. */
export function pax(records: Record<string, string>, type: 'x' | 'g' = 'x'): TarEntry {
  let text = '';
  for (const [key, value] of Object.entries(records)) {
    const body = Buffer.byteLength(` ${key}=${value}\n`);
    let length = body + String(body).length;
    if (String(length).length + body !== length) length = body + String(length).length;
    text += `${length} ${key}=${value}\n`;
  }
  return { name: type === 'g' ? 'pax_global_header' : 'PaxHeader/entry', type, data: text };
}

/** A GNU long-name header ('L') naming the entry that follows it. */
export const longName = (name: string): TarEntry => ({ name: '././@LongLink', type: 'L', data: `${name}\0`, magic: 'gnu' });
