// Sector Z-Score Dashboard v3 - Optimized
// Parallel loading + proxy racing for speed

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

// 24 hour cache (more aggressive)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _cache = new Map();

// Try to load cache from localStorage on startup
try {
    const saved = localStorage.getItem('priceCache');
    if (saved) {
        const parsed = JSON.parse(saved);
        Object.entries(parsed).forEach(([k, v]) => {
            if (Date.now() - v.ts < CACHE_TTL_MS) {
                v.data = v.data.map(p => ({ ...p, date: new Date(p.date) }));
                _cache.set(k, v);
            }
        });
    }
} catch (e) {}

function saveCache() {
    try {
        const obj = {};
        _cache.forEach((v, k) => { obj[k] = v; });
        localStorage.setItem('priceCache', JSON.stringify(obj));
    } catch (e) {}
}

// Race multiple proxies - use fastest response
async function fetchWithRace(url, timeoutMs = 12000) {
    const proxies = [
        `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        `https://corsproxy.io/?${encodeURIComponent(url)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ];
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await Promise.any(
            proxies.map(async (proxyUrl) => {
                const res = await fetch(proxyUrl, { 
                    signal: controller.signal,
                    headers: { 'Accept': 'application/json' }
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const text = await res.text();
                if (!text.trim().startsWith('{') && !text.trim().startsWith('[') && !text.trim().startsWith('Date,')) {
                    throw new Error('Not valid data');
                }
                return text;
            })
        );
        clearTimeout(timeout);
        return response;
    } catch (e) {
        clearTimeout(timeout);
        throw new Error('All proxies failed');
    }
}

async function fetchYahoo(ticker) {
    const cacheKey = `y:${ticker}`;
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

    const p2 = Math.floor(Date.now() / 1000);
    const p1 = p2 - Math.floor(15 * 365.25 * 24 * 60 * 60);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1wk&includeAdjustedClose=true`;

    const text = await fetchWithRace(url);
    const data = JSON.parse(text);

    if (data?.chart?.error) throw new Error(data.chart.error.description);
    
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No data');

    const ts = result.timestamp || [];
    const closes = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close || [];

    const prices = [];
    for (let i = 0; i < ts.length; i++) {
        if (closes[i] != null && closes[i] > 0) {
            prices.push({ date: new Date(ts[i] * 1000), close: closes[i] });
        }
    }

    if (prices.length < 50) throw new Error('Insufficient data');

    _cache.set(cacheKey, { ts: Date.now(), data: prices });
    saveCache();
    return prices;
}

async function fetchStooq(ticker) {
    const cacheKey = `s:${ticker}`;
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

    const sym = ticker.includes('.') ? ticker.toLowerCase() : `${ticker.toLowerCase()}.us`;
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=w`;

    const text = await fetchWithRace(url, 15000);
    
    if (!text.startsWith('Date,')) throw new Error('Invalid CSV');

    const lines = text.split(/\r?\n/);
    const header = lines.shift().split(',');
    const iDate = header.indexOf('Date');
    const iClose = header.indexOf('Close');

    const prices = [];
    for (const line of lines) {
        const cols = line.split(',');
        const close = Number(cols[iClose]);
        if (cols[iDate] && Number.isFinite(close) && close > 0) {
            prices.push({ date: new Date(cols[iDate]), close });
        }
    }
    prices.sort((a, b) => a.date - b.date);

    if (prices.length < 50) throw new Error('Insufficient data');

    _cache.set(cacheKey, { ts: Date.now(), data: prices });
    saveCache();
    return prices;
}

async function fetchPrices(ticker) {
    const yahooKey = `y:${ticker}`;
    const stooqKey = `s:${ticker}`;
    
    if (_cache.has(yahooKey) && Date.now() - _cache.get(yahooKey).ts < CACHE_TTL_MS) {
        return _cache.get(yahooKey).data;
    }
    if (_cache.has(stooqKey) && Date.now() - _cache.get(stooqKey).ts < CACHE_TTL_MS) {
        return _cache.get(stooqKey).data;
    }

    try {
        return await fetchYahoo(ticker);
    } catch (e) {
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
        if (prev && cur) {
            returns.push({ date: prices[i].date, value: ((cur / prev) - 1) * 100 });
        }
    }
    return returns;
}

function calculateRelativeReturns(sectorReturns, benchReturns) {
    const benchMap = new Map();
    benchReturns.forEach(r => {
        benchMap.set(`${r.date.getFullYear()}-${r.date.getMonth()}-${r.date.getDate()}`, r.value);
    });
    
    return sectorReturns.map(r => {
        const key = `${r.date.getFullYear()}-${r.date.getMonth()}-${r.date.getDate()}`;
        let benchVal = benchMap.get(key);
        if (benchVal === undefined) {
            for (let o = 1; o <= 7 && benchVal === undefined; o++) {
                const d = new Date(r.date);
                d.setDate(d.getDate() - o);
                benchVal = benchMap.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
            }
        }
        return benchVal !== undefined ? { date: r.date, value: r.value - benchVal } : null;
    }).filter(Boolean);
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
                value: Math.max(-6, Math.min(6, (returns[i].value - mean) / std))
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

function calculateSectorZScore(sectorPrices) {
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

async function toggleSector(sector) {
    const idx = activeSectors.findIndex(s => s.ticker === sector.ticker);
    if (idx >= 0) {
        activeSectors.splice(idx, 1);
        delete sectorData[sector.ticker];
        if (charts[sector.ticker]) {
            charts[sector.ticker].destroy();
            delete charts[sector.ticker];
        }
        initSectorTags();
        renderCharts();
        updateReadings();
        saveState();
    } else {
        activeSectors.push(sector);
        initSectorTags();
        renderCharts();
        
        try {
            setStatus('loading', `Loading ${sector.ticker}...`);
            const prices = await fetchPrices(sector.ticker);
            sectorData[sector.ticker] = calculateSectorZScore(prices);
            setStatus('ready', 'Ready');
        } catch (e) {
            sectorData[sector.ticker] = [];
            setStatus('error', `Failed: ${sector.ticker}`);
            setTimeout(() => setStatus('ready', 'Ready'), 2000);
        }
        
        renderCharts();
        updateReadings();
        saveState();
    }
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
        const newSector = { ticker, name: nameInput.value.trim() || ticker, color: generateColor(), custom: true };
        toggleSector(newSector);
    }
    
    tickerInput.value = '';
    nameInput.value = '';
}

function removeCustomSector(ticker) {
    const sector = activeSectors.find(s => s.ticker === ticker);
    if (sector) toggleSector(sector);
}

// PARALLEL loading - much faster!
async function refreshAllData() {
    if (isLoading) return;
    isLoading = true;
    
    const startTime = Date.now();
    
    try {
        const benchmark = document.getElementById('benchmark').value;
        setStatus('loading', `Loading ${benchmark}...`);
        
        benchmarkPrices = await fetchPrices(benchmark);
        
        setStatus('loading', `Loading ${activeSectors.length} sectors...`);
        
        // Load ALL sectors in parallel!
        const results = await Promise.allSettled(
            activeSectors.map(async (sector) => {
                const prices = await fetchPrices(sector.ticker);
                return { ticker: sector.ticker, data: calculateSectorZScore(prices) };
            })
        );
        
        results.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                sectorData[result.value.ticker] = result.value.data;
            } else {
                sectorData[activeSectors[i].ticker] = [];
                console.error(`Failed: ${activeSectors[i].ticker}`, result.reason);
            }
        });
        
        renderCharts();
        updateReadings();
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        document.getElementById('lastUpdated').textContent = `Loaded in ${elapsed}s`;
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
        container.innerHTML = `<div class="no-charts"><p>No sectors selected</p><p style="font-size: 0.8rem;">Click sectors above to add them</p></div>`;
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
                    ${hasError ? `<div class="error">Failed to load</div>` :
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
    
    // Calculate average Z-score across all active sectors for each date
    const avgData = calculateAverageZScore(data);
    
    charts[ticker] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            datasets: [
                {
                    data: data.map(d => ({ x: d.date, y: d.value })),
                    borderColor: color,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    order: 1
                },
                {
                    data: avgData,
                    borderColor: 'rgba(255, 255, 255, 0.3)',
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.1,
                    borderDash: [4, 4],
                    order: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: ctx => ctx[0].raw.x.toLocaleDateString(),
                        label: ctx => ctx.datasetIndex === 0 ? `Z-Score: ${ctx.parsed.y.toFixed(2)}` : `Avg: ${ctx.parsed.y.toFixed(2)}`
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'year', displayFormats: { year: 'yyyy' } },
                    grid: { color: '#1a1a2e' },
                    ticks: { color: '#555', maxTicksLimit: 8 }
                },
                y: {
                    min: -6, max: 6,
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

// Calculate average Z-score across all sectors for overlay
function calculateAverageZScore(currentData) {
    if (activeSectors.length <= 1) return [];
    
    // Build a map of date -> array of values
    const dateMap = new Map();
    
    activeSectors.forEach(sector => {
        const data = sectorData[sector.ticker];
        if (!data) return;
        
        data.forEach(d => {
            const key = d.date.getTime();
            if (!dateMap.has(key)) {
                dateMap.set(key, []);
            }
            dateMap.get(key).push(d.value);
        });
    });
    
    // Calculate average for each date
    const avgData = [];
    dateMap.forEach((values, timestamp) => {
        if (values.length >= 2) {
            const avg = values.reduce((a, b) => a + b, 0) / values.length;
            avgData.push({ x: new Date(timestamp), y: avg });
        }
    });
    
    return avgData.sort((a, b) => a.x - b.x);
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
