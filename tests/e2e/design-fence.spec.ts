import { createSocket } from 'node:dgram';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { shootDesign } from '../../tools/screenshots/design.mjs';

// A hostile design screen against the confined renderer (tools/screenshots/design.mjs), in a real
// Chromium. Its script tries every way out it can: files outside its bundle, and an HTTP, WebSocket
// and UDP listener on loopback (standing in for the operator's machine, LAN and the internet). It
// runs behind the renderer's dead proxy, and again behind a live one that counts what reaches it,
// so the renderer is shown not to depend on its proxy staying dead. Nothing here touches a remote
// network. The site stack this suite starts is not used.

const SECRET = 'fake-probe-value';
let root = '';
let bundle = '';
let outsideUrl = '';
let outsideScriptUrl = '';
const made: string[] = [];
const write = (path: string, content: string) => {
  for (let dir = dirname(path); !made.includes(dir) && dir !== root; dir = dirname(dir)) {
    mkdirSync(dir, { recursive: true });
    made.push(dir);
  }
  writeFileSync(path, content);
  made.push(path);
};

// A fresh bundle, with its own stylesheet and script in a sibling folder of the screens, and two
// fake secrets outside it: a text file, and a file that is valid JavaScript.
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'design-fence-'));
  bundle = join(root, 'bundle');
  write(join(root, 'outside-secret.txt'), `${SECRET}\n`);
  write(join(root, 'outside-script.js'), `var SECRET_VALUE = "${SECRET}";\n`);
  write(join(bundle, 'assets', 'own.css'), 'h1 { color: rgb(1, 2, 3); }\n');
  write(join(bundle, 'assets', 'own.js'), 'document.documentElement.dataset.own = "ran";\n');
  outsideUrl = pathToFileURL(join(root, 'outside-secret.txt')).href;
  outsideScriptUrl = pathToFileURL(join(root, 'outside-script.js')).href;
});

// Removes exactly what this file made, deepest first. Each removal stands alone, so one entry
// that will not go cannot strand the rest.
test.afterAll(() => {
  for (const path of [...new Set(made)].sort((a, b) => b.length - a.length).concat(root)) {
    try {
      if (lstatSync(path).isDirectory()) rmdirSync(path);
      else unlinkSync(path);
    } catch {
      // already gone, or not empty: leave it and carry on
    }
  }
});

/** Listeners on loopback that count every connection, request, upgrade and datagram, and a proxy that counts what reaches it. */
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
  const proxy = createServer((request, response) => {
    heard.push(`proxy ${request.method} ${request.url}`);
    response.destroy();
  });
  proxy.on('connection', () => heard.push('proxy connection'));
  proxy.on('connect', (request, socket) => {
    heard.push(`proxy CONNECT ${request.url}`);
    socket.destroy();
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  for (const server of [http, proxy]) await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const udp = createSocket('udp4');
  udp.on('message', (message) => heard.push(`udp ${message.length} bytes`));
  await new Promise<void>((done) => udp.bind(0, '127.0.0.1', done));
  return {
    heard,
    port: (http.address() as AddressInfo).port,
    proxyPort: (proxy.address() as AddressInfo).port,
    udpPort: udp.address().port,
    close: async () => {
      for (const server of [http, proxy]) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      await new Promise<void>((done) => udp.close(() => done()));
    },
  };
}

function hostileScreen(port: number, udpPort: number) {
  const server = `http://127.0.0.1:${port}`;
  const speculation = { prefetch: [{ source: 'list', urls: [`${server}/speculative-prefetch`] }], prerender: [{ source: 'list', urls: [`${server}/speculative-prerender`] }] };
  return `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>@import url("${server}/import.css"); body { background-image: url("${server}/background.png"); }</style>
<link rel="stylesheet" href="../assets/own.css">
<link rel="stylesheet" href="${server}/style.css">
<link rel="prefetch" href="${server}/prefetch">
<link rel="preconnect" href="${server}">
<script type="speculationrules">${JSON.stringify(speculation)}</script>
<script src="../../outside-script.js"></script>
<script src="${outsideScriptUrl}"></script>
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
  note('an outside script', typeof SECRET_VALUE === 'undefined' ? 'did not run' : SECRET_VALUE);
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
  await attempt('WebTransport', async () => {
    const transport = new WebTransport('https://127.0.0.1:${udpPort}/');
    await transport.ready;
    return 'ready';
  });
  await attempt('service worker', () => navigator.serviceWorker.register('sw.js'));
  await attempt('window.open', () => String(window.open('${server}/popup')));
  await attempt('WebRTC to a STUN server', async () => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }] });
    peer.createDataChannel('probe');
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise((done) => {
      peer.onicegatheringstatechange = () => peer.iceGatheringState === 'complete' && done();
      setTimeout(done, 2500);
    });
    const candidates = peer.localDescription.sdp.split('\\r\\n').filter((line) => line.startsWith('a=candidate'));
    peer.close();
    return candidates.length + ' candidate(s) ' + candidates.join(' | ');
  });
  // An ICE-TCP connection: a made-up answer whose only candidate is the HTTP listener, over TCP.
  await attempt('ICE-TCP to the HTTP listener', async () => {
    const peer = new RTCPeerConnection();
    peer.createDataChannel('probe');
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answer = offer.sdp
      .split('\\r\\n')
      .filter((line) => !line.startsWith('a=candidate') && !line.startsWith('a=end-of-candidates'))
      .join('\\r\\n')
      .replace(/a=setup:actpass/g, 'a=setup:active')
      .replace(/a=ice-ufrag:.*/g, 'a=ice-ufrag:prob')
      .replace(/a=ice-pwd:.*/g, 'a=ice-pwd:probeprobeprobeprobeprob');
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    await peer.addIceCandidate({ candidate: 'candidate:1 1 tcp 2122260223 127.0.0.1 ${port} typ host tcptype passive', sdpMid: '0', sdpMLineIndex: 0 });
    await new Promise((done) => setTimeout(done, 2000));
    const state = peer.iceConnectionState;
    peer.close();
    return state;
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

for (const proxy of ['dead', 'live'] as const) {
  test(`a design screen reaches nothing but its own bundle, behind a ${proxy} proxy`, async () => {
    test.setTimeout(90_000);
    const listener = await listen();
    try {
      const screen = join(bundle, proxy, 'screen.html');
      write(screen, hostileScreen(listener.port, listener.udpPort));
      write(join(bundle, proxy, 'navigate.html'), `<script>location.href = 'http://127.0.0.1:${listener.port}/navigate';</script>`);
      let seen: Awaited<ReturnType<typeof readBack>> | undefined;
      // The screen's assets are in a sibling folder, so the bundle is named. The live proxy
      // stands in for something listening on the dead proxy's port, or a proxy Playwright was told
      // to bypass for loopback.
      const png = await shootDesign(screen, {
        bundle,
        width: 800,
        height: 600,
        ...(proxy === 'live' ? { proxy: `http://127.0.0.1:${listener.proxyPort}` } : {}),
        inspect: async (page) => void (seen = await readBack(page)),
      });
      await new Promise((wait) => setTimeout(wait, 500));

      expect(listener.heard, `the screen's log:\n${seen?.log}`).toEqual([]);
      expect(isPng(png, 800)).toBe(true);
      expect(seen?.title).toBe('done');
      for (const frame of seen?.frames ?? []) expect(frame).not.toContain(SECRET);
      expect(seen?.log).not.toContain(SECRET);
      expect(seen?.log).toContain('an outside script: did not run');
      // routeWebSocket closes the page's socket before it connects; without it the socket fails
      // at the network instead, with an error first.
      expect(seen?.log).toContain('WebSocket: failed: closed');
      // The bundle's own files still load.
      expect(seen?.own).toEqual({ script: 'ran', colour: 'rgb(1, 2, 3)' });
    } finally {
      await listener.close();
    }
  });
}

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

test('a screen that never goes quiet is photographed without a long wait', async () => {
  test.setTimeout(60_000);
  const screen = join(bundle, 'busy', 'screen.html');
  write(screen, `<!doctype html><title>busy</title><h1>Busy</h1>
<script>setInterval(() => { new Image().src = 'missing-' + Date.now() + '.png'; }, 400);</script>`);
  const started = Date.now();
  const png = await shootDesign(screen, { bundle, width: 320, height: 240 });
  expect(isPng(png, 320)).toBe(true);
  expect(Date.now() - started).toBeLessThan(15_000);
});

test('by default the bundle is the screen\'s own folder, which must hold the screen', async () => {
  const screen = join(bundle, 'alone', 'screen.html');
  write(screen, `<!doctype html><title>alone</title><h1>Alone</h1><script src="../assets/own.js"></script>`);
  let own: string | undefined = 'unread';
  await shootDesign(screen, { inspect: async (page) => void (own = await page.evaluate(() => document.documentElement.dataset.own)) });
  expect(own, 'a file beside the screen\'s folder loaded without --bundle').toBeUndefined();
  await expect(shootDesign(join(root, 'outside-secret.txt'), { bundle })).rejects.toThrow(/not inside the bundle/);
});

/** A process as Linux's /proc shows it: its parent, its command line as text, its seccomp mode and its user namespace. */
type Proc = { pid: number; ppid: number; command: string; seccomp?: string; userNs?: string };
function processes(): Proc[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        const status = readFileSync(`/proc/${name}/status`, 'utf8');
        const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(status)?.[1];
        let userNs: string | undefined;
        try {
          userNs = readlinkSync(`/proc/${name}/ns/user`);
        } catch {
          // not ours to read
        }
        // A Chromium child rewrites its title over its arguments, so the command line is read as text.
        const command = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
        return [{ pid: Number(name), ppid: Number(field('PPid')), command, seccomp: field('Seccomp'), userNs }];
      } catch {
        return []; // gone already
      }
    });
}
const hasFlag = (command: string, flag: string) => new RegExp(`(?:^|\\s)${flag}(?:\\s|$)`).test(command);

// The boundary is Chromium's OS sandbox (design.mjs): the fences above live inside the browser, and
// stop nothing once a renderer bug runs native code. Linux shows each process's flags and
// confinement in /proc, so this reads them from the browser this render launched (the one whose
// command line carries the renderer's host-resolver rule, under this test process) and every
// process under it, while the screen is open.
test("the screen's browser runs inside Chromium's OS sandbox", async () => {
  test.skip(process.platform !== 'linux', "it reads Linux's /proc. On Windows and macOS Chromium's sandbox needs no setup, and tests/unit/screenshot-sandbox.test.ts pins that design.mjs asks for it");
  const screen = join(bundle, 'sandbox', 'screen.html');
  write(screen, '<!doctype html><title>sandbox</title><h1>Sandbox</h1>');
  let tree: Proc[] = [];
  await shootDesign(screen, {
    bundle,
    width: 320,
    height: 240,
    inspect: async () => {
      const all = processes();
      const under = (root: number) => {
        const found = new Set([root]);
        for (let size = 0; found.size !== size; ) {
          size = found.size;
          for (const proc of all) if (found.has(proc.ppid)) found.add(proc.pid);
        }
        return all.filter((proc) => found.has(proc.pid));
      };
      const browsers = under(process.pid).filter((proc) => proc.command.includes('--host-resolver-rules=MAP * ~NOTFOUND') && !proc.command.includes('--type='));
      expect(browsers, 'the renderer\'s browser process, under this test').toHaveLength(1);
      tree = under(browsers[0]!.pid);
    },
  });
  const ours = readlinkSync('/proc/self/ns/user');
  const renderers = tree.filter((proc) => hasFlag(proc.command, '--type=renderer'));
  expect(renderers.length, tree.map((proc) => proc.command).join('\n')).toBeGreaterThan(0);
  expect(tree.filter((proc) => hasFlag(proc.command, '--no-sandbox')).map((proc) => proc.command)).toEqual([]);
  for (const renderer of renderers) {
    // Seccomp 2 is a seccomp-bpf filter. A user namespace of its own is the layer the AppArmor
    // profile lets Chromium make (tools/screenshots/README.md).
    expect(renderer.seccomp, `renderer ${renderer.pid}'s seccomp mode`).toBe('2');
    expect(renderer.userNs, `renderer ${renderer.pid}'s user namespace`).toBeDefined();
    expect(renderer.userNs, `renderer ${renderer.pid}'s user namespace`).not.toBe(ours);
  }
});

// With this set, Playwright stops sending loopback through the proxy.
test('refuses to render when Playwright is told to let loopback bypass the proxy', async () => {
  const screen = join(bundle, 'bypass', 'screen.html');
  write(screen, '<!doctype html><title>bypass</title><h1>Bypass</h1>');
  const name = 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK';
  process.env[name] = '1';
  try {
    await expect(shootDesign(screen, { bundle })).rejects.toThrow(new RegExp(name));
  } finally {
    delete process.env[name];
  }
});
