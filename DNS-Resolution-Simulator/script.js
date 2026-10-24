"use strict";

const dnsRecords = [
  { domain: "www.google.com", ip: "142.250.183.36", ttl: 300 },
  { domain: "www.example.com", ip: "93.184.216.34", ttl: 300 },
  { domain: "www.github.com", ip: "140.82.112.3", ttl: 300 },
  { domain: "mail.example.com", ip: "192.0.2.25", ttl: 300 },
  { domain: "api.example.com", ip: "192.0.2.50", ttl: 300 }
];

const cache = new Map();
const history = [];
const MAX_HISTORY = 100;
const STAGES = ["client", "resolver", "root", "tld", "authoritative"];
const stageElements = new Map(
  STAGES.map((stage) => [stage, document.querySelector(`[data-stage="${stage}"]`)])
);

let totalQueries = 0;
let cacheHits = 0;
let queryInProgress = false;

const elements = {
  queryForm: document.querySelector("#query-form"),
  domainInput: document.querySelector("#domain-input"),
  ttlInput: document.querySelector("#ttl-input"),
  resolveButton: document.querySelector("#resolve-button"),
  announcement: document.querySelector("#announcement"),
  announcementText: document.querySelector("#announcement-text"),
  totalQueries: document.querySelector("#total-queries"),
  cacheHits: document.querySelector("#cache-hits"),
  cacheEntries: document.querySelector("#cache-entries"),
  resultValue: document.querySelector("#result-value"),
  cacheTableBody: document.querySelector("#cache-table-body"),
  cacheEmpty: document.querySelector("#cache-empty"),
  historyTableBody: document.querySelector("#history-table-body"),
  historyEmpty: document.querySelector("#history-empty"),
  recordsTableBody: document.querySelector("#records-table-body"),
  recordForm: document.querySelector("#record-form"),
  recordDomain: document.querySelector("#new-record-domain"),
  recordIp: document.querySelector("#new-record-ip"),
  recordFeedback: document.querySelector("#record-feedback")
};

function isValidDomain(value) {
  const domain = value.trim();
  if (!domain || domain.length > 253 || !domain.includes(".")) return false;

  return domain.split(".").every((label) =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

function isValidIPv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

function announce(message, kind = "info") {
  elements.announcementText.textContent = message;
  elements.announcement.dataset.kind = kind;
}

function setStage(stage, state, message) {
  const card = stageElements.get(stage);
  if (!card) return;

  const labels = {
    waiting: "Waiting",
    processing: "In progress",
    success: "Complete",
    "cache-hit": "Cache hit",
    failure: "Not found",
    skipped: "Not contacted"
  };
  card.dataset.state = state;
  card.querySelector(".step-status").textContent = labels[state] || "Waiting";
  card.querySelector(".step-message").textContent = message;
}

function resetJourney() {
  setStage("client", "waiting", "A domain lookup will start here.");
  setStage("resolver", "waiting", "Waiting for a client request.");
  setStage("root", "waiting", "Not contacted yet.");
  setStage("tld", "waiting", "Not contacted yet.");
  setStage("authoritative", "waiting", "Not contacted yet.");
  elements.resultValue.textContent = "Waiting for query…";
  delete elements.resultValue.dataset.kind;
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function purgeExpiredCache(now = Date.now()) {
  for (const [domain, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(domain);
  }
}

function appendCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderCache() {
  purgeExpiredCache();
  elements.cacheTableBody.replaceChildren();

  const sortedEntries = [...cache.entries()].sort(([first], [second]) => first.localeCompare(second));
  for (const [domain, entry] of sortedEntries) {
    const row = document.createElement("tr");
    appendCell(row, domain, "domain-cell");
    appendCell(row, entry.ip, "ip-cell");
    const remaining = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    appendCell(row, `${remaining} sec`, "ttl-cell");
    elements.cacheTableBody.append(row);
  }

  elements.cacheEmpty.hidden = sortedEntries.length > 0;
  elements.cacheEntries.textContent = String(sortedEntries.length);
}

function renderHistory() {
  elements.historyTableBody.replaceChildren();
  for (const item of history) {
    const row = document.createElement("tr");
    appendCell(row, String(item.number));
    appendCell(row, item.domain, "domain-cell");
    appendCell(row, item.answer, item.status === "RESOLVED" ? "ip-cell" : "");

    const statusCell = appendCell(row, "");
    const statusPill = document.createElement("span");
    statusPill.className = `status-pill ${item.status.toLowerCase()}`;
    statusPill.textContent = item.status;
    statusCell.append(statusPill);

    const cacheCell = appendCell(row, "");
    const cachePill = document.createElement("span");
    cachePill.className = `cache-pill${item.cache === "MISS" ? " miss" : ""}`;
    cachePill.textContent = item.cache;
    cacheCell.append(cachePill);
    appendCell(row, `${item.duration} ms`);
    appendCell(row, item.timestamp);
    elements.historyTableBody.append(row);
  }

  elements.historyEmpty.hidden = history.length > 0;
}

function renderRecords() {
  elements.recordsTableBody.replaceChildren();
  const sortedRecords = [...dnsRecords].sort((first, second) => first.domain.localeCompare(second.domain));
  for (const record of sortedRecords) {
    const row = document.createElement("tr");
    appendCell(row, record.domain, "domain-cell");
    appendCell(row, "A");
    appendCell(row, record.ip, "ip-cell");
    appendCell(row, `${record.ttl} sec`, "ttl-cell");
    appendCell(row, "Simulated", "source-tag");
    elements.recordsTableBody.append(row);
  }
}

function updateStats() {
  elements.totalQueries.textContent = String(totalQueries);
  elements.cacheHits.textContent = String(cacheHits);
  renderCache();
}

function getRecord(domain) {
  return dnsRecords.find((record) => record.domain.toLowerCase() === domain);
}

async function simulateCacheHit(domain, entry) {
  setStage("client", "processing", `Sending a lookup for ${domain}.`);
  await delay(180);
  setStage("client", "success", "The client sends a recursive query.");
  setStage("resolver", "processing", "Checking its unexpired local cache.");
  await delay(180);
  setStage("resolver", "cache-hit", "A valid cached A record is returned directly.");
  setStage("root", "skipped", "Skipped: the resolver already has a valid answer.");
  setStage("tld", "skipped", "Skipped: no referral lookup is needed.");
  setStage("authoritative", "skipped", "Skipped: no authoritative query is needed.");
  elements.resultValue.textContent = entry.ip;
  elements.resultValue.dataset.kind = "cache";
}

async function simulateFullResolution(domain, record) {
  // On a cache miss, the recursive resolver follows referrals from root to TLD to authority.
  setStage("client", "processing", `Sending a lookup for ${domain}.`);
  await delay(350);
  setStage("client", "success", "The client asks its recursive resolver for an answer.");

  setStage("resolver", "processing", "No valid cached answer; starting iterative lookups.");
  await delay(250);
  setStage("resolver", "success", "Cache miss. The resolver begins following DNS referrals.");

  setStage("root", "processing", "Asking where to find the requested top-level domain.");
  await delay(350);
  setStage("root", "success", "Root referral points the resolver to the TLD servers.");

  setStage("tld", "processing", "Asking which name server is authoritative for this domain.");
  await delay(350);
  setStage("tld", "success", "TLD referral identifies the domain's authoritative server.");

  setStage("authoritative", "processing", `Looking up the A record for ${domain}.`);
  await delay(350);

  if (!record) {
    setStage("authoritative", "failure", "The requested name does not exist (NXDOMAIN).");
    elements.resultValue.textContent = "NXDOMAIN";
    elements.resultValue.dataset.kind = "error";
    return { status: "NXDOMAIN", answer: "NXDOMAIN" };
  }

  setStage("authoritative", "success", `A record found: ${record.ip}. The resolver returns it to the client.`);
  elements.resultValue.textContent = record.ip;
  delete elements.resultValue.dataset.kind;
  return { status: "RESOLVED", answer: record.ip };
}

function formatTimestamp(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function handleQuery(event) {
  event.preventDefault();
  if (queryInProgress) return;

  const domain = elements.domainInput.value.trim().toLowerCase();
  if (!domain) {
    announce("Enter a domain name before starting a lookup.", "error");
    elements.domainInput.focus();
    return;
  }
  if (!isValidDomain(domain)) {
    announce("That domain format is invalid. Use labels such as www.example.com.", "error");
    elements.domainInput.focus();
    return;
  }
  if (!elements.ttlInput.checkValidity()) {
    announce("Cache TTL must be a whole number between 1 and 3,600 seconds.", "error");
    elements.ttlInput.focus();
    return;
  }

  const ttlSeconds = Number(elements.ttlInput.value);
  queryInProgress = true;
  elements.resolveButton.disabled = true;
  elements.resolveButton.innerHTML = "<span aria-hidden=\"true\">…</span> Resolving";
  elements.domainInput.disabled = true;
  elements.ttlInput.disabled = true;
  resetJourney();
  purgeExpiredCache();

  const startedAt = performance.now();
  const queriedAt = new Date();
  let result = { status: "ERROR", answer: "Resolution error", cache: "MISS" };

  try {
    // A valid cache entry short-circuits the DNS hierarchy; expired entries are treated as misses.
    const cached = cache.get(domain);
    if (cached && cached.expiresAt > Date.now()) {
      await simulateCacheHit(domain, cached);
      cacheHits += 1;
      result = { status: "RESOLVED", answer: cached.ip, cache: "HIT" };
      announce(`${domain} resolved from cache: ${cached.ip}. Root, TLD, and authoritative servers were not contacted.`, "cache");
    } else {
      if (cached) cache.delete(domain);
      const record = getRecord(domain);
      const resolution = await simulateFullResolution(domain, record);
      result = { ...resolution, cache: "MISS" };

      if (record) {
        cache.set(domain, { ip: record.ip, expiresAt: Date.now() + ttlSeconds * 1000 });
        announce(`${domain} resolved to ${record.ip}. The successful result is cached for ${ttlSeconds} seconds.`, "success");
      } else {
        announce(`${domain} was not found. The resolver returned NXDOMAIN; failed lookups are not cached.`, "error");
      }
    }
  } catch (error) {
    console.error("DNS simulation failed:", error);
    elements.resultValue.textContent = "Simulation error";
    elements.resultValue.dataset.kind = "error";
    setStage("resolver", "failure", "An unexpected error interrupted the simulation.");
    announce("The lookup could not be completed because of an unexpected simulator error. See the browser console for details.", "error");
  } finally {
    const duration = Math.max(1, Math.round(performance.now() - startedAt));
    totalQueries += 1;
    history.unshift({
      number: totalQueries,
      domain,
      answer: result.answer,
      status: result.status,
      cache: result.cache,
      duration,
      timestamp: formatTimestamp(queriedAt)
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    queryInProgress = false;
    elements.resolveButton.disabled = false;
    elements.resolveButton.innerHTML = "<span aria-hidden=\"true\">↗</span> Resolve DNS";
    elements.domainInput.disabled = false;
    elements.ttlInput.disabled = false;
    renderHistory();
    updateStats();
  }
}

function clearCache() {
  purgeExpiredCache();
  if (cache.size === 0) {
    announce("The DNS cache is already empty.", "info");
    updateStats();
    return;
  }

  const removedCount = cache.size;
  cache.clear();
  updateStats();
  announce(`Cache cleared. ${removedCount} ${removedCount === 1 ? "entry was" : "entries were"} removed.`, "success");
}

function clearHistory() {
  if (history.length === 0) {
    announce("Query history is already empty.", "info");
    return;
  }

  history.length = 0;
  renderHistory();
  announce("Query history cleared. Total Queries remains the lifetime count for this page session.", "success");
}

function addRecord(event) {
  event.preventDefault();
  const domain = elements.recordDomain.value.trim().toLowerCase();
  const ip = elements.recordIp.value.trim();

  if (!isValidDomain(domain)) {
    elements.recordFeedback.textContent = "Enter a valid domain name such as service.example.com.";
    elements.recordFeedback.dataset.kind = "error";
    elements.recordDomain.focus();
    return;
  }
  if (!isValidIPv4(ip)) {
    elements.recordFeedback.textContent = "Enter a valid IPv4 address with four octets from 0 to 255.";
    elements.recordFeedback.dataset.kind = "error";
    elements.recordIp.focus();
    return;
  }
  if (getRecord(domain)) {
    elements.recordFeedback.textContent = "A record for that domain already exists.";
    elements.recordFeedback.dataset.kind = "error";
    elements.recordDomain.focus();
    return;
  }

  dnsRecords.push({ domain, ip, ttl: 300 });
  renderRecords();
  elements.recordForm.reset();
  elements.recordFeedback.textContent = `${domain} → ${ip} added as a simulated A record with a 300-second record TTL.`;
  delete elements.recordFeedback.dataset.kind;
}

elements.queryForm.addEventListener("submit", handleQuery);
document.querySelectorAll(".example-chip").forEach((button) => {
  button.addEventListener("click", () => {
    elements.domainInput.value = button.dataset.domain || "";
    elements.domainInput.focus();
  });
});
document.querySelector("#clear-cache").addEventListener("click", clearCache);
document.querySelector("#clear-history").addEventListener("click", clearHistory);
elements.recordForm.addEventListener("submit", addRecord);

renderRecords();
renderHistory();
updateStats();
window.setInterval(updateStats, 1000);
