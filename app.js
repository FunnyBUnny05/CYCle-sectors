// Sector Z-Score Dashboard v2
// With Yahoo + Stooq fallback, caching, retries

const AVAILABLE_SECTORS = [
    { ticker: 'XLB', name: 'Materials', color: '#f97316' },
    { ticker: 'XLE', name: 'Energy', color: '#3b82f6' },
    { ticker: 'XLF', name: 'Financials', color: '#a855f7' },
    { ticker: 'XLI', name: 'Industrials', color: '#06b6d4' },
    { ticker: 'XLK', name: 'Technology', color: '#10b981' },
    { ticker: 'XLP', name: 'Consumer Staples', color: '#f59e0b' },
    { ticker: 'XLU', name: 'Utilities', color: '#6366f1' },
    { ticker: 'XLV', name: 'Healthcare', color: '#ec4899' },
    { ticker: 'XLY', name: 'Consumer Disc', color: '#14b8a6' },
    { ticker: 'XLRE', name: 'Real Estate', color: '#8b5cf6' },
    { ticker: 'XLC', name: 'Communication', color: '#f43f5e' },
    { ticker: 'SMH', name: 'Semiconductors', color: '#22d3ee' },
    { ticker: 'XHB', name: 'Homebuilders', color: '#a3e635' },
    { ticker: 'XOP', name: 'Oil & Gas E&P', color: '#fbbf24' },
    { ticker: 'XME', name: 'Metals & Mining', color: '#fb923c' },
    { ticker: 'KRE', name: 'Regional Banks', color: '#c084fc' },
    { ticker: 'XBI', name: 'Biotech', color: '#f472b6' },
    { ticker: 'ITB', name: 'Home Construction', color: '#4ade80' },
    { ticker: 'IYT', name: 'Transportation', color: '#38bdf8' },
];

let activeSectors = [];
let sectorData = {};
let charts = {};
let benchmarkPrices = null;
let isLoading = false;

// Cache with 6 hour TTL
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const _cache = new Map();

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
        clearTimeout(t);
    }
}

function isLikelyJson(text) {
    const s = text.trim();
    return s.startsWith('{') || s.startsWith('[');
}

// Yahoo Finance fetch with retries
async function fetchYahoo(ticker) {
    const cacheKey = `yahoo:${ticker}`;
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

    const years = 15;
    const p2 = Math.floor(Date.now() / 1000);
    const p1 = p2 - Math.floor(years * 365.25 * 24 * 60 * 60);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1wk&includeAdjustedClose=true`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetchWithTimeout(proxyUrl, { headers: { Accept: 'application/json' } }, 15000);
            if (!res.ok) throw new Error(`Yahoo proxy HTTP ${res.status}`);

            const text = await res.text();
            if (!isLikelyJson(text)) {
                throw new Error(`Yahoo returned non-JSON (rate-limit/proxy issue)`);
            }

            const data = JSON.parse(text);

            if (data?.chart?.error) {
                throw new Error(`Yahoo error: ${data.chart.error.description || data.chart.error.code}`);
            }

            const result = data?.chart?.result?.[0];
            if (!result) throw new Error('Yahoo: missing chart.result[0]');

            const ts = result.timestamp || [];
            const closes = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close || [];

            const prices = [];
            for (let i = 0; i < ts.length; i++) {
                const c = closes[i];
                if (c != null && c > 0) prices.push({ date: new Date(ts[i] * 1000), close: c });
            }

            if (prices.length < 60) throw new Error(`Yahoo: too few data points for ${ticker} (${prices.length})`);

            _cache.set(cacheKey, { ts: Date.now(), data: prices });
            return prices;
        } catch (e) {
            lastErr = e;
            await sleep(350 * attempt);
        }
    }
    throw lastErr;
}

// Stooq fallback (CSV)
function toStooqSymbol(ticker) {
    const t = ticker.trim();
    if (t.includes('.')) return t.toLowerCase();
    return `${t.toLowerCase()}.us`;
}

async function fetchStooq(ticker) {
    const cacheKey = `stooq:${ticker}`;
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

    const sym = toStooqSymbol(ticker);
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=w`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;

    const res = await fetchWithTimeout(proxyUrl, {}, 15000);
    if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);

    const csv = (await res.text()).trim();
    if (!csv.startsWith('Date,')) {
        throw new Error(`Stooq returned unexpected content for ${ticker}`);
    }

    const lines = csv.split(/\r?\n/);
    const header = lines.shift().split(',');
    const iDate = header.indexOf('Date');
    const iClose = header.indexOf('Close');

    const prices = [];
    for (const line of lines) {
        const cols = line.split(',');
        const d = cols[iDate];
        const c = cols[iClose];
        const close = Number(c);
        if (!d || !Number.isFinite(close) || close <= 0) continue;
        prices.push({ date: new Date(d), close });
    }

    prices.sort((a, b) => a.date - b.date);

    if (prices.length < 60) throw new Error(`Stooq: too few data points for ${ticker} (${prices.length})`);

    _cache.set(cacheKey, { ts: Date.now(), data: prices });
    return prices;
}

// Main fetch with fallback
async function fetchPrices(ticker) {
    try {
        return await fetchYahoo(ticker);
    } catch (e1) {
        console.log(`Yahoo failed for ${ticker}, trying Stooq...`);
        return await fetchStooq(ticker);
    }
}

function generateColor() {
    return `hsl(${Math.random() * 360}, 70%, 60%)`;
}

function calculateRollingReturn(prices, weeks) {
    const returns = [];
    for (let i = weeks; i < prices.length; i++) {
        const prev = prices[i - weeks]?.close;
        const cur = prices[i]?.close;
        if (!prev || !cur) continue;
        returns.push({ date: prices[i].date, value: ((cur / prev) - 1) * 100 });
    }
    return returns;
}

function calculateRelativeReturns(sectorReturns, benchReturns) {
    const benchMap = new Map();
    benchReturns.forEach(r => {
        const key = `${r.date.getFullYear()}-${r.date.getMonth()}-${r.date.getDate()}`;
        benchMap.set(key, r.value);
    });
    
    return sectorReturns
        .map(r => {
            const key = `${r.date.getFullYear()}-${r.date.getMonth()}-${r.date.getDate()}`;
            let benchVal = benchMap.get(key);
            
            if (benchVal === undefined) {
                for (let offset = 1; offset <= 7 && benchVal === undefined; offset++) {
                    const d = new Date(r.date);
                    d.setDate(d.getDate() - offset);
                    benchVal = benchMap.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
                }
            }
            
            return benchVal !== undefined ? { date: r.date, value: r.value - benchVal } : null;
        })
        .filter(Boolean);
}

function calculateZScore(returns, windowWeeks) {
    const zscores = [];
    const minWindow = Math.min(windowWeeks, Math.floor(returns.length * 0.3));
    
    for (let i = minWindow; i < returns.length; i++) {
        const window = returns.slice(Math.max(0, i - windowWeeks), i).map(r => r.value);
        if (window.length < 20) continue;
        
        const mean = window.reduce((a, b) => a + b, 0) / window.length;
        const std = Math.sqrt(window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window.length);
        
        if (std > 0.5) {
            zscores.push({
                date: returns[i].date,
                value: Math.max(-4, Math.min(4, (returns[i].value - mean) / std)),
                relativeReturn: returns[i].value
            });
        }
    }
    return zscores;
}

function resampleMonthly(data) {
    const monthly = new Map();
    data.forEach(d => {
        const key = `${d.date.getFullYear()}-${String(d.date.getMonth() + 1).padStart(2, '0')}`;
        monthly.set(key, d);
    });
    return Array.from(monthly.values()).sort((a, b) => a.date - b.date);
}

async function calculateSectorZScore(sectorPrices) {
    const returnYears = parseInt(document.getElementById('returnPeriod').value);
    const zscoreYears = parseInt(document.getElementById('zscoreWindow').value);
    
    const returnWeeks = Math.round(returnYears * 52);
    const zscoreWeeks = Math.round(zscoreYears * 52);
    
    const sectorReturns = calculateRollingReturn(sectorPrices, returnWeeks);
    const benchReturns = calculateRollingReturn(benchmarkPrices, returnWeeks);
    const relativeReturns = calculateRelativeReturns(sectorReturns, benchReturns);
    const zscores = calculateZScore(relativeReturns, zscoreWeeks);
    
    return resampleMonthly(zscores);
}

function initSectorTags() {
    const container = document.getElementById('sectorTags');
    container.innerHTML = '';
    
    AVAILABLE_SECTORS.forEach(sector => {
        const isActive = activeSectors.some(s => s.ticker === sector.ticker);
        const tag = document.createElement('div');
        tag.className = `sector-tag ${isActive ? 'active' : ''}`;
        tag.style.setProperty('--sector-color', sector.color);
        tag.innerHTML = `<div class="dot" style="background: ${sector.color}"></div><span>${sector.ticker}</span>`;
        tag.onclick = () => toggleSector(sector);
        container.appendChild(tag);
    });
    
    activeSectors.filter(s => s.custom).forEach(sector => {
        const tag = document.createElement('div');
        tag.className = 'sector-tag active';
        tag.style.setProperty('--sector-color', sector.color);
        tag.innerHTML = `
            <div class="dot" style="background: ${sector.color}"></div>
            <span>${sector.ticker}</span>
            <span class="remove" onclick="event.stopPropagation(); removeCustomSector('${sector.ticker}')">×</span>
        `;
        container.appendChild(tag);
    });
}

function toggleSector(sector) {
    const idx = activeSectors.findIndex(s => s.ticker === sector.ticker);
    if (idx >= 0) {
        activeSectors.splice(idx, 1);
        delete sectorData[sector.ticker];
        if (charts[sector.ticker]) {
            charts[sector.ticker].destroy();
            delete charts[sector.ticker];
        }
    } else {
        activeSectors.push(sector);
        loadSectorData(sector);
    }
    initSectorTags();
    renderCharts();
    updateReadings();
    saveState();
}

function addCustomTicker() {
    const tickerInput = document.getElementById('customTicker');
    const nameInput = document.getElementById('customName');
    
    const ticker = tickerInput.value.toUpperCase().trim();
    if (!ticker) return;
    
    if (activeSectors.some(s => s.ticker === ticker)) {
        tickerInput.value = '';
        nameInput.value = '';
        return;
    }
    
    const existing = AVAILABLE_SECTORS.find(s => s.ticker === ticker);
    if (existing) {
        toggleSector(existing);
    } else {
        const newSector = { 
            ticker, 
            name: nameInput.value.trim() || ticker, 
            color: generateColor(), 
            custom: true 
        };
        activeSectors.push(newSector);
        loadSectorData(newSector);
        initSectorTags();
        renderCharts();
        saveState();
    }
    
    tickerInput.value = '';
    nameInput.value = '';
}

function removeCustomSector(ticker) {
    const idx = activeSectors.findIndex(s => s.ticker === ticker);
    if (idx >= 0) {
        activeSectors.splice(idx, 1);
        delete sectorData[ticker];
        if (charts[ticker]) {
            charts[ticker].destroy();
            delete charts[ticker];
        }
        initSectorTags();
        renderCharts();
        updateReadings();
        saveState();
    }
}

async function loadSectorData(sector) {
    try {
        setStatus('loading', `Loading ${sector.ticker}...`);
        const prices = await fetchPrices(sector.ticker);
        const zscores = await calculateSectorZScore(prices);
        sectorData[sector.ticker] = zscores;
        renderCharts();
        updateReadings();
        setStatus('ready', 'Ready');
    } catch (err) {
        console.error(`Error loading ${sector.ticker}:`, err);
        sectorData[sector.ticker] = [];
        renderCharts();
        setStatus('error', `Failed: ${sector.ticker}`);
        setTimeout(() => setStatus('ready', 'Ready'), 2000);
    }
}

async function refreshAllData() {
    if (isLoading) return;
    isLoading = true;
    
    try {
        const benchmark = document.getElementById('benchmark').value;
        setStatus('loading', `Loading ${benchmark}...`);
        
        benchmarkPrices = await fetchPrices(benchmark);
        console.log(`Loaded ${benchmarkPrices.length} weeks of ${benchmark}`);
        
        for (const sector of activeSectors) {
            await loadSectorData(sector);
        }
        
        document.getElementById('lastUpdated').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
        setStatus('ready', 'Ready');
    } catch (err) {
        console.error('Refresh error:', err);
        setStatus('error', err.message);
    }
    
    isLoading = false;
}

function setStatus(status, text) {
    const dot = document.getElementById('statusDot');
    const textEl = document.getElementById('statusText');
    dot.className = 'status-dot' + (status === 'loading' ? ' loading' : status === 'error' ? ' error' : '');
    textEl.textContent = text;
}

function renderCharts() {
    const container = document.getElementById('chartsContainer');
    
    if (activeSectors.length === 0) {
        container.innerHTML = `<div class="no-charts"><p>No sectors selected</p><p style="font-size: 0.8rem;">Click on sectors above to add them</p></div>`;
        return;
    }
    
    let html = '';
    activeSectors.forEach(sector => {
        const data = sectorData[sector.ticker];
        const current = data?.[data.length - 1]?.value;
        const valueClass = current === undefined ? '' : current < -1 ? 'negative' : current > 1 ? 'positive' : 'neutral';
        const valueStr = current !== undefined ? `${current >= 0 ? '+' : ''}${current.toFixed(2)}` : '...';
        const hasError = data && data.length === 0;
        
        html += `
            <div class="chart-panel" id="panel-${sector.ticker}">
                <div class="chart-header">
                    <h3 style="color: ${sector.color}">${sector.name} <span class="ticker">${sector.ticker}</span></h3>
                    <span class="current-value ${valueClass}">${valueStr}</span>
                </div>
                <div class="chart-wrapper">
                    ${hasError ? `<div class="error">Failed to load data</div>` :
                      data && data.length > 0 ? `<canvas id="chart-${sector.ticker}"></canvas>` :
                      `<div class="loading">Loading...</div>`}
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
    
    activeSectors.forEach(sector => {
        const data = sectorData[sector.ticker];
        if (data && data.length > 0) {
            createChart(sector.ticker, data, sector.color);
        }
    });
}

function createChart(ticker, data, color) {
    const canvas = document.getElementById(`chart-${ticker}`);
    if (!canvas) return;
    
    if (charts[ticker]) charts[ticker].destroy();
    
    charts[ticker] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            datasets: [{
                data: data.map(d => ({ x: d.date, y: d.value })),
                borderColor: color,
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: ctx => ctx[0].raw.x.toLocaleDateString(),
                        label: ctx => `Z-Score: ${ctx.parsed.y.toFixed(2)}`
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'year', displayFormats: { year: 'yyyy' } },
                    grid: { color: '#1a1a2e' },
                    ticks: { color: '#555', maxTicksLimit: 10 }
                },
                y: {
                    min: -4, max: 4,
                    grid: { color: '#1a1a2e' },
                    ticks: { color: '#555' }
                }
            }
        },
        plugins: [{
            id: 'refLines',
            beforeDraw: chart => {
                const ctx = chart.ctx, y = chart.scales.y, x = chart.scales.x;
                ctx.save();
                ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(x.left, y.getPixelForValue(0)); ctx.lineTo(x.right, y.getPixelForValue(0)); ctx.stroke();
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = '#ef4444';
                ctx.beginPath(); ctx.moveTo(x.left, y.getPixelForValue(-2)); ctx.lineTo(x.right, y.getPixelForValue(-2)); ctx.stroke();
                ctx.strokeStyle = '#22c55e';
                ctx.beginPath(); ctx.moveTo(x.left, y.getPixelForValue(2)); ctx.lineTo(x.right, y.getPixelForValue(2)); ctx.stroke();
                ctx.restore();
            }
        }]
    });
}

function updateReadings() {
    const container = document.getElementById('currentReadings');
    
    if (activeSectors.length === 0) {
        container.innerHTML = `<div style="color: #666; font-size: 0.85rem; text-align: center; padding: 20px;">Select sectors</div>`;
        return;
    }
    
    const sorted = [...activeSectors].sort((a, b) => {
        const aVal = sectorData[a.ticker]?.slice(-1)[0]?.value ?? 999;
        const bVal = sectorData[b.ticker]?.slice(-1)[0]?.value ?? 999;
        return aVal - bVal;
    });
    
    container.innerHTML = sorted.map(sector => {
        const current = sectorData[sector.ticker]?.slice(-1)[0]?.value;
        if (current === undefined) {
            return `<div class="sector-row"><div class="sector-name"><div class="sector-dot" style="background: ${sector.color}"></div><span>${sector.ticker}</span></div><div class="sector-values"><div class="zscore-value neutral">...</div></div></div>`;
        }
        
        const [signal, signalClass] = current < -2 ? ['CYCLICAL LOW', 'cyclical-low'] : 
            current < -1 ? ['CHEAP', 'cheap'] : current > 2 ? ['EXTENDED', 'extended'] : ['NEUTRAL', 'neutral'];
        const valueClass = current < -1 ? 'negative' : current > 1 ? 'positive' : 'neutral';
        
        return `<div class="sector-row"><div class="sector-name"><div class="sector-dot" style="background: ${sector.color}"></div><span>${sector.ticker}</span></div><div class="sector-values"><div class="zscore-value ${valueClass}">${current >= 0 ? '+' : ''}${current.toFixed(2)}</div><div class="signal-badge ${signalClass}">${signal}</div></div></div>`;
    }).join('');
}

function saveState() {
    try {
        localStorage.setItem('sectorZScoreState', JSON.stringify({
            activeSectors: activeSectors.map(s => ({ ticker: s.ticker, name: s.name, color: s.color, custom: s.custom }))
        }));
    } catch (e) {}
}

function loadState() {
    try {
        const saved = localStorage.getItem('sectorZScoreState');
        if (saved) {
            activeSectors = JSON.parse(saved).activeSectors || [];
        } else {
            activeSectors = ['XLB', 'XLE', 'XLF'].map(t => AVAILABLE_SECTORS.find(s => s.ticker === t)).filter(Boolean);
        }
    } catch (e) {
        activeSectors = [];
    }
}

document.getElementById('returnPeriod').addEventListener('change', refreshAllData);
document.getElementById('zscoreWindow').addEventListener('change', refreshAllData);
document.getElementById('benchmark').addEventListener('change', refreshAllData);
document.getElementById('customTicker').addEventListener('keypress', e => { if (e.key === 'Enter') addCustomTicker(); });

loadState();
initSectorTags();
renderCharts();
refreshAllData();
