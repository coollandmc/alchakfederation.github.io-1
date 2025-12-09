// scrape_map.js
// Node.js + Playwright fast LiveAtlas scraper that extracts marker data from JS objects.
// Outputs towns.json

const fs = require("fs-extra");
const playwright = require("playwright");

const MAP_URL = "https://map.ccnetmc.com/nationsmap";
const OUTFILE = "towns.json";

function parseNumberFromString(s) {
  if (!s && s !== 0) return null;
  try {
    const m = ("" + s).match(/-?[\d,]+(?:\.\d+)?/);
    if (!m) return null;
    return Number(m[0].replace(/,/g, ""));
  } catch (e) {
    return null;
  }
}

function computeDays(bank, upkeep) {
  if (bank == null || upkeep == null) return null;
  if (upkeep === 0) return null;
  const days = bank / upkeep;
  if (days > 1) return Math.ceil(days);
  return Math.round(days);
}

(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();

  console.log("Loading page...");
  await page.goto(MAP_URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);

  // Evaluate inside page to attempt to find LiveAtlas marker data objects
  const markersData = await page.evaluate(() => {
    // Heuristics: look for common LiveAtlas globals: markerSets, window.liveatlas, window.LA, window.markerLayers etc.
    const candidates = [];

    function addIfObject(k, v) {
      if (!v) return;
      // if object with arrays of markers -> candidate
      if (typeof v === "object") {
        candidates.push({ key: k, value: v });
      }
    }

    // collect window properties that might contain markers
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (!v) continue;
        // quick filter: name hints
        if (/marker|liveatlas|la|markerSet|markers|markerSets|map|maps/i.test(k)) {
          addIfObject(k, v);
        }
      } catch (e) {
        // ignore
      }
    }

    // also check window.liveatlas / window.LA explicitly
    ["liveatlas", "LA", "LiveAtlas", "markerSets", "markers", "maps", "mapConfig"].forEach(k => {
      try { if (window[k]) addIfObject(k, window[k]); } catch (e) {}
    });

    // function to try to extract marker-like entries from an object
    function extractMarkersFromObj(obj) {
      if (!obj) return [];
      const out = [];
      // If obj has .markerSets or .markers arrays
      if (Array.isArray(obj)) {
        for (const it of obj) {
          if (it && (it.popup || it.name || it.title || it.contentHtml || it.options || it.lat !== undefined)) {
            out.push(it);
          }
        }
      } else {
        for (const k of Object.keys(obj)) {
          const val = obj[k];
          if (Array.isArray(val)) {
            for (const it of val) {
              if (it && (it.popup || it.name || it.title || it.contentHtml || it.options || it.lat !== undefined)) {
                out.push(it);
              }
            }
          }
        }
      }
      return out;
    }

    let found = [];
    // try the collected candidates
    for (const c of candidates) {
      try {
        const arr = extractMarkersFromObj(c.value);
        if (arr && arr.length) {
          found = found.concat(arr);
        }
      } catch(e){}
    }

    // Deduplicate by id or lat/lng/name
    const seen = new Set();
    const uniq = [];
    for (const m of found) {
      try {
        const id = m.id || m.name || (m.lat && m.lng ? `${m.lat}_${m.lng}` : JSON.stringify(m).slice(0,80));
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        uniq.push(m);
      } catch(e){}
    }

    // Return simplified snapshot of marker objects (avoid circular)
    return uniq.slice(0,10000).map(m => {
      // canonical fields we might use
      const out = {};
      out.__raw = { id: m.id || null, name: m.name || m.title || null };
      out.name = m.name || m.title || null;
      out.lat = m.lat || m.latitude || (m._latlng && m._latlng.lat) || null;
      out.lng = m.lng || m.longitude || (m._latlng && m._latlng.lng) || null;
      out.popup = m.popup || m.contentHtml || m._popup?.getContent?.() || null;
      // sometimes popup is a function that returns HTML — attempt to call
      if (!out.popup) {
        try {
          if (typeof m.getPopup === "function") {
            const p = m.getPopup();
            if (p && typeof p.getContent === "function") out.popup = p.getContent();
          }
        } catch (e) {}
      }
      // also pick up any properties that look like bank/upkeep values
      out.props = {};
      for (const k of Object.keys(m)) {
        try {
          const v = m[k];
          if (typeof v === "string" && /bank|upkeep|balance|gold|money|town|nation/i.test(k)) out.props[k] = v;
        } catch(e){}
      }
      return out;
    });
  });

  console.log("Markers found via JS objects:", markersData.length);

  // If markersData is empty, fallback to minimal click approach but only on marker icons in DOM
  let extracted = [];
  if (markersData && markersData.length > 0) {
    // Parse popup HTML / text for each marker quickly in Node
    for (const m of markersData) {
      const txt = (m.popup || "") + " " + JSON.stringify(m.props || {});
      // rough text normalization
      const norm = ("" + txt).replace(/\s+/g, " ").trim();

      // Heuristics to detect town popups (required)
      // - must contain some name (alphabetic) and bank/upkeep keywords OR small HTML with bank/upkeep
      const looksLikeTown = /bank|upkeep|Balance|Upkeep|Town|Nation|Member of|Bank:/i.test(norm) ||
                            (m.name && /^[A-Za-z0-9' \-\u00C0-\u024F]{3,40}$/.test(m.name));
      if (!looksLikeTown) continue;

      // Pull basic values from popup HTML/text
      const townName = m.name || (norm.match(/<b[^>]*>([^<]{2,60})<\/b>/i) || norm.match(/^(.*?)\s{1,2}\—/))?.[1] || (norm.match(/Town[:\s-]*([A-Za-z0-9' \-]{2,60})/i) || [null,null])[1];

      // find Bank and Upkeep numbers in text
      const bankMatch = norm.match(/Bank[:\s]*([-\d,\.]+)/i) || norm.match(/Balance[:\s]*([-\d,\.]+)/i) || norm.match(/bank[^0-9]*([0-9\.,]+)/i);
      const upkeepMatch = norm.match(/Upkeep[:\s]*([-\d,\.]+)/i) || norm.match(/upkeep[^0-9]*([0-9\.,]+)/i);

      const bankVal = bankMatch ? parseFloat(bankMatch[1].replace(/,/g,'')) : (norm.match(/([0-9\.,]{1,20})\s*(?:upkeep|/i)?) ? null : null);
      const upkeepVal = upkeepMatch ? parseFloat(upkeepMatch[1].replace(/,/g,'')) : null;

      extracted.push({
        town: townName ? townName.trim() : (m.name || null),
        nation: (norm.match(/Nation[:\s]*([A-Za-z0-9' \-]{2,60})/i) || norm.match(/Member of[:\s]*([A-Za-z0-9' \-]{2,60})/i) || [null,null])[1] || null,
        bank: Number.isFinite(bankVal) ? bankVal : null,
        upkeep: Number.isFinite(upkeepVal) ? upkeepVal : null,
        lat: m.lat, lng: m.lng,
        raw: m.__raw,
      });
    }
  } else {
    // Fallback: find DOM markers and click them BUT we will do it smartly (only markers that look like town icons)
    console.log("Fallback: no JS marker structures found — doing DOM quick click scan.");
    // find candidate marker elements (Leaflet marker icons)
    const markerElements = await page.$$(".leaflet-marker-icon, .marker, [class*='marker']");
    console.log("DOM markers found:", markerElements.length);
    const seenNames = new Set();
    for (let i = 0; i < markerElements.length; ++i) {
      try {
        const el = markerElements[i];
        await el.scrollIntoViewIfNeeded();
        await el.click({ timeout: 2000 }).catch(()=>{});
        await page.waitForTimeout(40);
        // read popup content
        const popupEl = await page.$(".leaflet-popup-content, .la-popup-content, .marker-popup, .leaflet-popup");
        let txt = "";
        if (popupEl) txt = await popupEl.innerText();
        // simple filter for town-like popup
        if (!/bank|upkeep|Town|Nation|Member of|Balance/i.test(txt)) continue;
        // parse some fields
        const town = (txt.match(/^([^\n<]{2,60})/) || [null,null])[1] || null;
        const bankM = txt.match(/Bank[:\s]*([-\d,\.]+)/i) || txt.match(/Balance[:\s]*([-\d,\.]+)/i);
        const upkeepM = txt.match(/Upkeep[:\s]*([-\d,\.]+)/i);
        const bank = bankM ? parseFloat(bankM[1].replace(/,/g,'')) : null;
        const upkeep = upkeepM ? parseFloat(upkeepM[1].replace(/,/g,'')) : null;
        if (town && !seenNames.has(town)) {
          seenNames.add(town);
          extracted.push({ town: town.trim(), nation: (txt.match(/Nation[:\s]*([^\n]+)/i)||[null,null])[1]||null, bank, upkeep, raw: txt });
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // Post-process: normalize + compute days and filter duplicates
  const byName = new Map();
  for (const t of extracted) {
    if (!t.town) continue;
    const key = (t.town || "").trim();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, t);
    else {
      // merge prefer values present
      const cur = byName.get(key);
      if (!cur.bank && t.bank) cur.bank = t.bank;
      if (!cur.upkeep && t.upkeep) cur.upkeep = t.upkeep;
      if (!cur.nation && t.nation) cur.nation = t.nation;
    }
  }

  const final = [];
  for (const [name, obj] of byName.entries()) {
    const bank = (obj.bank == null) ? null : Number(obj.bank);
    const upkeep = (obj.upkeep == null) ? null : Number(obj.upkeep);
    const days = computeDays(bank, upkeep);
    final.push({
      town: name,
      nation: obj.nation || null,
      bank: bank,
      upkeep: upkeep,
      days_rounded: days,
      lat: obj.lat || null,
      lng: obj.lng || null,
    });
  }

  // write out
  await fs.writeFile(OUTFILE, JSON.stringify({ scraped_at: new Date().toISOString(), source: MAP_URL, towns: final }, null, 2));
  console.log(`Wrote ${final.length} towns to ${OUTFILE}`);

  await browser.close();
  process.exit(0);
})();
