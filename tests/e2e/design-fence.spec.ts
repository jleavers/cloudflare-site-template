import { createSocket } from 'node:dgram';
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { shootDesign } from '../../tools/screenshots/design.mjs';

// A hostile design screen against the confined renderer (tools/screenshots/design.mjs), in a real
// Chromium. Its script tries every way out it can: files outside its bundle, an HTTP, WebSocket
// and UDP listener on loopback (standing in for the operator's machine, LAN and the internet),
// and a service worker. Nothing here touches a remote network. The site stack this suite starts
// is not used.

const SECRET = 'fake-probe-value';
let root = '';
let bundle = '';
let outsideUrl = '';
const made: string[] = [];
const write = (path: string, content: string) => {
  for (let dir = dirname(path); !made.includes(dir) && dir !== root; dir = dirname(dir)) {
    mkdirSync(dir, { recursive: true });
    made.push(dir);
  }
  writeFileSync(path, content);
  made.push(path);
};

// A fresh bundle, with its own stylesheet and script in a sibling folder of the screens, and a
// fake secret outside it.
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'design-fence-'));
  bundle = join(root, 'bundle');
  write(join(root, 'outside-secret.txt'), `${SECRET}\n`);
  write(join(bundle, 'assets', 'own.css'), 'h1 { color: rgb(1, 2, 3); }\n');
  write(join(bundle, 'assets', 'own.js'), 'document.documentElement.dataset.own = "ran";\n');
  outsideUrl = pathToFileURL(join(root, 'outside-secret.txt')).href;
});

// Removes exactly what this file made, deepest first.
test.afterAll(() => {
  for (const path of [...made].sort((a, b) => b.length - a.length)) {
    try {
      unlinkSync(path);
    } catch {
      rmdirSync(path);
    }
  }
  rmdirSync(root);
});

/** Listeners on loopback that count every connection, request, upgrade and datagram. */
async function listen() {
  const heard: string[] = [];
  const http = createServer((request, response) => {
    heard.push(`http ${request.method} ${request.url}`);
    response.end('reached');
  });
  http.on('connection', () => heard.push('tcp connection'));
  http.on('upgrade', (request, socket) => {
    heard.push(`websocket ${request.url}`);
    socket.destroy();
  });
  http.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const udp = createSocket('udp4');
  udp.on('message', (message) => heard.push(`udp ${message.length} bytes`));
  await new Promise<void>((done) => udp.bind(0, '127.0.0.1', done));
  return {
    heard,
    port: (http.address() as AddressInfo).port,
    udpPort: udp.address().port,
    close: async () => {
      http.closeAllConnections();
      await new Promise((done) => http.close(done));
      await new Promise<void>((done) => udp.close(() => done()));
    },
  };
}

function hostileScreen(port: number, udpPort: number) {
  const server = `http://127.0.0.1:${port}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>@import url("${server}/import.css"); body { background-image: url("${server}/background.png"); }</style>
<link rel="stylesheet" href="../assets/own.css">
<link rel="stylesheet" href="${server}/style.css">
<link rel="prefetch" href="${server}/prefetch">
<link rel="preconnect" href="${server}">
</head><body><h1>A hostile screen</h1>
<img src="${server}/image.png" alt="">
<iframe src="${server}/frame"></iframe>
<iframe src="../../outside-secret.txt"></iframe>
<iframe src="${outsideUrl}"></iframe>
<iframe src="navigate.html"></iframe>
<pre id="log"></pre>
<script src="../assets/own.js"></script>
<script>
const log = [];
const note = (what, result) => {
  log.push(what + ': ' + result);
  document.getElementById('log').textContent = log.join('\\n');
};
const attempt = async (what, run) => {
  try {
    note(what, String(await Promise.race([run(), new Promise((_, fail) => setTimeout(() => fail(new Error('timeout')), 3000))])).slice(0, 300));
  } catch (error) {
    note(what, 'failed: ' + (error && error.message));
  }
};
const xhr = (url) => new Promise((done, fail) => {
  const request = new XMLHttpRequest();
  request.open('GET', url);
  request.onload = () => done(request.status + ' ' + request.responseText);
  request.onerror = () => fail(new Error('error'));
  request.send();
});
const opened = (thing) => new Promise((done, fail) => {
  thing.onopen = () => done('open');
  thing.onerror = () => fail(new Error('error'));
  thing.onclose = () => fail(new Error('closed'));
});
(async () => {
  await attempt('fetch the secret, relative', async () => (await fetch('../../outside-secret.txt')).text());
  await attempt('fetch the secret, absolute', async () => (await fetch(${JSON.stringify(outsideUrl)})).text());
  await attempt('XHR the secret, relative', () => xhr('../../outside-secret.txt'));
  await attempt('XHR the secret, absolute', () => xhr(${JSON.stringify(outsideUrl)}));
  await attempt('fetch http', async () => (await fetch('${server}/fetch')).text());
  await attempt('fetch https', async () => (await fetch('https://127.0.0.1:${port}/fetch')).text());
  await attempt('sendBeacon', () => navigator.sendBeacon('${server}/beacon', 'x'));
  await attempt('EventSource', () => opened(new EventSource('${server}/events')));
  await attempt('WebSocket', () => opened(new WebSocket('ws://127.0.0.1:${port}/socket')));
  await attempt('a worker\\'s fetch and WebSocket', () => new Promise((done, fail) => {
    const code = "fetch('${server}/worker-fetch').catch(() => {}); try { new WebSocket('ws://127.0.0.1:${port}/worker-socket'); } catch {} postMessage('started');";
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    worker.onmessage = (event) => setTimeout(() => done(event.data), 1000);
    worker.onerror = () => fail(new Error('error'));
  }));
  await attempt('service worker', () => navigator.serviceWorker.register('sw.js'));
  await attempt('window.open', () => String(window.open('${server}/popup')));
  await attempt('WebRTC to a STUN server', async () => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
    peer.createDataChannel('probe');
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise((done) => {
      peer.onicegatheringstatechange = () => peer.iceGatheringState === 'complete' && done();
      setTimeout(done, 3000);
    });
    const candidates = peer.localDescription.sdp.split('\\r\\n').filter((line) => line.startsWith('a=candidate'));
    peer.close();
    return candidates.length + ' candidate(s) ' + candidates.join(' | ');
  });
  document.title = 'done';
})();
</script></body></html>`;
}

/** Everything the screen's frames hold once its script has finished, read through the browser. */
async function readBack(page: Page) {
  await page.waitForFunction(() => document.title === 'done', null, { timeout: 60_000 });
  await page.waitForTimeout(500);
  const frames = await Promise.all(page.frames().map(async (frame) => `${frame.url()}\n${await frame.content().catch(() => '')}`));
  const own = await page.evaluate(() => ({ script: document.documentElement.dataset.own, colour: getComputedStyle(document.querySelector('h1')!).color }));
  return { log: await page.locator('#log').textContent(), title: await page.title(), frames, own };
}

const isPng = (png: Buffer, width: number) => png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === width;

test('a design screen reaches nothing but its own bundle', async () => {
  test.setTimeout(90_000);
  const listener = await listen();
  try {
    const screen = join(bundle, 'project', 'screen.html');
    write(screen, hostileScreen(listener.port, listener.udpPort));
    write(join(bundle, 'project', 'navigate.html'), `<script>location.href = 'http://127.0.0.1:${listener.port}/navigate';</script>`);
    let seen: Awaited<ReturnType<typeof readBack>> | undefined;
    // The screen's assets are in a sibling folder, so the bundle is named.
    const png = await shootDesign(screen, { bundle, width: 800, height: 600, inspect: async (page) => void (seen = await readBack(page)) });
    await new Promise((wait) => setTimeout(wait, 500));

    expect(listener.heard, `the screen's log:\n${seen?.log}`).toEqual([]);
    expect(isPng(png, 800)).toBe(true);
    expect(seen?.title).toBe('done');
    for (const frame of seen?.frames ?? []) expect(frame).not.toContain(SECRET);
    expect(seen?.log).not.toContain(SECRET);
    // The bundle's own files still load.
    expect(seen?.own).toEqual({ script: 'ran', colour: 'rgb(1, 2, 3)' });
  } finally {
    await listener.close();
  }
});

test('a screen that navigates itself to the network reaches nothing', async () => {
  const listener = await listen();
  try {
    const screen = join(bundle, 'away', 'screen.html');
    write(screen, `<!doctype html><title>away</title><h1>Leaving</h1>
<script>addEventListener('load', () => setTimeout(() => { location.href = 'http://127.0.0.1:${listener.port}/away'; }, 50));</script>`);
    const png = await shootDesign(screen, { bundle, width: 640, height: 480, inspect: (page) => page.waitForTimeout(1000) });
    await new Promise((wait) => setTimeout(wait, 500));
    expect(listener.heard).toEqual([]);
    expect(isPng(png, 640)).toBe(true);
  } finally {
    await listener.close();
  }
});

test('by default the bundle is the screen\'s own folder, which must hold the screen', async () => {
  const screen = join(bundle, 'alone', 'screen.html');
  write(screen, `<!doctype html><title>alone</title><h1>Alone</h1><script src="../assets/own.js"></script>`);
  let own: string | undefined = 'unread';
  await shootDesign(screen, { inspect: async (page) => void (own = await page.evaluate(() => document.documentElement.dataset.own)) });
  expect(own, 'a file beside the screen\'s folder loaded without --bundle').toBeUndefined();
  await expect(shootDesign(join(root, 'outside-secret.txt'), { bundle })).rejects.toThrow(/not inside the bundle/);
});
