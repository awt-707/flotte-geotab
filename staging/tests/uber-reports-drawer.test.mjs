import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Representative UI structure, not a captured authenticated Uber page.
const root = new URL('../uber-extension/', import.meta.url);
const org = '11111111-1111-4111-8111-111111111111';
const url = `https://fleethub.uber.com/orgs/${org}/reports`;
const config = { enabled: true, organization_id: org, organization_label: 'SYNTHETIC FLEET', report_type: 'trip_activity', start_date: '2026-10-26', end_date: '2026-11-01', date_format: 'dmy' };
const reader = await readFile(new URL('reports-reader.js', root), 'utf8');
const content = await readFile(new URL('reports-content.js', root), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.LUDY_TEST_CHROMIUM || '/usr/bin/chromium' }); });
after(async () => { await browser?.close(); });

const pageMarkup = `<main>
  <h1>Reports</h1><button id="open">Generate Report</button>
  <table><thead><tr><th>Report name</th><th><button>Report type</button></th><th>Report time range</th><th>Generated on</th></tr></thead>
  <tbody><tr><td>old-report</td><td>Driver Activity</td><td>2026/09/01 – 2026/09/07</td><td>2026/09/08</td></tr></tbody></table>
</main>`;
const drawerMarkup = `<section role="dialog" aria-label="Generate Report">
  <h2>Generate Report</h2>
  <div><div>Report type</div><div data-baseweb="select" id="report-control">
    <div><div id="selected-type">Driver Activity</div><div><input role="combobox" aria-expanded="false" aria-controls="type-options" value=""></div></div>
    <svg aria-hidden="true"></svg>
  </div></div>
  <div style="display:flex"><div><div>Start of report</div><div data-baseweb="input"><div><input id="start" value="2026/10/26" readonly></div></div></div>
    <div><div>End of report</div><div data-baseweb="input"><div><input id="end" value="2026/11/01" readonly></div></div></div></div>
  <div><div>Start time</div><button aria-haspopup="listbox">12:00 AM</button></div>
  <div><div>End time</div><button aria-haspopup="listbox">11:59 PM</button></div>
  <div><div>Select organizations to include in report <svg aria-hidden="true"></svg></div><button id="organizations" aria-haspopup="listbox">Select organizations to include in report</button></div>
  <div id="organization-options" hidden><input placeholder="Branches"><label><input id="organization-choice" type="checkbox">SYNTHETIC FLEET</label></div>
  <button>Cancel</button><button id="generate" disabled>Generate</button>
</section>
<div role="listbox" id="type-options" hidden><div role="option">Driver Activity</div><div role="option">Trip Activity</div><div role="option">Driver Quality</div></div>`;

async function fixture(work, { open = true } = {}) {
  const page = await browser.newPage({timezoneId:'Africa/Casablanca'});
  await page.route('**/*', route => {
    assert.equal(route.request().url(), url, 'No external provider requests in this test');
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html>${pageMarkup}${open ? drawerMarkup : ''}` });
  });
  await page.goto(url);
  await page.evaluate(drawer => {
    window.generated = 0; window.reserved = 0;
    window.chrome = { runtime: { id: 'fixture', onMessage: { addListener: listener => window.reportListener = listener, removeListener() {} }, sendMessage: async () => { reserved++; return { ok: true, data: { reserved: true } }; } } };
    const wire = () => {
      const input = document.querySelector('#report-control input');
      document.querySelector('#report-control').onclick = () => { document.querySelector('#type-options').hidden = false; input.setAttribute('aria-expanded', 'true'); };
      for (const option of document.querySelectorAll('[role="option"]')) option.onclick = () => {
        document.querySelector('#selected-type').textContent = option.textContent;
        document.querySelector('#type-options').hidden = true; input.setAttribute('aria-expanded', 'false');
      };
      document.querySelector('#organizations').onclick = () => { const node = document.querySelector('#organization-options'); node.hidden = !node.hidden; };
      document.querySelector('#organization-choice').onchange = event => {
        document.querySelector('#organizations').textContent = event.target.checked ? 'SYNTHETIC FLEET' : 'Select organizations to include in report';
        document.querySelector('#generate').disabled = !event.target.checked;
      };
      document.querySelector('#generate').onclick = () => generated++;
    };
    document.querySelector('#open').onclick = () => { document.body.insertAdjacentHTML('beforeend', drawer); wire(); };
    if (document.querySelector('[role="dialog"]')) wire();
  }, drawerMarkup);
  await page.addScriptTag({ content: reader });
  await page.addScriptTag({ content });
  try { await work(page); } finally { await page.close(); }
}

test('a Reports drawer is identified independently of the background table header', async () => {
  await fixture(async page => {
    const result = await page.evaluate(config => {
      const form = LudyUberReportsReader.inspect(document, location.href, config);
      return { status: form.status, start: form.start.id, end: form.end.id, generate: form.generate.id };
    }, config);
    assert.deepEqual(result, { status: 'form', start: 'start', end: 'end', generate: 'generate' });
  });
});

test('a visible selected label beside an empty combobox drives exact report selection', async () => {
  await fixture(async page => {
    const result = await page.evaluate(config => new Promise(resolve => reportListener({ type: 'LUDY_UBER_REPORTS_RUN', runId: 'wrapped-select', config }, { id: 'fixture' }, resolve)), config);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.result.status, 'requested');
    assert.deepEqual(await page.evaluate(() => ({ selected: document.querySelector('#selected-type').textContent, input: document.querySelector('#report-control input').value, reserved, generated, branch: document.querySelector('#organization-choice').checked })), { selected: 'Trip Activity', input: '', reserved: 1, generated: 1, branch: true });
  });
});

test('opening the Reports drawer does not mistake a background header for a form', async () => {
  await fixture(async page => {
    const result = await page.evaluate(config => new Promise(resolve => reportListener({ type: 'LUDY_UBER_REPORTS_RUN', runId: 'open-wrapped-select', config }, { id: 'fixture' }, resolve)), config);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.result.status, 'requested');
    assert.equal(await page.evaluate(() => generated), 1);
  }, { open: false });
});

test('a report selector with its label as a separate drawer sibling is identified by its unique selected type', async () => {
  await fixture(async page => {
    await page.evaluate(() => {
      const field = document.querySelector('#report-control').parentElement;
      field.replaceWith(...field.childNodes);
    });
    const result = await page.evaluate(config => new Promise(resolve => reportListener({ type: 'LUDY_UBER_REPORTS_RUN', runId: 'flat-report-label', config }, { id: 'fixture' }, resolve)), config);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.result.status, 'requested');
    assert.equal(await page.evaluate(() => document.querySelector('#selected-type').textContent), 'Trip Activity');
    assert.equal(await page.evaluate(() => generated), 1);
  });
});

test('two independent report selectors without identifying labels cannot silently select a report', async () => {
  await fixture(async page => {
    await page.evaluate(() => {
      const field = document.querySelector('#report-control').parentElement;
      field.replaceWith(...field.childNodes);
      for (const node of document.querySelectorAll('[role="dialog"] div')) if (node.children.length === 0 && node.textContent === 'Report type') node.remove();
      const second = document.querySelector('#report-control').cloneNode(true);
      second.removeAttribute('id');
      for (const node of second.querySelectorAll('[id]')) node.removeAttribute('id');
      document.querySelector('[role="dialog"]').append(second);
    });
    const result = await page.evaluate(config => new Promise(resolve => reportListener({ type: 'LUDY_UBER_REPORTS_RUN', runId: 'ambiguous-flat-selectors', config }, { id: 'fixture' }, resolve)), config);
    assert.equal(result.ok, false);
    assert.equal(await page.evaluate(() => reserved), 0);
    assert.equal(await page.evaluate(() => generated), 0);
  });
});

test('a read-only text control displaying an exact report type uses its menu rather than editing its value', async () => {
  await fixture(async page => {
    await page.evaluate(() => {
      const control = document.querySelector('#report-control'), input = control.querySelector('input'), field = control.parentElement;
      field.replaceWith(...field.childNodes);
      control.removeAttribute('data-baseweb');
      input.removeAttribute('role'); input.readOnly = true; input.value = 'Driver Activity';
      document.querySelector('#selected-type').remove();
      window.manualValueChanges = 0;
      input.addEventListener('input', () => manualValueChanges++);
      for (const option of document.querySelectorAll('#type-options [role="option"]')) option.onclick = () => {
        input.value = option.textContent;
        document.querySelector('#type-options').hidden = true;
        input.setAttribute('aria-expanded', 'false');
      };
    });
    const result = await page.evaluate(config => new Promise(resolve => reportListener({ type: 'LUDY_UBER_REPORTS_RUN', runId: 'readonly-type-selector', config }, { id: 'fixture' }, resolve)), config);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.result.status, 'requested');
    assert.deepEqual(await page.evaluate(() => ({ selected: document.querySelector('#report-control input').value, manualValueChanges, reserved, generated })), { selected: 'Trip Activity', manualValueChanges: 0, reserved: 1, generated: 1 });
  });
});
