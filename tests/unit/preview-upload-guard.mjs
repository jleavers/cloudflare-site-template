// Preloaded with `node --import` into each process of a wrangler run in preview-upload.test.ts (the
// wrangler CLI spreads its own execArgv into the process it starts, so that one gets it too). It
// writes one JSON line for every socket connection and DNS lookup the process attempts to
// $PREVIEW_UPLOAD_NET_LOG, and throws for any destination but 127.0.0.1, so that the run can reach
// nothing off this machine. A request wrangler sends through its proxy variables lands on the
// test's loopback proxy, which refuses it and records the host it asked for.
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import net from 'node:net';

const log = process.env.PREVIEW_UPLOAD_NET_LOG;
if (!log) throw new Error('preview-upload-guard: PREVIEW_UPLOAD_NET_LOG is not set');
const record = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);

// net.connect, tls.connect and every HTTP client in Node, undici's included, end here.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let [first, second] = args;
  if (Array.isArray(first)) [first, second] = first; // the [options, callback] pair net.connect hands on
  let target;
  if (first !== null && typeof first === 'object') target = first.path !== undefined ? { path: String(first.path) } : { host: String(first.host ?? 'localhost'), port: Number(first.port) };
  else if (typeof first === 'number' || /^\d+$/.test(String(first))) target = { host: typeof second === 'string' ? second : 'localhost', port: Number(first) };
  else target = { path: String(first) };
  record({ connect: target });
  if (target.host !== '127.0.0.1') throw new Error(`preview-upload-guard: refused a connection to ${JSON.stringify(target)}`);
  return connect.apply(this, args);
};

/** @param {(hostname: unknown, ...rest: unknown[]) => unknown} lookup */
const guardLookup = (lookup) =>
  function guardedLookup(hostname, ...rest) {
    record({ lookup: String(hostname) });
    if (hostname !== '127.0.0.1') throw new Error(`preview-upload-guard: refused a lookup of ${String(hostname)}`);
    return lookup.call(this, hostname, ...rest);
  };
dns.lookup = guardLookup(dns.lookup);
dns.promises.lookup = guardLookup(dns.promises.lookup);
