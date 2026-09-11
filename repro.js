// Detached DOM nodes survive a forced full GC on Apple Silicon macOS.
//
// Regressed in WebKit between 319949@main (a5b2b89dc868) and 320228@main (73a19c0d770b).
// Reproduces on macOS 15 and macOS 26 arm64; green on macOS x86_64, Linux x86_64,
// Linux arm64, Windows.
//
//   npm install && npx playwright install webkit
//   node repro.js                 # all variants
//   node repro.js --variant=expect --repeat=5
//
// @playwright/test@1.63.0 ships WebKit r2359 (first bad) and @1.62.0 ships r2336 (last good),
// so installing either one switches the browser under an otherwise identical script.
//
// Each variant appends 25 <button>s one at a time, does something to each one, then
// empties the container and forces a full GC (Inspector Heap.gc). Every button is
// registered in a WeakRef beforehand, so what is left alive after the GC is the bug.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { webkit, expect } = require('@playwright/test');

const COUNT = 25;
const EXPECTED_ALIVE = 4; // the 2 static buttons, each registered twice

// The bug is all-or-nothing: every dynamic button survives, so `alive` jumps straight to 29.
// A handful above EXPECTED_ALIVE is something else — a Playwright action holding its last
// target (microsoft/playwright#41462) shows up as exactly one extra. Mirrors the upstream
// test, which accepts anything under 25 and only fails on wholesale retention.
const LEAK_THRESHOLD = COUNT;

function verdict(alive) {
  if (alive >= LEAK_THRESHOLD)
    return `LEAK — all ${COUNT} detached buttons survived the GC`;
  if (alive > EXPECTED_ALIVE)
    return `ok (${alive - EXPECTED_ALIVE} extra retained — not this bug)`;
  return 'ok';
}

// The WebKit build number identifies the regression far better than the Playwright version.
function webkitRevision() {
  try {
    const dir = path.dirname(require.resolve('playwright-core'));
    return JSON.parse(fs.readFileSync(path.join(dir, 'browsers.json'), 'utf8'))
        .browsers.find(b => b.name === 'webkit').revision;
  } catch {
    return '?';
  }
}

const VARIANTS = {
  // Playwright assertion. This is the one that regressed.
  'expect': (page, locator) => expect(locator).toBeVisible(),

  // Same visibility wait through a different Playwright path. Still green upstream of the
  // regression *and* after it, which is what makes the bug interesting.
  'wait-for': (page, locator) => locator.waitFor(),
  'click': (page, locator) => locator.click(),

  // No Playwright machinery: just the DOM work that a visibility check performs.
  'dom-style': page => page.evaluate(() => {
    const el = document.querySelector('#buttons > button:last-child');
    getComputedStyle(el).display;
    el.getBoundingClientRect();
  }),

  // No Playwright machinery: just the event dispatch that precedes a Playwright action.
  'dom-event': page => page.evaluate(() => {
    const el = document.querySelector('#buttons > button:last-child');
    el.dispatchEvent(new CustomEvent('__mark__', { bubbles: true, cancelable: true, composed: true }));
  }),

  'dom-both': page => page.evaluate(() => {
    const el = document.querySelector('#buttons > button:last-child');
    getComputedStyle(el).display;
    el.getBoundingClientRect();
    el.dispatchEvent(new CustomEvent('__mark__', { bubbles: true, cancelable: true, composed: true }));
  }),

  'none': () => Promise.resolve(),
};

async function registerWeakRefs(page) {
  await page.evaluate(() => {
    globalThis.refs = globalThis.refs || [];
    for (const el of document.querySelectorAll('button'))
      globalThis.refs.push(new WeakRef(el));
  });
}

// Lowest count any GC round reaches. deref() pins its target for the rest of the job,
// so later rounds can only ever read higher.
async function aliveAfterGC(page) {
  let alive = Infinity;
  for (let round = 0; round < 3; ++round) {
    await page.requestGC();
    alive = Math.min(alive, await page.evaluate(() => globalThis.refs.filter(r => !!r.deref()).length));
  }
  return alive;
}

async function runVariant(browser, name) {
  const page = await browser.newPage();
  await page.setContent(`
    <button>static button 1</button>
    <button>static button 2</button>
    <div id="buttons"></div>
  `);
  await registerWeakRefs(page);

  for (let i = 0; i < COUNT; ++i) {
    await page.evaluate(i => {
      const el = document.createElement('button');
      el.textContent = 'dynamic ' + i;
      document.getElementById('buttons').appendChild(el);
    }, i);
    await VARIANTS[name](page, page.locator('#buttons > button').last());
  }

  await registerWeakRefs(page);
  await page.evaluate(() => { document.getElementById('buttons').textContent = ''; });
  const alive = await aliveAfterGC(page);
  await page.close();
  return alive;
}

(async () => {
  const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
  const names = args.variant ? [args.variant] : Object.keys(VARIANTS);
  const repeat = Number(args.repeat || 1);

  const browser = await webkit.launch();
  console.log(`webkit ${browser.version()} (playwright build r${webkitRevision()})`);
  console.log(`${os.type()} ${os.release()} ${process.arch} | ${os.cpus()[0].model} | ${os.cpus().length} cpus | ${Math.round(os.totalmem() / 2 ** 30)} GB`);
  console.log(`${COUNT} buttons; ${EXPECTED_ALIVE} of ${2 + (2 + COUNT)} WeakRefs should stay alive\n`);
  console.log('variant     alive  verdict');

  let leaked = false;
  for (const name of names) {
    const results = [];
    for (let i = 0; i < repeat; ++i)
      results.push(await runVariant(browser, name));
    for (const alive of results) {
      const bad = alive >= LEAK_THRESHOLD;
      leaked = leaked || bad;
      console.log(`${name.padEnd(10)} ${String(alive).padStart(5)}  ${verdict(alive)}`);
    }
  }
  await browser.close();
  process.exit(leaked ? 1 : 0);
})();
