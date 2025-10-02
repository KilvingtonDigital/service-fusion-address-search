// src/main.js
import 'dotenv/config';
import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Parse components from an address string (very simple) */
function parseAddress(address) {
  const a = (address || '').trim();
  const m = a.match(/^(\d+)\s+(.*)$/); // house number + rest
  return {
    house: m ? m[1] : '',
    street: m ? m[2] : a,
    tokens: norm(a).split(' ').filter(Boolean),
  };
}

/** Map header text -> column index (best effort) */
async function getHeaderMap(page) {
  const headers = await page.$$eval('table thead tr th', ths =>
    ths.map(th => (th.textContent || '').trim())
  );
  const map = {};
  headers.forEach((h, i) => {
    const H = h.toLowerCase();
    if (/(customer\s*name|name)/i.test(h)) map.name = i;
    if (/service\s*location/i.test(h)) map.serviceLocation = i;
    if (/city|state\/?prov/i.test(h)) map.city = i;
    if (/zip|post/i.test(h)) map.zip = i;
    if (/email/i.test(h)) map.email = i;
    if (/phone/i.test(h)) map.phone = i;
  });
  return { headers, map };
}

/** Score a single row using address + optional city/zip hints. Higher is better. */
function scoreRow(cells, rowText, parsed, cityHint, zipHint) {
  // Base: token overlap against either full row or service location cell
  const text = norm(rowText);
  const loc = cells.serviceLocation || '';
  const textLoc = norm(loc);

  let score = 0;
  const breakdown = {};

  // House number exact match (big signal)
  if (parsed.house && (textLoc.includes(parsed.house) || text.includes(parsed.house))) {
    score += 50; breakdown.house = 50;
  }

  // Zip exact match (if provided)
  if (zipHint) {
    const z = norm(zipHint);
    if (text.includes(z)) { score += 40; breakdown.zip = 40; }
  }

  // City match (if provided)
  if (cityHint) {
    const c = norm(cityHint);
    if (text.includes(c) || textLoc.includes(c)) { score += 20; breakdown.city = 20; }
  }

  // Street token coverage (each token small weight)
  let streetHits = 0;
  for (const tok of parsed.tokens) {
    if (tok && (textLoc.includes(tok) || text.includes(tok))) streetHits += 1;
  }
  const streetPts = streetHits * 5;
  score += streetPts; breakdown.streetTokens = streetPts;

  // Small bonus if email/phone present (often real accounts)
  if (cells.email && cells.email.trim()) { score += 3; breakdown.email = 3; }
  if (cells.phone && cells.phone.trim()) { score += 3; breakdown.phone = 3; }

  return { score, breakdown };
}

/** Extract useful details from the detail page (best-effort) */
async function extractDetails(page) {
  const details = {};

  // Customer Name - try multiple strategies
  try {
    details.customerName = await page.locator('h1, h2').filter({ hasText: /Edit Customer|Customer:/ }).first().textContent().then(t => 
      t.replace(/Edit Customer:\s*/i, '').trim()
    ).catch(() => null);
  } catch (_) {}

  // Account Number
  try {
    const accountLabel = page.locator('text=Account Number').locator('..');
    details.accountNumber = await accountLabel.locator('input').inputValue().catch(() => null);
  } catch (_) {}

  // VIP Account
  try {
    const vipLabel = page.locator('text=VIP Account');
    details.vipAccount = await vipLabel.locator('..').locator('button').filter({ hasText: 'YES' }).count().then(c => c > 0);
  } catch (_) {
    details.vipAccount = false;
  }

  // Service Agreement
  details.serviceAgreement = {};
  try {
    // Agreement Name
    const agreementNameInput = page.locator('input').filter({ hasText: '' }).first();
    details.serviceAgreement.name = await agreementNameInput.inputValue().catch(() => null);
    
    // Find all date inputs in the service agreements section
    const dateInputs = await page.locator('input[type="text"]').all();
    const dateValues = [];
    for (const input of dateInputs) {
      const val = await input.inputValue().catch(() => '');
      if (/\d{2}\/\d{2}\/\d{4}/.test(val)) {
        dateValues.push(val);
      }
    }
    
    if (dateValues.length >= 2) {
      details.serviceAgreement.effectiveDate = dateValues[0];
      details.serviceAgreement.expirationDate = dateValues[1];
    }
    
    // Amount - look for input with $ symbol
    const amountInput = page.locator('input').filter({ hasText: '' }).nth(2);
    details.serviceAgreement.amount = await amountInput.inputValue().catch(() => null);
    
    // Description/Notes
    const descInputs = await page.locator('input[type="text"]').all();
    for (const input of descInputs) {
      const val = await input.inputValue().catch(() => '');
      if (val && val.includes('1462 22nd') || val.length > 10) {
        details.serviceAgreement.description = val;
        break;
      }
    }
  } catch (_) {}

  // Primary Contact
  details.primaryContact = {};
  try {
    // First Name
    details.primaryContact.firstName = await page.locator('input[name*="first" i], input').filter({ hasText: '' }).first().inputValue().catch(() => null);
    
    // Last Name
    details.primaryContact.lastName = await page.locator('input[name*="last" i], input').nth(1).inputValue().catch(() => null);
    
    // Phone Number
    const phoneInput = page.locator('input[type="tel"], input').filter({ hasText: '' });
    details.primaryContact.phoneNumber = await phoneInput.inputValue().catch(() => null);
    
    // Phone Type
    const phoneTypeSelect = page.locator('select').filter({ hasText: /Mobile|Home|Work/ });
    details.primaryContact.phoneType = await phoneTypeSelect.inputValue().catch(() => 'Mobile');
    
    // Email
    const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]');
    details.primaryContact.email = await emailInput.inputValue().catch(() => null);
  } catch (_) {}

  // Try to extract all form data using a more comprehensive approach
  try {
    const formData = await page.evaluate(() => {
      const data = {};
      
      // Get all input fields with values
      document.querySelectorAll('input[type="text"], input[type="tel"], input[type="email"]').forEach(input => {
        const value = input.value.trim();
        if (value) {
          // Try to find a label
          const label = input.previousElementSibling?.textContent || 
                       input.parentElement?.previousElementSibling?.textContent ||
                       input.getAttribute('placeholder') ||
                       input.getAttribute('name') || '';
          
          if (label.trim()) {
            data[label.trim()] = value;
          }
        }
      });
      
      return data;
    });
    
    details.allFormFields = formData;
  } catch (_) {}

  return details;
}

Actor.main(async () => {
  // ===== Input =====
  const input = (await Actor.getInput()) || {};
  const {
    // You can pass either `addresses: ["1462 22nd", ...]`
    // OR richer `queries: [{ address, city, zip }, ...]`
    addresses = [],
    queries = [],
    headless = true,
    slowMo = 0,
    navigationTimeoutSecs = 45,
    searchSettleMs = 7000, // wait after submitting the search
    selectors = {},
  } = input;

  // Normalize tasks
  const tasks = Array.isArray(queries) && queries.length
    ? queries.map(q => ({ address: q.address || '', city: q.city || '', zip: q.zip || '' }))
    : (Array.isArray(addresses) ? addresses.map(a => ({ address: a })) : []);

  if (!tasks.length) {
    throw new Error('Provide either "addresses" (array of strings) or "queries" (array of {address, city?, zip?}).');
  }

  // ===== Credentials from env (do NOT hardcode) =====
  const SF_COMPANY  = process.env.SERVICEFUSION_COMPANY_ID;
  const SF_USERNAME = process.env.SERVICEFUSION_USERNAME;
  const SF_PASSWORD = process.env.SERVICEFUSION_PASSWORD;
  if (!SF_COMPANY || !SF_USERNAME || !SF_PASSWORD) {
    throw new Error('Missing env vars: SERVICEFUSION_COMPANY_ID, SERVICEFUSION_USERNAME, SERVICEFUSION_PASSWORD');
  }

  // ===== Defaults (can be overridden by INPUT.selectors) =====
  const {
    loginUrl     = 'https://auth.servicefusion.com/auth/login',
    customersUrl = 'https://admin.servicefusion.com/customer/customerList',
    company      = '#company',
    username     = '#uid',
    password     = '#pwd',
    loginBtn     = "button[type='submit']",
    searchField  = '#CustomersListFilterForm_quickSearch',
    resultsRow   = 'table tbody tr',
    resultLink   = "a[href*='customer']",
    loadingText  = 'text=Please wait while loading the details',
  } = selectors;

  // ===== Browser =====
  log.info('Launching browser…');
  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(navigationTimeoutSecs * 1000);

  // ===== LOGIN =====
  log.info('Opening login page…');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.fill(company,  SF_COMPANY);
  await page.fill(username, SF_USERNAME);
  await page.fill(password, SF_PASSWORD);
  await page.click(loginBtn);
  await page.waitForTimeout(1500);

  // ===== OPEN CUSTOMERS =====
  await page.goto(customersUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutSecs * 1000 });
  await page.waitForSelector(searchField, { state: 'visible', timeout: navigationTimeoutSecs * 1000 });

  // ===== LOOP TASKS =====
  for (const task of tasks) {
    const { address, city = '', zip = '' } = task;
    const parsed = parseAddress(address);
    const safe = address.replace(/\W+/g, '_') || 'query';

    log.info(`Searching: ${address}${city ? `, ${city}` : ''}${zip ? ` ${zip}` : ''}`);

    // fresh page for each search
    await page.goto(customersUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutSecs * 1000 });
    await page.waitForSelector(searchField, { state: 'visible', timeout: navigationTimeoutSecs * 1000 });

    // type & submit
    await page.fill(searchField, '');
    await page.type(searchField, address, { delay: 15 });
    await page.keyboard.press('Enter');

    // wait for grid to fill
    await page.waitForTimeout(searchSettleMs);

    // gather header map and rows
    const { headers, map } = await getHeaderMap(page).catch(() => ({ headers: [], map: {} }));

    // read first up-to-100 rows
    const rowsData = await page.$$eval('table tbody tr', (trs, mapIn) => {
      return Array.from(trs).slice(0, 100).map(tr => {
        const tds = Array.from(tr.querySelectorAll('td'));
        const pick = (idx) => (idx != null && tds[idx]) ? (tds[idx].textContent || '').trim() : '';
        const nameCell = pick(mapIn.name);
        const emailCell = pick(mapIn.email);
        const phoneCell = pick(mapIn.phone);
        const serviceLocationCell = pick(mapIn.serviceLocation);
        const cityCell = pick(mapIn.city);
        const zipCell = pick(mapIn.zip);
        const link = tr.querySelector("a[href*='customer']") || tr.querySelector('a');
        const href = link ? link.href : null;
        return {
          text: tr.textContent || '',
          cells: {
            name: nameCell,
            email: emailCell,
            phone: phoneCell,
            serviceLocation: serviceLocationCell,
            city: cityCell,
            zip: zipCell,
            href,
          }
        };
      });
    }, map).catch(() => []);

    if (!rowsData.length) {
      log.warning('No rows returned.');
      await Actor.pushData({
        query: { address, city, zip },
        detailOpened: false,
        rowsPreview: [],
        scrapedAt: new Date().toISOString(),
      });
      await Actor.setValue(`RESULTS_PAGE_${safe}.html`, await page.content(), { contentType: 'text/html' });
      await Actor.setValue(`RESULTS_PAGE_${safe}.png`,  await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
      continue;
    }

    // score each row; choose best
    const scored = rowsData.map(r => {
      const { score, breakdown } = scoreRow(r.cells, r.text, parsed, city, zip);
      return { ...r, score, breakdown };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];

    // DEBUG: Log what we found
    log.info(`===== SEARCH RESULTS FOR: ${address} =====`);
    log.info(`Total rows found: ${scored.length}`);
    log.info(`Top 3 scores:`);
    scored.slice(0, 3).forEach((s, i) => {
      log.info(`  ${i+1}. Score: ${s.score} | Name: ${s.cells.name} | Location: ${s.cells.serviceLocation}`);
      log.info(`     Breakdown: ${JSON.stringify(s.breakdown)}`);
    });
    log.info(`Attempting to click row index: ${scored.indexOf(best)}`);

    // push a preview item (table context + top 3 scores)
    await Actor.pushData({
      query: { address, city, zip },
      tablePreviewTop3: scored.slice(0, 3).map(s => ({
        score: s.score,
        breakdown: s.breakdown,
        name: s.cells.name,
        serviceLocation: s.cells.serviceLocation,
        city: s.cells.city,
        zip: s.cells.zip,
        href: s.cells.href || null,
      })),
      scrapedAt: new Date().toISOString(),
    });

    // click best row
    const bestIndex = scored.indexOf(best);
    log.info(`Best match index: ${bestIndex}`);
    
    const rowHandles = await page.$$('table tbody tr');
    log.info(`Total row handles found: ${rowHandles.length}`);
    
    if (!rowHandles[bestIndex]) {
      log.warning(`Could not find row handle at index ${bestIndex}. Saving preview only.`);
      continue;
    }

    log.info(`Scrolling row ${bestIndex} into view...`);
    await rowHandles[bestIndex].scrollIntoViewIfNeeded().catch(() => {});
    
    log.info(`Looking for clickable link in row ${bestIndex}...`);
    const linkHandle = await rowHandles[bestIndex].$("a[href*='customer']") || await rowHandles[bestIndex].$('a');
    
    if (linkHandle) {
      const linkHref = await linkHandle.getAttribute('href');
      log.info(`Found link with href: ${linkHref}`);
      log.info('Clicking link in best match row...');
      await linkHandle.click();
      log.info('Click executed!');
    } else {
      log.warning('No link found in row, clicking row directly...');
      await rowHandles[bestIndex].click();
      log.info('Row click executed!');
    }

    log.info('Waiting for page transition...');

    // wait for overlay if any
    try {
      await page.waitForSelector(loadingText, { state: 'visible', timeout: 5000 });
      log.info('Loading overlay detected, waiting for it to disappear...');
      await page.waitForSelector(loadingText, { state: 'hidden', timeout: 15000 }).catch(() => {});
    } catch (_) {
      log.info('No loading overlay detected');
    }

    log.info('Waiting for URL change or page load...');
    await Promise.race([
      page.waitForURL(/customer/i, { timeout: 30000 }).catch(() => {}),
      page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(1200);

    const detailUrl = page.url();
    log.info(`Current URL after click: ${detailUrl}`);
    
    const idMatch = detailUrl.match(/(?:id=|\/customer\/view\/?)([a-zA-Z0-9_-]+)/i);
    const customerId = idMatch ? idMatch[1] : null;

    log.info(`Detail page URL: ${detailUrl}`);
    log.info(`Customer ID: ${customerId}`);

    const details = await extractDetails(page);
    await Actor.pushData({
      query: { address, city, zip },
      chosen: {
        score: best.score,
        breakdown: best.breakdown,
        name: best.cells.name,
        serviceLocation: best.cells.serviceLocation,
        city: best.cells.city,
        zip: best.cells.zip,
        href: best.cells.href || null,
      },
      detailOpened: true,
      detailUrl,
      customerId,
      details,
      scrapedAt: new Date().toISOString(),
    });

    await Actor.setValue(`DETAIL_${safe}.html`, await page.content(), { contentType: 'text/html' });
    await Actor.setValue(`DETAIL_${safe}.png`,  await page.screenshot({ fullPage: true }), { contentType: 'image/png' });

    log.info(`Opened details for "${address}" → ${best.cells.name || '(name unknown)'} (score: ${best.score})`);
  }

  await browser.close();
  log.info('Done. Results saved to Dataset.');
});