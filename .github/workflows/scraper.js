// scraper_turbo.js
// TURBO parallel scraper with multi-attempt popup extraction + full logging

const fs = require("fs");
const playwright = require("playwright");

const MAP_URL = "https://map.ccnetmc.com/nationsmap";
const OUTFILE = "towns.json";

function parseNum(s) {
  if (!s) return null;
  const m = ("" + s).match(/-?[\d,]+(?:\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, "")) : null;
}
function computeDays(bank, upkeep) {
  if (!bank || !upkeep) return null;
  if (upkeep === 0) return null;
  const d = bank / upkeep;
  return d > 1 ? Math.ceil(d) : Math.round(d);
}

function extractNation(txt) {
  if (!txt) return null;
  const m = txt.match(/Member of ([A-Za-z0-9_ -]{2,60})/i);
  return m ? m[1].trim() : null;
}

// Extract meaningful town data from popup HTML+text
function parseTownData(text, html) {
  const town =
    (text.match(/^([^\n<]{2,60})/) || [])[1] ||
    (text.match(/Town[:\s]*([^\n]+)/i) || [])[1] ||
    (html.match(/<b[^>]*>([^<]{2,60})<\/b>/i) || [])[1] ||
    null;

  const bankM =
    text.match(/Bank[:\s]*([\d,\.]+)/i) ||
    text.match(/Balance[:\s]*([\d,\.]+)/i) ||
    html.match(/Bank[^0-9]*([\d,\.]+)/i);

  const upkeepM =
    text.match(/Upkeep[:\s]*([\d,\.]+)/i) ||
    html.match(/Upkeep[^0-9]*([\d,\.]+)/i);

  const nation = extractNation(text);
  
  return {
    town: town ? town.trim() : null,
    bank: bankM ? parseNum(bankM[1]) : null,
    upkeep: upkeepM ? parseNum(upkeepM[1]) : null,
    nation: nation ? nation.trim() : null,
  };
}

(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
  });
  const page = await context.newPage();

  console.log("Loading", MAP_URL);
  await page.goto(MAP_URL, {
    waitUntil: "networkidle",
    timeout: 20000,
  });

  await page.waitForSelector(
    "#map, .leaflet-container, canvas",
    { timeout: 8000 }
  ).catch(() => {});

  // Find marker nodes
  const selectors = [
    ".leaflet-marker-icon",
    "[class*='marker']",
    ".marker",
  ];

  let markerHandles = [];
  for (let sel of selectors) {
    const nodes = await page.$$(sel);
    if (nodes.length) {
      markerHandles = nodes;
      break;
    }
  }

  console.log("FOUND MARKERS =", markerHandles.length);

  if (!markerHandles.length) {
    console.log("NO MARKERS DETECTED. EXIT.");
    process.exit(1);
  }

  // Deduplicate visually overlapping markers
  const unique = new Map();
  const boxes = await Promise.all(markerHandles.map((m) => m.boundingBox()));

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b) continue;
    const key = `${Math.round(b.x)}_${Math.round(b.y)}`;
    if (!unique.has(key)) unique.set(key, markerHandles[i]);
  }

  const markers = [...unique.values()];
  console.log("UNIQUE MARKERS =", markers.length);

  // Concurrency boosted
  const CONCURRENCY = 16;
  const results = [];

  async function grabPopup() {
    const popups = await page.$$(
      ".leaflet-popup-content, .la-popup-content, .leaflet-popup, .leaflet-tooltip, [class*='popup']"
    );

    if (!popups.length) return null;

    let combinedText = "";
    let combinedHTML = "";

    for (const p of popups) {
      combinedText += " " + (await p.innerText().catch(() => ""));
      combinedHTML += " " + (await p.innerHTML().catch(() => ""));
    }

    return { text: combinedText.trim(), html: combinedHTML.trim() };
  }

  async function clickMarker(marker, index) {
    console.log(`\n--- Processing marker #${index} ---`);

    // HOVER attempt
    await marker.hover().catch(() => {});

    // First click
    await marker.click({ timeout: 300 }).catch(() => {});
    await page.waitForTimeout(30);

    let data = await grabPopup();

    // If empty, attempt second click
    if (!data || (!data.text && !data.html)) {
      await marker.click({ timeout: 300 }).catch(() => {});
      await page.waitForTimeout(30);
      data = await grabPopup();
    }

    // Third attempt if still nothing
    if (!data || (!data.text && !data.html)) {
      await page.mouse.move(Math.random() * 20, Math.random() * 20);
      await marker.click({ timeout: 300 }).catch(() => {});
      await page.waitForTimeout(40);
      data = await grabPopup();
    }

    if (!data) {
      console.log(`Marker #${index} → NO POPUP`);
      return null;
    }

    console.log(`Popup Text #${index}:`, data.text.replace(/\s+/g, " ").slice(0, 200));
    console.log(`Popup HTML #${index}:`, data.html.replace(/\s+/g, " ").slice(0, 200));

    // Recognize town data
    const parsed = parseTownData(data.text, data.html);

    console.log("Parsed data:", parsed);

    if (!parsed.town && !parsed.bank && !parsed.upkeep && !parsed.nation) {
      console.log(`Marker #${index} → Popup but NO usable town data`);
      return null;
    }

    return parsed;
  }

  async function runParallel() {
    let idx = 0;

    async function worker() {
      while (idx < markers.length) {
        const i = idx++;
        const marker = markers[i];
        const r = await clickMarker(marker, i);
        if (r) results.push(r);
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
  }

  console.log("STARTING SCRAPE...");
  await runParallel();

  console.log("\n----- RAW RESULTS =", results.length);

  // Dedupe by town name
  const byName = new Map();
  for (const r of results) {
    if (!r.town) continue;
    const key = r.town.trim();
    if (!byName.has(key)) byName.set(key, r);
    else {
      const cur = byName.get(key);
      if (!cur.bank && r.bank) cur.bank = r.bank;
      if (!cur.upkeep && r.upkeep) cur.upkeep = r.upkeep;
      if (!cur.nation && r.nation) cur.nation = r.nation;
    }
  }

  const final = [];
  for (const [name, r] of byName.entries()) {
    final.push({
      town: name,
      nation: r.nation,
      bank: r.bank,
      upkeep: r.upkeep,
      days_rounded: computeDays(r.bank, r.upkeep),
    });
  }

  console.log("FINAL UNIQUE TOWNS =", final.length);

  fs.writeFileSync(
    OUTFILE,
    JSON.stringify(
      {
        scraped_at: new Date().toISOString(),
        source: MAP_URL,
        towns: final,
      },
      null,
      2
    )
  );

  console.log("DONE! Wrote towns to", OUTFILE);

  await browser.close();
})();
