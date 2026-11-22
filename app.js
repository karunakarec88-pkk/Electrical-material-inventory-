/* app.js - ElectraStock Application Logic */

// ─────────────────────────────────────────────────────────────────
// IndexedDB Client Storage Engine for Invoices / PO Documents
// Prevents 5MB localStorage QuotaExceededError and guarantees 100%
// refresh persistence for attached PDF and image invoice files.
// ─────────────────────────────────────────────────────────────────
const InvoiceStorage = {
  dbName: 'ElectraStockDB',
  storeName: 'invoices',
  db: null,

  init() {
    return new Promise((resolve) => {
      if (this.db) return resolve(this.db);
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported in this browser.');
        return resolve(null);
      }
      try {
        const request = indexedDB.open(this.dbName, 1);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName);
          }
        };
        request.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(this.db);
        };
        request.onerror = (e) => {
          console.error('IndexedDB open error:', e.target.error);
          resolve(null);
        };
      } catch (err) {
        console.error('IndexedDB init exception:', err);
        resolve(null);
      }
    });
  },

  async saveInvoice(key, fileData, fileName = '') {
    if (!key || !fileData) return false;
    try {
      const db = await this.init();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put({ data: fileData, fileName: fileName, updatedAt: Date.now() }, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = (e) => {
          console.error('IndexedDB put error:', e.target.error);
          resolve(false);
        };
      });
    } catch (err) {
      console.error('Error saving invoice to IndexedDB:', err);
      return false;
    }
  },

  async getInvoice(key) {
    if (!key) return null;
    try {
      const db = await this.init();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(key);
        req.onsuccess = () => {
          resolve(req.result ? req.result.data : null);
        };
        req.onerror = () => resolve(null);
      });
    } catch (err) {
      console.error('Error getting invoice from IndexedDB:', err);
      return null;
    }
  },

  async deleteInvoice(key) {
    if (!key) return false;
    try {
      const db = await this.init();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (err) {
      console.error('Error deleting invoice from IndexedDB:', err);
      return false;
    }
  },

  async hasInvoice(key) {
    if (!key) return false;
    try {
      const db = await this.init();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.count(key);
        req.onsuccess = () => resolve(req.result > 0);
        req.onerror = () => resolve(false);
      });
    } catch (err) {
      return false;
    }
  }
};

/** Auto-cleanup any old bloated base64 data URLs inadvertently stored in localStorage */
function cleanupOversizedLocalStorage() {
  try {
    const rawPurchases = localStorage.getItem('electrastock_purchases');
    if (rawPurchases) {
      const list = JSON.parse(rawPurchases);
      if (Array.isArray(list)) {
        let modified = false;
        list.forEach(p => {
          ['PO Link', 'poLink', 'fileUrl', 'fileData'].forEach(k => {
            if (p[k] && typeof p[k] === 'string' && p[k].startsWith('data:')) {
              const key = makePurchaseKey(p);
              InvoiceStorage.saveInvoice(key, p[k], 'invoice.pdf');
              p['PO Link'] = 'idb:' + key;
              delete p.poLink;
              delete p.fileUrl;
              delete p.fileData;
              modified = true;
            }
          });
          // Sanitize cross-item pointer bleed in electrastock_purchases
          const direct = (p['PO Link'] || p['poLink'] || p['fileUrl'] || '').toString().trim();
          if (direct.startsWith('idb:')) {
            const rawKey = direct.replace('idb:', '');
            if (rawKey.includes('||')) {
              const parts = rawKey.split('||');
              const keyMat = (parts[1] || '').trim().toLowerCase();
              const myMat = (p['Material Name'] || p.name || '').toString().trim().toLowerCase();
              if (myMat && keyMat && keyMat !== myMat) {
                p['PO Link'] = '';
                delete p.poLink;
                delete p.fileUrl;
                modified = true;
              }
            }
          }
        });
        if (modified) {
          localStorage.setItem('electrastock_purchases', JSON.stringify(list));
        }
      }
    }
  } catch (e) {
    console.warn('Cleanup electrastock_purchases warning:', e);
  }

  try {
    const rawOverrides = localStorage.getItem('electrastock_invoice_overrides');
    if (rawOverrides) {
      const overrides = JSON.parse(rawOverrides);
      let ovModified = false;
      Object.keys(overrides).forEach(k => {
        if (overrides[k] && typeof overrides[k] === 'string' && overrides[k].startsWith('data:')) {
          InvoiceStorage.saveInvoice(k, overrides[k], 'invoice.pdf');
          overrides[k] = 'idb:' + k;
          ovModified = true;
        }
        // Remove indent_ keys that actually contain an item key ('||')
        if (k.startsWith('indent_') && overrides[k] && typeof overrides[k] === 'string' && overrides[k].includes('||')) {
          delete overrides[k];
          ovModified = true;
        }
      });
      if (ovModified) {
        localStorage.setItem('electrastock_invoice_overrides', JSON.stringify(overrides));
      }
    }
  } catch (e) {
    console.warn('Cleanup electrastock_invoice_overrides warning:', e);
  }

  try {
    const rawPrev = localStorage.getItem('electrastock_prev_stocks');
    if (rawPrev && rawPrev.includes('data:')) {
      const prevStocks = JSON.parse(rawPrev);
      if (Array.isArray(prevStocks)) {
        prevStocks.forEach(rec => {
          if (rec.poLink && typeof rec.poLink === 'string' && rec.poLink.startsWith('data:')) {
            const key = rec.id || ('PREV-' + Date.now());
            InvoiceStorage.saveInvoice(key, rec.poLink, 'invoice.pdf');
            rec.poLink = 'idb:' + key;
          }
        });
        localStorage.setItem('electrastock_prev_stocks', JSON.stringify(prevStocks));
      }
    }
  } catch (e) {
    console.warn('Cleanup electrastock_prev_stocks warning:', e);
  }
}

// Shared Default Google Apps Script Web App URL across all PCs
// If set, any PC opening the app will automatically connect to this Google Sheet without manual setup!
const DEFAULT_SHEET_URL = 'https://script.google.com/macros/s/AKfycbyqTf5VHcvmmllEyONUmh5Q7M9PqLLD7yTtMDk6olAP6L8_lNrMQtmJZrkjFWHDxX3h/exec';

// Global State
let state = {
  purchases: [],
  usages: [],
  thresholds: {},
  appMode: 'local', // 'local' or 'cloud'
  sheetUrl: '',
  currentUser: null
};

// Table Pagination State
let inventoryPagination = {
  currentPage: 1,
  pageSize: 25,
  filteredItems: []
};

// Chart Instances
let stockChart = null;
let sourceChart = null;

// Helper: Source Badge CSS Class Mapper
function getSourceBadgeClass(source) {
  if (source === 'GEM') return 'in-stock';
  if (source === 'Tender Work') return 'tender-work';
  return 'low-stock';
}

// Initial Mock Data (used if Google Sheets URL is not configured or on Reset)
const DEMO_PURCHASES = [
  { "Indent No": "GEM-2026-981", "Received Date": "2026-06-01", "Material Name": "2.5 sqmm FR Copper Wire", "Make": "Polycab", "Unit": "Coils", "Quantity": 20, "Rate": 1200, "Amount": 24000, "Source": "GEM", "PO Link": "https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs/view?usp=sharing" },
  { "Indent No": "GEM-2026-981", "Received Date": "2026-06-01", "Material Name": "1.5 sqmm FR Copper Wire", "Make": "Polycab", "Unit": "Coils", "Quantity": 25, "Rate": 850, "Amount": 21250, "Source": "GEM", "PO Link": "https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs/view?usp=sharing" },
  { "Indent No": "GEM-2026-981", "Received Date": "2026-06-01", "Material Name": "10 Amp SP MCB", "Make": "Schneider", "Unit": "Nos", "Quantity": 50, "Rate": 120, "Amount": 6000, "Source": "GEM", "PO Link": "https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs/view?usp=sharing" },
  { "Indent No": "LMR-2026-042", "Received Date": "2026-06-15", "Material Name": "6.0 sqmm Armored Cable", "Make": "Havells", "Unit": "Meters", "Quantity": 200, "Rate": 180, "Amount": 36000, "Source": "Local Market", "PO Link": "" },
  { "Indent No": "LMR-2026-045", "Received Date": "2026-07-02", "Material Name": "8-Way DB Double Door", "Make": "Legrand", "Unit": "Nos", "Quantity": 5, "Rate": 1450, "Amount": 7250, "Source": "Local Market", "PO Link": "" },
  { "Indent No": "TND-2026-108", "Received Date": "2026-07-10", "Material Name": "Modular Switch 6A", "Make": "Anchor", "Unit": "Nos", "Quantity": 100, "Rate": 45, "Amount": 4500, "Source": "Tender Work", "PO Link": "" },
  { "Indent No": "TND-2026-108", "Received Date": "2026-07-10", "Material Name": "Modular Socket 6/16A", "Make": "Anchor", "Unit": "Nos", "Quantity": 60, "Rate": 85, "Amount": 5100, "Source": "Tender Work", "PO Link": "" },
  { "Indent No": "LMR-2026-056", "Received Date": "2026-07-15", "Material Name": "32 Amp DP MCB", "Make": "Siemens", "Unit": "Nos", "Quantity": 15, "Rate": 320, "Amount": 4800, "Source": "Local Market", "PO Link": "" },
  { "Indent No": "LMR-2026-011", "Received Date": "2026-05-10", "Material Name": "4.0 sqmm FR Copper Wire", "Make": "Finolex", "Unit": "Coils", "Quantity": 5, "Rate": 1650, "Amount": 8250, "Source": "Local Market", "PO Link": "" },
  { "Indent No": "TND-2026-044", "Received Date": "2026-04-20", "Material Name": "16 Amp SP MCB", "Make": "L&T", "Unit": "Nos", "Quantity": 10, "Rate": 140, "Amount": 1400, "Source": "Tender Work", "PO Link": "" }
];

const DEMO_USAGES = [
  { "Date": "2026-06-05", "Material Name": "2.5 sqmm FR Copper Wire", "Quantity": 5, "Where Used": "Staff Quarters Quarter B-12", "Remarks": "Rewiring bedroom and kitchen" },
  { "Date": "2026-06-08", "Material Name": "1.5 sqmm FR Copper Wire", "Quantity": 8, "Where Used": "Main Office Block A", "Remarks": "Replacing corridor light wiring" },
  { "Date": "2026-06-10", "Material Name": "10 Amp SP MCB", "Quantity": 12, "Where Used": "Staff Quarters - Main DB Panel", "Remarks": "Replaced old faulty MCBs" },
  { "Date": "2026-06-20", "Material Name": "6.0 sqmm Armored Cable", "Quantity": 85, "Where Used": "Electrical Substation — SS-I", "Remarks": "Underground feeder cabling for motor" },
  { "Date": "2026-07-05", "Material Name": "8-Way DB Double Door", "Quantity": 2, "Where Used": "Electrical Substation — SS-II", "Remarks": "Installed new sub-distribution boards" },
  { "Date": "2026-07-12", "Material Name": "Modular Switch 6A", "Quantity": 40, "Where Used": "Electrical Substation — SS-III", "Remarks": "Renovating switchboards in SS-III control room" },
  { "Date": "2026-07-12", "Material Name": "Modular Socket 6/16A", "Quantity": 25, "Where Used": "Conference Hall", "Remarks": "Renovating switchboards" },
  { "Date": "2026-07-16", "Material Name": "32 Amp DP MCB", "Quantity": 4, "Where Used": "Electrical Substation — SS-I", "Remarks": "AC installation main switch replacement" },
  { "Date": "2026-05-25", "Material Name": "4.0 sqmm FR Copper Wire", "Quantity": 4, "Where Used": "Pump House — Internal Pump House", "Remarks": "Motor power cabling replacement" },
  { "Date": "2026-05-15", "Material Name": "16 Amp SP MCB", "Quantity": 10, "Where Used": "Staff Club", "Remarks": "Hall lighting DB repair" },
  { "Date": "2026-06-18", "Material Name": "Modular Switch 6A", "Quantity": 15, "Where Used": "Dispensary", "Remarks": "Doctor consultation room rewiring" },
  { "Date": "2026-06-25", "Material Name": "1.5 sqmm FR Copper Wire", "Quantity": 12, "Where Used": "Street Lights — Incampus Street Lights", "Remarks": "Replacement of damaged pole cabling" },
  { "Date": "2026-07-02", "Material Name": "32 Amp DP MCB", "Quantity": 3, "Where Used": "Street Lights — Outcampus Street Lights", "Remarks": "Timer box switchboard upgrade" },
  { "Date": "2026-07-08", "Material Name": "Modular Switch 6A", "Quantity": 8, "Where Used": "Fire Station", "Remarks": "Control room switch replacement" },
  { "Date": "2026-07-14", "Material Name": "10 Amp SP MCB", "Quantity": 5, "Where Used": "Security", "Remarks": "Main gate guard post DB repair" },
  { "Date": "2026-07-18", "Material Name": "Modular Socket 6/16A", "Quantity": 6, "Where Used": "Post Office", "Remarks": "Counter power sockets installation" },
  { "Date": "2026-07-22", "Material Name": "2.5 sqmm FR Copper Wire", "Quantity": 3, "Where Used": "NEERI", "Remarks": "Lab building connection cabling" },
  { "Date": "2026-07-26", "Material Name": "8-Way DB Double Door", "Quantity": 1, "Where Used": "PPC Moulali", "Remarks": "Sub-station feeder DB installation" }
];

const DEMO_THRESHOLDS = {
  "2.5 sqmm FR Copper Wire": 6,
  "1.5 sqmm FR Copper Wire": 5,
  "4.0 sqmm FR Copper Wire": 2,
  "6.0 sqmm Armored Cable": 50,
  "8-Way DB Double Door": 2,
  "10 Amp SP MCB": 15,
  "16 Amp SP MCB": 3,
  "32 Amp DP MCB": 4,
  "Modular Switch 6A": 20,
  "Modular Socket 6/16A": 15
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  cleanupOversizedLocalStorage();
  loadConfiguration();
  setupEventListeners();
  setDefaultDates();
  startLiveClock();
  loadCustomBuildings();
  
  // Verify user session
  checkLoginStatus();
  
  lucide.createIcons();
});

// Live clock update
function startLiveClock() {
  function tick() {
    const el = document.getElementById('live-datetime');
    if (!el) return;
    const now = new Date();
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const day = days[now.getDay()];
    const date = now.getDate();
    const month = months[now.getMonth()];
    const year = now.getFullYear();
    const h = String(now.getHours()).padStart(2,'0');
    const m = String(now.getMinutes()).padStart(2,'0');
    const s = String(now.getSeconds()).padStart(2,'0');
    el.textContent = `${day}, ${date} ${month} ${year}  ·  ${h}:${m}:${s}`;
  }
  tick();
  setInterval(tick, 1000);
}

// Check if user is logged in
function checkLoginStatus() {
  const role = sessionStorage.getItem('electrastock_role');
  if (role) {
    state.currentUser = role;
    const loginOverlay = document.getElementById('login-overlay');
    if (loginOverlay) loginOverlay.classList.remove('active');
    applyRoleRestrictions();
    
    // Clear and build initial dynamic row
    resetPurchaseForm();
    
    if (state.appMode === 'cloud') {
      syncWithCloud();
    } else {
      loadLocalData();
      updateUI();
    }
  } else {
    state.currentUser = null;
    const loginOverlay = document.getElementById('login-overlay');
    if (loginOverlay) loginOverlay.classList.add('active');
  }
}

// Switch active application tab and synchronize sidebar + home page navigation
function switchTab(targetTab) {
  if (!targetTab) return;
  if (state.currentUser === 'staff' && (targetTab === 'purchases' || targetTab === 'usages' || targetTab === 'settings')) {
    targetTab = 'dashboard';
  }
  const targetPanel = document.getElementById(`${targetTab}-tab`);
  if (!targetPanel) return;

  document.querySelectorAll('.menu-item').forEach(mi => mi.classList.remove('active'));
  const sidebarLink = document.querySelector(`.menu-item[data-tab="${targetTab}"]`);
  if (sidebarLink) sidebarLink.classList.add('active');

  document.querySelectorAll('.home-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === targetTab);
  });

  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
  targetPanel.classList.add('active');

  closeSystemDropdown();

  if (targetTab === 'dashboard') {
    setTimeout(() => updateUI(), 50);
  } else if (targetTab === 'completed-stock') {
    setTimeout(() => renderCompletedStockTab(calculateInventory()), 50);
  }

  const sidebar = document.getElementById('app-sidebar');
  if (sidebar) sidebar.classList.remove('mobile-open');
}

// System dropdown controls
function openSystemDropdown() {
  const menu = document.getElementById('system-dropdown-menu');
  const btn = document.getElementById('system-dropdown-btn');
  if (menu && btn) {
    menu.classList.add('show');
    btn.classList.add('active');
    btn.setAttribute('aria-expanded', 'true');
    if (window.lucide && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
  }
}

function closeSystemDropdown() {
  const menu = document.getElementById('system-dropdown-menu');
  const btn = document.getElementById('system-dropdown-btn');
  if (menu && btn) {
    menu.classList.remove('show');
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  }
}

function toggleSystemDropdown() {
  const menu = document.getElementById('system-dropdown-menu');
  if (menu && menu.classList.contains('show')) {
    closeSystemDropdown();
  } else {
    openSystemDropdown();
  }
}

// Restrict interface tabs and controls based on current role privileges
function applyRoleRestrictions() {
  const roleText = document.getElementById('role-text');
  const roleBadge = document.getElementById('role-badge');
  const topDropdownLabel = document.getElementById('top-dropdown-user-label');
  
  const settingsBtn = document.getElementById('top-settings-btn');
  const homePurchasesBtn = document.querySelector('.home-nav-btn[data-tab="purchases"]');
  const homeUsagesBtn = document.querySelector('.home-nav-btn[data-tab="usages"]');
  
  if (state.currentUser === 'staff') {
    if (topDropdownLabel) topDropdownLabel.textContent = "Staff";
    // Hide administrative inputs
    if (settingsBtn) settingsBtn.classList.add('hidden');
    if (homePurchasesBtn) homePurchasesBtn.classList.add('hidden');
    if (homeUsagesBtn) homeUsagesBtn.classList.add('hidden');
    
    // Fallback to Dashboard tab if loaded in locked tab
    const activeTabLink = document.querySelector('.home-nav-btn.active, .menu-item.active');
    if (activeTabLink) {
      const activeTab = activeTabLink.getAttribute('data-tab');
      if (activeTab === 'purchases' || activeTab === 'usages' || activeTab === 'settings') {
        switchTab('dashboard');
      }
    }
    
    // Style read-only status indicators
    if (roleText) roleText.textContent = "Staff (Read-Only)";
    if (roleBadge) {
      roleBadge.className = "mode-badge local";
      roleBadge.style.color = "var(--warning)";
      roleBadge.style.background = "var(--warning-glow)";
      roleBadge.style.borderColor = "rgba(245, 158, 11, 0.3)";
    }
  } else {
    // Show all panels for admin
    if (topDropdownLabel) topDropdownLabel.textContent = "Administrator";
    if (settingsBtn) settingsBtn.classList.remove('hidden');
    if (homePurchasesBtn) homePurchasesBtn.classList.remove('hidden');
    if (homeUsagesBtn) homeUsagesBtn.classList.remove('hidden');
    
    if (roleText) roleText.textContent = "Administrator";
    if (roleBadge) {
      roleBadge.className = "mode-badge cloud";
      roleBadge.style.color = "#818cf8";
      roleBadge.style.background = "rgba(99, 102, 241, 0.15)";
      roleBadge.style.borderColor = "rgba(99, 102, 241, 0.3)";
    }
  }
}

// Load App Settings from Local Storage (or fallback to shared DEFAULT_SHEET_URL)
function loadConfiguration() {
  const savedUrl = localStorage.getItem('electrastock_url');
  const effectiveUrl = (savedUrl && savedUrl.trim() !== '') ? savedUrl.trim() : (DEFAULT_SHEET_URL || '').trim();
  
  if (effectiveUrl) {
    state.sheetUrl = effectiveUrl;
    state.appMode = 'cloud';
    updateDbBadge(true);
  } else {
    state.sheetUrl = '';
    state.appMode = 'local';
    updateDbBadge(false);
  }
  
  // Set value in form input
  const inputEl = document.getElementById('settings-sheet-url');
  if (inputEl) inputEl.value = state.sheetUrl;
  
  // Update demo mode warning banner
  updateDemoModeBanner();
}

// Update DB Connection Status Indicators in UI
function updateDbBadge(isCloud) {
  const badge = document.getElementById('db-status-badge');
  const text = document.getElementById('db-status-text');
  
  if (badge && text) {
    if (isCloud) {
      badge.className = 'mode-badge cloud';
      text.textContent = 'Google Sheet Connected';
    } else {
      badge.className = 'mode-badge local';
      text.textContent = 'Demo Mode (Local)';
    }
  }
  updateDemoModeBanner();
}

// Show or hide prominent Demo Mode warning banner on dashboard
function updateDemoModeBanner() {
  let banner = document.getElementById('demo-mode-warning-banner');
  const isCloud = state.appMode === 'cloud' && !!state.sheetUrl;
  
  if (!isCloud) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'demo-mode-warning-banner';
      banner.style.cssText = 'background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(15, 23, 42, 0.9)); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 12px; padding: 14px 18px; margin: 0 0 18px 0; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;';
      banner.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
          <i data-lucide="alert-triangle" style="width: 24px; height: 24px; color: #fbbf24; flex-shrink: 0;"></i>
          <div>
            <strong style="color: #fbbf24; font-size: 0.92rem; display: block;">Demo Mode Active on this PC:</strong>
            <span style="color: #cbd5e1; font-size: 0.82rem;">Uploaded POs and records will only be saved locally on this computer. To save POs to Google Drive so all PCs can view them, configure your Google Sheet Web App URL in Settings.</span>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="btn-banner-go-settings" style="width: auto; padding: 6px 16px; font-size: 0.82rem; background: linear-gradient(135deg, #f59e0b, #d97706); border: none; font-weight: 600;">
          Connect in Settings
        </button>
      `;
      const dashboardTab = document.getElementById('dashboard-tab');
      if (dashboardTab) {
        dashboardTab.insertBefore(banner, dashboardTab.firstChild);
        const goBtn = banner.querySelector('#btn-banner-go-settings');
        if (goBtn) goBtn.onclick = () => switchTab('settings');
        lucide.createIcons();
      }
    } else {
      banner.style.display = 'flex';
    }
  } else {
    if (banner) banner.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────────
// Make Override Persistence Helpers
// Stores Make/Brand edits in a separate localStorage key so they
// survive both syncPrevStocksToGlobalState() rewrites and cloud syncs.
// ─────────────────────────────────────────────────────────────────

/** Generate a stable lookup key for a purchase record */
function makePurchaseKey(p) {
  return [
    (p['Indent No'] || '').toString().trim(),
    (p['Material Name'] || '').toString().trim(),
    (p['Received Date'] || '').toString().trim()
  ].join('||');
}

/** Generate a case-insensitive normalized lookup key */
function makePurchaseKeyLower(p) {
  return [
    (p['Indent No'] || '').toString().trim().toLowerCase(),
    (p['Material Name'] || '').toString().trim().toLowerCase(),
    (p['Received Date'] || '').toString().trim()
  ].join('||');
}

/** Apply any saved Make overrides to state.purchases in-memory */
function applyMakeOverrides() {
  let overrides;
  try {
    overrides = JSON.parse(localStorage.getItem('electrastock_make_overrides') || '{}');
  } catch (e) {
    overrides = {};
  }
  if (!overrides || typeof overrides !== 'object') return;

  // Purge any empty / blank overrides from storage
  let cleaned = false;
  Object.keys(overrides).forEach(k => {
    if (!overrides[k] || !overrides[k].toString().trim()) {
      delete overrides[k];
      cleaned = true;
    }
  });
  if (cleaned) {
    try {
      localStorage.setItem('electrastock_make_overrides', JSON.stringify(overrides));
    } catch (e) {}
  }

  if (!Object.keys(overrides).length) return;

  state.purchases.forEach(p => {
    const key = makePurchaseKey(p);
    const keyLower = makePurchaseKeyLower(p);
    const overrideVal = (overrides[key] || overrides[keyLower] || '').toString().trim();
    if (overrideVal) {
      p['Make'] = overrideVal;
    }
  });
}

/** Sync Make / Brand change to Google Sheets Web App */
function sendMakeUpdateToCloud(materialName, newMake, indentNo) {
  if (state.appMode !== 'cloud' || !state.sheetUrl) {
    return Promise.resolve();
  }

  const query = new URLSearchParams({
    action: 'updateMake',
    materialName: (materialName || '').toString().trim(),
    make: (newMake || '').toString().trim()
  });
  if (indentNo && indentNo !== 'PREV-STOCK') {
    query.set('indentNo', indentNo.toString().trim());
  }

  return fetch(`${state.sheetUrl}?${query.toString()}`, {
    method: 'GET',
    mode: 'cors',
    redirect: 'follow'
  })
  .then(res => res.json())
  .then(data => {
    console.log('Cloud make update response:', data);
    return data;
  })
  .catch(err => {
    console.warn('Cloud make update background sync error:', err);
  });
}

// Global fallback helper so callAppsScript never throws ReferenceError
window.callAppsScript = function(params) {
  if (state.appMode !== 'cloud' || !state.sheetUrl) return Promise.resolve();
  if (params && params.action === 'updateMake') {
    return sendMakeUpdateToCloud(params.materialName, params.make, params.indentNo);
  }
  const query = new URLSearchParams(params || {});
  return fetch(`${state.sheetUrl}?${query.toString()}`, {
    method: 'GET',
    mode: 'cors',
    redirect: 'follow'
  }).then(res => res.json());
};

/**
 * In Cloud mode, cleans up zombie invoice overrides from localStorage/IndexedDB.
 * If a cloud URL no longer exists in Google Sheets, it means it was deleted on another PC/mobile,
 * so this device must discard its local cache and never resurrect it.
 */
function sanitizeCloudOverrides() {
  if (state.appMode !== 'cloud' || !Array.isArray(state.purchases)) return;
  try {
    let raw = localStorage.getItem('electrastock_invoice_overrides');
    if (!raw) return;
    let overrides = JSON.parse(raw);
    let modified = false;

    // Collect all valid PO links currently present in Google Sheets purchases
    const activeCloudLinks = new Set();
    const activeIndentsWithDoc = new Set();
    const allActiveIndents = new Set();
    const itemHasCloudDoc = new Set();

    state.purchases.forEach(p => {
      const link = (p["PO Link"] || p.poLink || p.fileUrl || '').toString().trim();
      const ind = (p["Indent No"] || p.indentNo || '').toString().trim().toLowerCase();
      const pKey = makePurchaseKey(p);
      if (ind) allActiveIndents.add(ind);
      if (link && (link.startsWith('http://') || link.startsWith('https://'))) {
        activeCloudLinks.add(link);
        if (ind) activeIndentsWithDoc.add(ind);
        itemHasCloudDoc.add(pKey);
      }
    });

    Object.keys(overrides).forEach(k => {
      const val = (overrides[k] || '').toString().trim();

      // If override was an external URL (Google Drive / cloud link)
      if (val.startsWith('http://') || val.startsWith('https://')) {
        // If this URL is NOT anywhere in the fresh Google Sheet data, it was deleted in the cloud!
        if (!activeCloudLinks.has(val)) {
          overrides[k] = '__DELETED__';
          modified = true;
        }
      }

      // If it is an indent-level key (e.g. indent_67/elect/esd/2026)
      if (k.startsWith('indent_')) {
        const indName = k.replace('indent_', '').trim().toLowerCase();
        // If this indent exists in purchases but has no document attached in the cloud
        if (allActiveIndents.has(indName) && !activeIndentsWithDoc.has(indName)) {
          if (overrides[k] !== '__DELETED__') {
            overrides[k] = '__DELETED__';
            modified = true;
          }
        }
      } else if (k.includes('||')) {
        // Purchase item key: if this item has no cloud doc, don't keep stale URL
        if (!itemHasCloudDoc.has(k) && (val.startsWith('http://') || val.startsWith('https://'))) {
          overrides[k] = '__DELETED__';
          modified = true;
        }
      }
    });

    if (modified) {
      localStorage.setItem('electrastock_invoice_overrides', JSON.stringify(overrides));
    }
  } catch (e) {
    console.warn('Error in sanitizeCloudOverrides:', e);
  }
}

/** Apply any saved Invoice overrides to state.purchases in-memory (LocalStorage + IndexedDB pointer) */
async function applyInvoiceOverrides() {
  let overrides = {};
  try {
    overrides = JSON.parse(localStorage.getItem('electrastock_invoice_overrides') || '{}');
  } catch (e) {
    overrides = {};
  }

  for (let i = 0; i < state.purchases.length; i++) {
    const p = state.purchases[i];
    const key = makePurchaseKey(p);
    const myMat = (p['Material Name'] || p.name || '').toString().trim().toLowerCase();
    const indentNo = (p['Indent No'] || p.indentNo || '').toString().trim();
    const indentKey = 'indent_' + indentNo;
    const cleanIndentKey = 'indent_' + indentNo.toLowerCase();

    // If marked as __DELETED__, enforce complete blanking across all fields
    if (overrides[key] === '__DELETED__' || overrides[indentKey] === '__DELETED__' || overrides[cleanIndentKey] === '__DELETED__') {
      p['PO Link'] = '';
      p['poLink'] = '';
      p['fileUrl'] = '';
      continue;
    }

    // Check if an override exists specifically for this purchase item
    let overrideVal = overrides[key] || '';
    // Only fall back to indent-level override if it is not marked deleted and not an item key
    if (!overrideVal && indentNo && (overrides[indentKey] || overrides[cleanIndentKey])) {
      const candidateIndentVal = overrides[indentKey] || overrides[cleanIndentKey];
      if (candidateIndentVal !== '__DELETED__' && !candidateIndentVal.includes('||')) {
        overrideVal = candidateIndentVal;
      }
    }

    // In cloud mode: if the cloud returned empty PO Link for this purchase,
    // NEVER resurrect an old http/https Google Drive URL from local overrides!
    if (state.appMode === 'cloud') {
      const cloudLink = (p['PO Link'] || p['poLink'] || p['fileUrl'] || '').toString().trim();
      if (!cloudLink) {
        if (overrideVal && (overrideVal.startsWith('http://') || overrideVal.startsWith('https://'))) {
          overrideVal = '';
          overrides[key] = '__DELETED__';
        }
      }
    }

    if (overrideVal && overrideVal !== '__DELETED__') {
      if (overrideVal.startsWith('data:')) {
        const storeKey = key || indentKey;
        await InvoiceStorage.saveInvoice(storeKey, overrideVal, 'invoice.pdf');
        p['PO Link'] = 'idb:' + storeKey;
        overrides[storeKey] = 'idb:' + storeKey;
      } else {
        // Keep as idb:key or Google Drive URL (never load raw base64 data into memory array)
        p['PO Link'] = overrideVal;
      }
    } else {
      const currentLink = (p['PO Link'] || p['poLink'] || p['fileUrl'] || '').toString().trim();
      if (currentLink.startsWith('data:')) {
        await InvoiceStorage.saveInvoice(key, currentLink, 'invoice.pdf');
        p['PO Link'] = 'idb:' + key;
        overrides[key] = 'idb:' + key;
      } else if (currentLink.startsWith('idb:')) {
        // Verify this idb key actually belongs to this material
        const storeKey = currentLink.replace('idb:', '');
        if (storeKey.includes('||')) {
          const parts = storeKey.split('||');
          const keyMat = (parts[1] || '').trim().toLowerCase();
          if (myMat && keyMat && keyMat !== myMat) {
            p['PO Link'] = '';
          }
        }
      } else if (!currentLink) {
        // Only restore from IndexedDB if in local demo mode, never resurrect in cloud mode
        if (state.appMode !== 'cloud') {
          if (await InvoiceStorage.hasInvoice(key) && overrides[key] !== '__DELETED__') {
            p['PO Link'] = 'idb:' + key;
          } else if (indentNo && overrides[indentKey] && overrides[indentKey] !== '__DELETED__' && !overrides[indentKey].includes('||') && await InvoiceStorage.hasInvoice(indentKey)) {
            p['PO Link'] = 'idb:' + indentKey;
          }
        }
      }
    }
    p['poLink'] = p['PO Link'] || '';
    p['fileUrl'] = p['PO Link'] || '';
  }

  try {
    localStorage.setItem('electrastock_invoice_overrides', JSON.stringify(overrides));
  } catch (e) {
    console.warn('LocalStorage quota warning:', e);
  }
}

// Load from LocalStorage fallback
async function loadLocalData() {
  const localPurchases = localStorage.getItem('electrastock_purchases');
  const localUsages = localStorage.getItem('electrastock_usages');
  const localThresholds = localStorage.getItem('electrastock_thresholds');
  
  if (localPurchases) {
    try {
      state.purchases = JSON.parse(localPurchases);
    } catch (e) {
      state.purchases = [...DEMO_PURCHASES];
    }
  } else {
    state.purchases = [...DEMO_PURCHASES];
    savePurchasesToLocalStorage();
  }
  
  if (localUsages) {
    try {
      state.usages = JSON.parse(localUsages);
    } catch (e) {
      state.usages = [...DEMO_USAGES];
    }
  } else {
    state.usages = [...DEMO_USAGES];
    try {
      localStorage.setItem('electrastock_usages', JSON.stringify(state.usages));
    } catch (e) {}
  }
  
  if (localThresholds) {
    try {
      state.thresholds = JSON.parse(localThresholds);
    } catch (e) {
      state.thresholds = { ...DEMO_THRESHOLDS };
    }
  } else {
    state.thresholds = { ...DEMO_THRESHOLDS };
    try {
      localStorage.setItem('electrastock_thresholds', JSON.stringify(state.thresholds));
    } catch (e) {}
  }

  syncPrevStocksToGlobalState();

  // Re-apply Make & Invoice overrides AFTER syncing prev-stocks (which may regenerate entries)
  applyMakeOverrides();
  await applyInvoiceOverrides();
  updateUI();
}

// Pre-fill Forms with Today's Date
function setDefaultDates() {
  const purchaseDateEl = document.getElementById('purchase-date');
  if (purchaseDateEl) purchaseDateEl.value = ''; // Leave blank so user explicitly selects via calendar

  const usageDateEl = document.getElementById('usage-date');
  if (usageDateEl) usageDateEl.value = ''; // Leave blank — user must explicitly pick a date
}

// Parse date string (DD.MM.YYYY, DD/MM/YYYY, or YYYY-MM-DD) into Date object
function parseDate(dateStr) {
  if (!dateStr) return new Date(0);
  const str = dateStr.toString().trim();
  
  // Format: DD.MM.YYYY or DD/MM/YYYY
  if (str.includes('.') || str.includes('/')) {
    const sep = str.includes('.') ? '.' : '/';
    const parts = str.split(sep);
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1; // 0-indexed month
      const year = parseInt(parts[2], 10);
      return new Date(year, month, day);
    }
  }
  
  // Format: YYYY-MM-DD
  if (str.includes('-')) {
    const parts = str.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      return new Date(year, month, day);
    }
  }
  
  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

// Convert YYYY-MM-DD to DD.MM.YYYY
function formatDateToDDMMYYYY(dateStr) {
  if (!dateStr) return '';
  const str = dateStr.toString().trim();
  if (str.includes('-')) {
    const parts = str.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      return `${parts[2]}.${parts[1]}.${parts[0]}`;
    }
  }
  return str;
}

// Safe HTML Escaping Helper
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Central UI Updater
function updateUI() {
  const inventory = calculateInventory();
  
  updateDashboardKPIs(inventory);
  renderDashboardCharts(inventory);
  renderRecentTransactions();
  renderAlertsBanner(inventory);
  
  // Dashboard Smart Material Search & Indent Master-Detail
  setupDashboardMaterialSearch(inventory);
  setupIndentLookup();
  
  // Setup search filter variables
  filterAndRenderInventory(inventory);
  
  renderPurchasesTab();
  renderUsagesTab(inventory);
  renderCompletedStockTab(inventory);
  updateMakeSuggestionsDatalist();
  
  // Refresh Lucide icons
  lucide.createIcons();
}

// Core Inventory Calculations (Derived State)
function calculateInventory() {
  syncPrevStocksToGlobalState();
  applyMakeOverrides();
  const inventory = {};
  
  // 1. Accumulate Purchases
  state.purchases.forEach(item => {
    const name = item["Material Name"];
    if (!name) return;
    const qty = Number(item["Quantity"]) || 0;
    const amount = Number(item["Amount"]) || 0;
    const unit = item["Unit"] || "Nos";
    
    if (!inventory[name]) {
      inventory[name] = {
        name: name,
        unit: unit,
        totalPurchased: 0,
        totalUsed: 0,
        available: 0,
        totalCost: 0,
        sources: new Set(),
        makes: new Set(),
        indents: new Map(),
        category: getCategoryFromName(name)
      };
    }
    
    inventory[name].totalPurchased += qty;
    inventory[name].totalCost += amount;
    inventory[name].sources.add(item["Source"]);
    if (item["Make"] && item["Make"].toString().trim() !== '') {
      inventory[name].makes.add(item["Make"].toString().trim());
    }
    // Keep most recent unit entered
    inventory[name].unit = unit;

    // Track indent breakdown
    const indentNo = (item["Indent No"] || 'PREV-STOCK').toString().trim() || 'PREV-STOCK';
    if (!inventory[name].indents.has(indentNo)) {
      inventory[name].indents.set(indentNo, {
        indentNo: indentNo,
        qty: 0,
        amount: 0,
        dates: new Set(),
        sources: new Set(),
        makes: new Set(),
        rates: new Set(),
        poLink: item["PO Link"] || item["poLink"] || ''
      });
    }
    const indData = inventory[name].indents.get(indentNo);
    indData.qty += qty;
    indData.amount += amount;
    if (item["Received Date"]) indData.dates.add(item["Received Date"]);
    if (item["Source"]) indData.sources.add(item["Source"]);
    if (item["Make"] && item["Make"].toString().trim()) indData.makes.add(item["Make"].toString().trim());
    if (item["Rate"]) indData.rates.add(Number(item["Rate"]));
    if (getEffectiveItemPoLink(item)) indData.poLink = getEffectiveItemPoLink(item);
  });

  try {
    const matMakes = JSON.parse(localStorage.getItem('electrastock_material_makes') || '{}');
    Object.keys(inventory).forEach(name => {
      const norm = name.trim().toLowerCase();
      for (const [k, v] of Object.entries(matMakes)) {
        if (k.trim().toLowerCase() === norm && v && v.toString().trim()) {
          inventory[name].makes.add(v.toString().trim());
        }
      }
    });
  } catch (e) {}
  
  // 2. Subtract Usages
  state.usages.forEach(item => {
    const name = item["Material Name"];
    const qty = Number(item["Quantity"]) || 0;
    
    if (!inventory[name]) {
      inventory[name] = {
        name: name,
        unit: "Nos",
        totalPurchased: 0,
        totalUsed: 0,
        available: 0,
        totalCost: 0,
        sources: new Set(),
        makes: new Set(),
        indents: new Map(),
        category: getCategoryFromName(name)
      };
    }
    
    inventory[name].totalUsed += qty;
  });
  
  // 3. Finalize Available Quantity and Stock Statuses
  Object.keys(inventory).forEach(name => {
    const item = inventory[name];
    item.available = item.totalPurchased - item.totalUsed;
    
    // Get custom threshold or calculate default threshold (20% of purchases, min 5)
    let threshold = state.thresholds[name];
    if (threshold === undefined) {
      threshold = Math.max(5, Math.ceil(item.totalPurchased * 0.2));
      state.thresholds[name] = threshold; // Save locally
    }
    item.threshold = threshold;
    
    // Determine Stock Status
    if (item.available <= 0) {
      item.status = 'out-of-stock';
    } else if (item.available <= item.threshold) {
      item.status = 'low-stock';
    } else {
      item.status = 'in-stock';
    }
  });
  
  return inventory;
}

// Simple Classifier for Material Categories
function getCategoryFromName(name) {
  const n = name.toLowerCase();
  if (n.includes('wire') || n.includes('cable')) return 'wires';
  if (n.includes('mcb') || n.includes('db') || n.includes('distribution') || n.includes('breaker')) return 'mcbs';
  if (n.includes('switch') || n.includes('socket') || n.includes('board') || n.includes('modular')) return 'switches';
  return 'others';
}

// Update Dashboard Statistics Cards
function updateDashboardKPIs(inventory) {
  let activeItems = 0;
  let lowStockCount = 0;
  
  Object.values(inventory).forEach(item => {
    if (item.available > 0) activeItems++; // Count only items with stock
    else activeItems++; // Count all tracked items
    if (item.status === 'low-stock' || item.status === 'out-of-stock') {
      lowStockCount++;
    }
  });
  
  const activeItemsEl = document.getElementById('kpi-active-items');
  const lowStockEl = document.getElementById('kpi-low-stock');
  if (activeItemsEl) activeItemsEl.textContent = activeItems;
  if (lowStockEl) lowStockEl.textContent = lowStockCount;
}

// Populate Stock Alerts Box on Dashboard
function renderAlertsBanner(inventory) {
  const alertsContainer = document.getElementById('alerts-container');
  const banner = document.getElementById('alerts-banner');
  if (!alertsContainer || !banner) return;
  alertsContainer.innerHTML = '';
  
  const alertItems = Object.values(inventory).filter(item => item.status !== 'in-stock');
  
  if (alertItems.length === 0) {
    banner.classList.remove('active');
    return;
  }
  
  banner.classList.add('active');
  
  alertItems.forEach(item => {
    const pill = document.createElement('span');
    if (item.status === 'out-of-stock') {
      pill.className = 'alert-item-pill out-of-stock';
      pill.innerHTML = `<i data-lucide="x-circle" style="width: 14px; height: 14px;"></i> ${item.name}: OUT OF STOCK (${item.available} ${item.unit})`;
    } else {
      pill.className = 'alert-item-pill';
      pill.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px; height: 14px;"></i> ${item.name}: LOW STOCK (${item.available} / Threshold: ${item.threshold} ${item.unit})`;
    }
    alertsContainer.appendChild(pill);
  });
  
  lucide.createIcons();
}

// Renders the Dashboard visual analytics charts
function renderDashboardCharts(inventory) {
  const stockCanvas = document.getElementById('stockChart');
  const sourceCanvas = document.getElementById('sourceChart');
  if (!stockCanvas || !sourceCanvas) return;

  const items = Object.values(inventory);
  
  // Chart 1: Stock Levels
  const stockCtx = stockCanvas.getContext('2d');
  if (stockChart) stockChart.destroy();
  
  // Sort items by lowest percent available relative to threshold
  const sortedItems = [...items].sort((a, b) => (a.available / (a.threshold || 1)) - (b.available / (b.threshold || 1))).slice(0, 8);
  
  const labels = sortedItems.map(i => i.name.length > 25 ? i.name.substring(0, 22) + '...' : i.name);
  const availableData = sortedItems.map(i => i.available);
  const thresholdData = sortedItems.map(i => i.threshold);
  
  stockChart = new Chart(stockCtx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Available Stock',
          data: availableData,
          backgroundColor: sortedItems.map(i =>
            i.status === 'out-of-stock' ? 'rgba(239,68,68,0.7)'
            : i.status === 'low-stock'  ? 'rgba(245,158,11,0.7)'
            : 'rgba(20,184,166,0.7)'),
          borderColor: sortedItems.map(i =>
            i.status === 'out-of-stock' ? '#ef4444'
            : i.status === 'low-stock'  ? '#f59e0b'
            : '#14b8a6'),
          borderWidth: 0,
          borderRadius: 8,
          borderSkipped: false,
        },
        {
          label: 'Low Stock Limit',
          data: thresholdData,
          type: 'line',
          borderColor: 'rgba(239,68,68,0.6)',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 4,
          pointBackgroundColor: '#ef4444',
          pointBorderColor: '#fff',
          pointBorderWidth: 1.5,
          fill: false,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: { color: '#64748b', font: { family: 'Outfit', size: 11 } }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: { color: '#64748b', font: { family: 'Outfit', size: 11 } },
          beginAtZero: true
        }
      },
      plugins: {
        legend: {
          labels: { color: '#94a3b8', font: { family: 'Outfit', size: 12 }, boxWidth: 12, padding: 16 }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleFont: { family: 'Outfit', weight: '600' },
          bodyFont: { family: 'Outfit' },
          padding: 12,
          cornerRadius: 10
        }
      }
    }
  });

  // Chart 2: Uploaded Previous Stock Summary
  const sourceCtx = sourceCanvas.getContext('2d');
  if (sourceChart) sourceChart.destroy();
  
  const prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
  
  if (prevStocks.length === 0) {
    sourceChart = new Chart(sourceCtx, {
      type: 'doughnut',
      data: {
        labels: ['No Previous Stock Records Uploaded'],
        datasets: [{
          data: [1],
          backgroundColor: ['rgba(100, 116, 139, 0.2)'],
          borderColor: ['rgba(100, 116, 139, 0.4)'],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#94a3b8', font: { family: 'Outfit', size: 12 } } },
          tooltip: { enabled: false }
        },
        cutout: '68%'
      }
    });
  } else {
    // Show top 6 uploaded previous stock items in a grouped bar chart
    const topPrev = prevStocks.slice(0, 6);
    const labels = topPrev.map(r => r.name.length > 20 ? r.name.substring(0, 18) + '…' : r.name);
    const leftData = topPrev.map(r => Number(r.leftQty) || 0);
    const usedData = topPrev.map(r => Number(r.usedQty) || 0);

    sourceChart = new Chart(sourceCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Current Available Stock',
            data: leftData,
            backgroundColor: 'rgba(16, 185, 129, 0.75)',
            borderColor: '#10b981',
            borderRadius: 6
          },
          {
            label: 'Used Qty (calc.)',
            data: usedData,
            backgroundColor: 'rgba(239, 68, 68, 0.75)',
            borderColor: '#ef4444',
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#64748b', font: { family: 'Outfit', size: 10 } }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#64748b', font: { family: 'Outfit', size: 10 } },
            beginAtZero: true
          }
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#94a3b8', font: { family: 'Outfit', size: 11 }, boxWidth: 10, padding: 12 }
          },
          tooltip: {
            backgroundColor: 'rgba(15,23,42,0.95)',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
            titleFont: { family: 'Outfit', weight: '600' },
            bodyFont: { family: 'Outfit' },
            padding: 10,
            cornerRadius: 8
          }
        }
      }
    });
  }
}

// Render Recent Transactions Table on Dashboard (Merge both logs)
function renderRecentTransactions() {
  const tbody = document.getElementById('recent-transactions-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  // Construct recent transactions
  const transactions = [];
  
  state.purchases.forEach(p => {
    transactions.push({
      type: 'purchase',
      date: p["Received Date"],
      material: p["Material Name"],
      qty: p["Quantity"],
      unit: p["Unit"] || '',
      detail: `Indent: ${p["Indent No"]} · ${p["Source"]}`,
      amount: Number(p["Amount"]) || 0,
      timestamp: parseDate(p["Received Date"]).getTime()
    });
  });
  
  state.usages.forEach(u => {
    transactions.push({
      type: 'usage',
      date: u["Date"],
      material: u["Material Name"],
      qty: u["Quantity"],
      unit: '',
      detail: `Used at: ${u["Where Used"]}`,
      amount: null,
      timestamp: parseDate(u["Date"]).getTime()
    });
  });
  
  // Sort descending by date
  transactions.sort((a, b) => b.timestamp - a.timestamp);
  
  // Take top 8 for a richer display
  const topRecent = transactions.slice(0, 8);
  
  if (topRecent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No transactions recorded yet.</td></tr>';
    return;
  }
  
  topRecent.forEach(tx => {
    const tr = document.createElement('tr');
    const isPurchase = tx.type === 'purchase';
    tr.className = isPurchase ? 'tx-row-purchase' : 'tx-row-usage';
    
    const typeLabel = isPurchase 
      ? `<span class="status-badge in-stock" style="gap:5px; font-size:0.72rem;"><i data-lucide="arrow-down-circle" style="width:12px;height:12px;"></i> Purchase</span>`
      : `<span class="status-badge out-of-stock" style="gap:5px; font-size:0.72rem;"><i data-lucide="arrow-up-circle" style="width:12px;height:12px;"></i> Usage</span>`;
    
    const qtyDisplay = isPurchase
      ? `<span style="font-weight:700; color:#34d399;">+${tx.qty} <span style="font-size:0.75rem;font-weight:400;color:var(--text-muted);">${tx.unit}</span></span>`
      : `<span style="font-weight:700; color:#f43f5e;">−${tx.qty}</span>`;
    
    const shortMaterial = tx.material.length > 32 ? tx.material.substring(0, 30) + '…' : tx.material;
    
    tr.innerHTML = `
      <td>${typeLabel}</td>
      <td style="color:var(--text-secondary); font-size:0.82rem;">${tx.date}</td>
      <td style="font-weight:600; max-width:220px;" title="${tx.material}">${shortMaterial}</td>
      <td>${qtyDisplay}</td>
      <td class="kpi-subtext" style="max-width:200px; overflow:hidden; text-overflow:ellipsis;" title="${tx.detail}">${tx.detail}</td>
    `;
    
    tbody.appendChild(tr);
  });
  
  lucide.createIcons();
}

// AI Smart Search & Filters Parser for Inventory
function filterAndRenderInventory(inventory) {
  const searchInput = document.getElementById('inventory-search').value.toLowerCase().trim();
  const statusFilter = document.getElementById('inventory-status-filter').value;
  const categoryFilter = document.getElementById('inventory-category-filter').value;
  
  let items = Object.values(inventory);
  
  // 1. Status Filter
  if (statusFilter !== 'all') {
    items = items.filter(item => item.status === statusFilter);
  }
  
  // 2. Category Filter
  if (categoryFilter !== 'all') {
    items = items.filter(item => item.category === categoryFilter);
  }
  
  // 3. AI / Smart Search Parser
  if (searchInput !== '') {
    items = items.filter(item => {
      // Direct text matching
      const nameMatch = item.name.toLowerCase().includes(searchInput);
      const unitMatch = item.unit.toLowerCase().includes(searchInput);
      
      // Smart: low stock check
      if (searchInput === 'low stock' || searchInput === 'low' || searchInput === 'alert') {
        return item.status === 'low-stock';
      }
      
      // Smart: out of stock check
      if (searchInput === 'out of stock' || searchInput === 'out' || searchInput === 'empty') {
        return item.status === 'out-of-stock';
      }
      
      // Smart: healthy check
      if (searchInput === 'in stock' || searchInput === 'healthy' || searchInput === 'in-stock') {
        return item.status === 'in-stock';
      }
      
      // Smart: Source check (e.g. GEM, Local Market, or Tender Work)
      if (searchInput === 'gem' || searchInput === 'local' || searchInput === 'local market' || searchInput === 'tender' || searchInput === 'tender work') {
        let sourceQuery = 'GEM';
        if (searchInput === 'local' || searchInput === 'local market') sourceQuery = 'Local Market';
        if (searchInput === 'tender' || searchInput === 'tender work') sourceQuery = 'Tender Work';
        return item.sources.has(sourceQuery);
      }
      
      // Smart: category matches
      if (searchInput === 'wires' || searchInput === 'wire' || searchInput === 'cables' || searchInput === 'cable') {
        return item.category === 'wires';
      }
      if (searchInput === 'mcbs' || searchInput === 'mcb' || searchInput === 'db' || searchInput === 'dbs') {
        return item.category === 'mcbs';
      }
      if (searchInput === 'switches' || searchInput === 'switch' || searchInput === 'sockets' || searchInput === 'socket') {
        return item.category === 'switches';
      }
      
      // Smart: Numeric Comparisons (e.g., "qty < 10", "stock > 50")
      const comparisonMath = parseMathQuery(searchInput);
      if (comparisonMath) {
        const { operator, value } = comparisonMath;
        if (operator === '<') return item.available < value;
        if (operator === '<=') return item.available <= value;
        if (operator === '>') return item.available > value;
        if (operator === '>=') return item.available >= value;
        if (operator === '=') return item.available === value;
      }
      
      return nameMatch || unitMatch;
    });
  }
  
  inventoryPagination.filteredItems = items;
  inventoryPagination.currentPage = 1;
  renderInventoryTable();
}

// Parses queries like "qty < 20", "stock > 50", "< 10"
function parseMathQuery(str) {
  // Regex to match operators and numbers
  const regex = /(?:qty|stock|quantity|available)?\s*(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)/i;
  const match = str.match(regex);
  if (match) {
    return {
      operator: match[1],
      value: parseFloat(match[2])
    };
  }
  
  // Alternative fallback if they only type `< 20` or `> 100`
  const shortRegex = /^\s*(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)$/;
  const shortMatch = str.match(shortRegex);
  if (shortMatch) {
    return {
      operator: shortMatch[1],
      value: parseFloat(shortMatch[2])
    };
  }
  
  return null;
}

// Render paginated Stock Table
function renderInventoryTable() {
  const tbody = document.getElementById('inventory-table-body');
  tbody.innerHTML = '';
  
  const items = inventoryPagination.filteredItems;
  const totalItems = items.length;
  
  // Update Pagination Controls
  const totalPages = Math.ceil(totalItems / inventoryPagination.pageSize) || 1;
  const startIdx = (inventoryPagination.currentPage - 1) * inventoryPagination.pageSize;
  const endIdx = Math.min(startIdx + inventoryPagination.pageSize, totalItems);
  
  document.getElementById('inventory-pagination-info').textContent = 
    totalItems > 0 ? `Showing ${startIdx + 1}-${endIdx} of ${totalItems} items` : `Showing 0-0 of 0 items`;
    
  document.getElementById('inventory-prev-btn').disabled = inventoryPagination.currentPage === 1;
  document.getElementById('inventory-next-btn').disabled = inventoryPagination.currentPage === totalPages;
  
  // Hide action header for read-only staff users
  const isAdmin = state.currentUser === 'admin';
  const actionTh = document.querySelector('#inventory-table th:last-child');
  if (actionTh) {
    actionTh.style.display = isAdmin ? 'table-cell' : 'none';
  }
  
  if (totalItems === 0) {
    const colSpan = isAdmin ? 8 : 7;
    tbody.innerHTML = `
      <tr>
        <td colspan="${colSpan}">
          <div class="empty-state">
            <i data-lucide="search"></i>
            <div class="empty-state-title">No Materials Found</div>
            <p class="kpi-subtext">Try refining your search text or removing the filters.</p>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }
  
  const pageItems = items.slice(startIdx, endIdx);
  
  pageItems.forEach(item => {
    const tr = document.createElement('tr');
    
    // Format Makes with interactive provision to give or edit make name (Admin only)
    const makesArray = Array.from(item.makes || []);
    const makesDisplay = makesArray.length > 0
      ? (isAdmin
          ? makesArray.map(m => `<button type="button" class="make-badge clickable btn-stock-edit-make" data-material="${item.name}" title="Click to edit Make / Brand for ${item.name}" style="border:none; cursor:pointer;">${m} <i data-lucide="edit-2" style="width:10px;height:10px;margin-left:3px;opacity:0.75;"></i></button>`).join(' ')
          : makesArray.map(m => `<span class="make-badge" style="border:none;">${m}</span>`).join(' '))
      : (isAdmin
          ? `<button type="button" class="btn btn-secondary btn-stock-edit-make" data-material="${item.name}" title="Give Make / Brand for ${item.name}" style="padding: 2px 8px; font-size: 0.73rem; border: 1px dashed rgba(99,102,241,0.35); color: #a5b4fc; background: rgba(99,102,241,0.08); border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;"><i data-lucide="tag" style="width: 11px; height: 11px;"></i> + Set Make</button>`
          : `<span style="font-size: 0.78rem; color: var(--text-muted);">—</span>`);
    
    // Status Badge
    let statusClass = 'in-stock';
    let statusText = 'In Stock';
    if (item.status === 'out-of-stock') {
      statusClass = 'out-of-stock';
      statusText = 'Out of Stock';
    } else if (item.status === 'low-stock') {
      statusClass = 'low-stock';
      statusText = 'Low Stock';
    }
    
    // Stock ratio progress bar percentage
    const maxReference = Math.max(item.totalPurchased, 1);
    const progressPercent = Math.min(100, Math.max(0, (item.available / maxReference) * 100));
    
    let progressClass = 'success';
    if (item.status === 'out-of-stock') progressClass = 'danger';
    else if (item.status === 'low-stock') progressClass = 'warning';
    
    const actionCell = isAdmin
      ? `<td style="text-align: center; width: 85px;">
          <div style="display: flex; gap: 4px; justify-content: center; align-items: center;">
            <button class="btn btn-secondary btn-stock-edit-make" data-material="${item.name}" title="Give / Edit Make for ${item.name}" style="padding: 5px 8px; font-size: 0.78rem; display: inline-flex; width: auto; min-width: unset; border-radius: 6px; color: #a5b4fc;">
              <i data-lucide="tag" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-secondary btn-edit-threshold" data-material="${item.name}" data-threshold="${item.threshold}" data-unit="${item.unit}" title="Set Low Stock Threshold for ${item.name}" style="padding: 5px 8px; font-size: 0.78rem; display: inline-flex; width: auto; min-width: unset; border-radius: 6px;">
              <i data-lucide="sliders-horizontal" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>`
      : ``;
      
    tr.innerHTML = `
      <td style="font-weight: 600;">
        <button type="button" class="mat-trace-btn" data-material="${item.name}" title="Click to view purchase, availability &amp; usage location breakdown" style="background: none; border: none; padding: 0; color: var(--text-primary); font-family: inherit; font-size: inherit; font-weight: 600; cursor: pointer; text-align: left; display: inline-flex; align-items: center; gap: 6px;">
          ${item.name}
          <i data-lucide="info" style="width: 14px; height: 14px; color: var(--primary); opacity: 0.8;"></i>
        </button>
      </td>
      <td>${makesDisplay}</td>
      <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      <td>
        <strong>${item.totalPurchased}</strong>
        ${(() => {
          const splits = getMaterialIndentSplits(item.name);
          return splits.length > 1
            ? `<div style="font-size: 0.7rem; color: #818cf8; margin-top: 2px; font-weight: 600; display: flex; align-items: center; gap: 3px;" title="Split across ${splits.length} Indents: ${splits.map(s => s.qty + ' in ' + s.indentNo).join(', ')}">
                <i data-lucide="split" style="width: 10px; height: 10px;"></i> ${splits.length} Indents
              </div>`
            : '';
        })()}
      </td>
      <td>${item.totalUsed}</td>
      <td>
        <div class="stock-bar-container">
          <div class="stock-bar-outer">
            <div class="stock-bar-inner ${progressClass}" style="width: ${progressPercent}%;"></div>
          </div>
          <span class="stock-bar-value" style="font-weight: 800; color: #ffffff; font-size: 0.88rem;">${Math.round(item.available * 100) / 100}</span>
        </div>
      </td>
      <td class="kpi-subtext">${item.unit}</td>
      ${actionCell}
    `;
    
    tbody.appendChild(tr);
  });
  
  // Wire material name traceability clicks
  tbody.querySelectorAll('.mat-trace-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const name = btn.getAttribute('data-material');
      openMaterialDetailModal(name);
    });
  });

  // Wire Stock Make button clicks (clickable make badges and + Set Make buttons)
  tbody.querySelectorAll('.btn-stock-edit-make').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mat = btn.getAttribute('data-material');
      if (mat) openEditMakeForMaterial(mat);
    });
  });
  
  // Wire threshold button clicks if admin
  if (isAdmin) {
    document.querySelectorAll('.btn-edit-threshold').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const name = btn.getAttribute('data-material');
        const threshold = btn.getAttribute('data-threshold');
        const unit = btn.getAttribute('data-unit');
        openThresholdModal(name, threshold, unit);
      });
    });
  }
  
  lucide.createIcons();
}

// Render Purchase Entry View (populates datalist and purchase list)
function renderPurchasesTab() {
  const datalist = document.getElementById('material-suggestions');
  datalist.innerHTML = '';
  
  // Collect unique material names from history
  const uniqueNames = new Set();
  state.purchases.forEach(p => uniqueNames.add(p["Material Name"]));
  
  uniqueNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    datalist.appendChild(opt);
  });
  
  // Populate purchases list (newest first)
  const tbody = document.getElementById('purchases-table-body');
  tbody.innerHTML = '';
  
  const sortedPurchases = [...state.purchases].sort((a,b) => parseDate(b["Received Date"]) - parseDate(a["Received Date"]));
  const displayPurchases = sortedPurchases;
  
  if (displayPurchases.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No purchases logged.</td></tr>';
    return;
  }
  
  const isAdmin = state.currentUser !== 'staff';

  displayPurchases.forEach(p => {
    const realIndex = state.purchases.indexOf(p);
    const makeVal = p["Make"] ? p["Make"].toString().trim() : '';
    const makeDisplay = makeVal
      ? (isAdmin
          ? `<button type="button" class="make-badge clickable btn-edit-make" data-type="purchase" data-index="${realIndex}" title="Edit Make for ${p["Material Name"]}" style="border:none; cursor:pointer;">${makeVal} <i data-lucide="edit-2" style="width:10px;height:10px;margin-left:3px;opacity:0.75;"></i></button>`
          : `<span class="make-badge" style="border:none;">${makeVal}</span>`)
      : (isAdmin
          ? `<button type="button" class="btn btn-secondary btn-edit-make" data-type="purchase" data-index="${realIndex}" title="Give Make for ${p["Material Name"]}" style="padding: 2px 7px; font-size: 0.72rem; border: 1px dashed rgba(99,102,241,0.35); color: #a5b4fc; background: rgba(99,102,241,0.08); border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; width: auto;"><i data-lucide="tag" style="width: 10px; height: 10px;"></i> + Set Make</button>`
          : `<span class="kpi-subtext">—</span>`);

    const effectiveLink = getEffectiveItemPoLink(p);

    let invoiceCell = '';
    if (effectiveLink) {
      invoiceCell = `<div style="display: flex; gap: 4px; align-items: center;">
          <button class="btn btn-secondary btn-view-invoice" data-index="${realIndex}" title="View PO / Invoice Document & Item Details" style="padding: 4px 8px; font-size: 0.75rem; display: inline-flex; width: auto; min-width: unset; border-radius: 6px; color: #818cf8; background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.3); font-weight: 600;">
            <i data-lucide="file-text" style="width: 12px; height: 12px; margin-right: 3px;"></i> View
          </button>
          ${isAdmin ? `
            <button class="btn btn-secondary btn-reupload-invoice-table" data-index="${realIndex}" title="Edit / Reupload PO or Invoice Document" style="padding: 4px 6px; font-size: 0.75rem; display: inline-flex; width: auto; min-width: unset; border-radius: 6px; color: #a5b4fc; background: rgba(99, 102, 241, 0.08); border-color: rgba(99, 102, 241, 0.25);">
              <i data-lucide="upload-cloud" style="width: 12px; height: 12px;"></i>
            </button>
            <button class="btn btn-secondary btn-delete-invoice-table" data-index="${realIndex}" title="Delete / Remove PO or Invoice" style="padding: 4px 6px; font-size: 0.75rem; display: inline-flex; width: auto; min-width: unset; border-radius: 6px; color: var(--danger); background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.25);">
              <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
            </button>
          ` : ''}
         </div>`;
    } else {
      invoiceCell = isAdmin
        ? `<button class="btn btn-secondary btn-reupload-invoice-table" data-index="${realIndex}" title="Attach or Upload PO / Invoice Document" style="padding: 3px 8px; font-size: 0.75rem; display: inline-flex; width: auto; min-width: unset; border-radius: 6px; color: var(--success); background: rgba(16, 185, 129, 0.1); border-color: rgba(16, 185, 129, 0.3);">
            <i data-lucide="paperclip" style="width: 12px; height: 12px; margin-right: 3px;"></i> + Attach
           </button>`
        : `<span class="kpi-subtext">—</span>`;
    }

    const actionCell = isAdmin
      ? `<td style="text-align: center;">
          <div style="display: flex; gap: 4px; justify-content: center; align-items: center;">
            <button class="btn btn-secondary btn-edit-make" data-type="purchase" data-index="${realIndex}" title="Edit Make for ${p["Material Name"]}" style="padding: 4px 8px; font-size: 0.78rem; display: inline-flex; width: auto; min-width: unset; border-radius: 6px;">
              <i data-lucide="edit-2" style="width: 12px; height: 12px; margin-right: 3px;"></i> Make
            </button>
            <button class="btn btn-secondary btn-delete-purchase-row" data-index="${realIndex}" title="Delete Purchase Entry for ${p["Material Name"]}" style="padding: 4px 6px; font-size: 0.78rem; display: inline-flex; width: auto; min-width: unset; border-radius: 6px; color: var(--danger); background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.25);">
              <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
            </button>
          </div>
        </td>`
      : `<td style="text-align: center;"><span class="kpi-subtext">—</span></td>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="kpi-subtext" style="font-family: monospace;">${p["Indent No"]}</td>
      <td>${p["Received Date"]}</td>
      <td style="font-weight: 500; cursor: pointer; color: var(--text-primary);" class="clickable-mat-name" data-material="${p["Material Name"]}" title="Click to inspect complete item details & invoice">${p["Material Name"]}</td>
      <td>${makeDisplay}</td>
      <td>${p["Quantity"]} ${p["Unit"]}</td>
      <td style="font-weight: 600;">₹${Number(p["Amount"]).toLocaleString('en-IN')}</td>
      <td><span class="status-badge ${getSourceBadgeClass(p["Source"])}">${p["Source"]}</span></td>
      <td>${invoiceCell}</td>
      ${actionCell}
    `;
    tbody.appendChild(tr);
  });

  // Wire View Invoice click handlers
  tbody.querySelectorAll('.btn-view-invoice').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      if (state.purchases[idx]) openInvoiceViewerModal(state.purchases[idx]);
    });
  });

  // Wire Reupload/Change Invoice click handlers
  tbody.querySelectorAll('.btn-reupload-invoice-table').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      if (state.purchases[idx]) openReuploadInvoiceModal(state.purchases[idx], 'purchase');
    });
  });

  // Wire Delete Invoice click handlers
  tbody.querySelectorAll('.btn-delete-invoice-table').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      if (state.purchases[idx]) deleteItemInvoice(state.purchases[idx]);
    });
  });

  // Wire Clickable Material Name to open Material 360 Traceability
  tbody.querySelectorAll('.clickable-mat-name').forEach(cell => {
    cell.addEventListener('click', () => {
      const mat = cell.getAttribute('data-material');
      if (mat) openMaterialDetailModal(mat);
    });
  });

  // Wire Edit Make and Delete Purchase Row button click handlers
  if (isAdmin) {
    tbody.querySelectorAll('.btn-edit-make').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = btn.getAttribute('data-type');
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        openEditMakeModal(type, idx);
      });
    });

    tbody.querySelectorAll('.btn-delete-purchase-row').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        if (state.purchases[idx]) {
          deletePurchaseRecord(idx);
        }
      });
    });
  }

  lucide.createIcons();
}

// Render Usage Entry View (populates materials dropdown selector)
function renderUsagesTab(inventory) {
  const select = document.getElementById('usage-material');
  const selectedVal = select.value;
  select.innerHTML = '<option value="" disabled selected>Select a material in stock...</option>';
  
  Object.values(inventory).forEach(item => {
    // Only show items that have active stock
    if (item.available > 0) {
      const opt = document.createElement('option');
      opt.value = item.name;
      opt.textContent = `${item.name} (In Stock: ${Math.round(item.available * 100) / 100} ${item.unit})`;
      select.appendChild(opt);
    }
  });
  
  // Restore previous selected value if valid
  if (selectedVal && select.querySelector(`option[value="${selectedVal}"]`)) {
    select.value = selectedVal;
  }
  
  // Render purchase breakdown card for current selected material
  renderUsagePurchasesBreakdown(select.value);

  // Populate usages list (newest first)
  const tbody = document.getElementById('usages-table-body');
  tbody.innerHTML = '';
  
  const sortedUsages = [...state.usages].sort((a,b) => parseDate(b["Date"]) - parseDate(a["Date"]));
  const displayUsages = sortedUsages;
  
  if (displayUsages.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No usage recorded.</td></tr>';
    return;
  }
  
  displayUsages.forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${u["Date"]}</td>
      <td style="font-weight: 500;">${u["Material Name"]}</td>
      <td style="color: var(--danger); font-weight: 600;">-${u["Quantity"]}</td>
      <td>${u["Where Used"]}</td>
      <td class="kpi-subtext">${u["Remarks"] || '-'}</td>
    `;
    tbody.appendChild(tr);
  });

  lucide.createIcons();
}

/** Delete Maintenance Usage Entry */
function deleteUsageRecord(index) {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can delete records.', 'error');
    return;
  }
  const u = state.usages[index];
  if (!u) return;

  if (confirm(`Are you sure you want to delete the usage entry for "${u["Material Name"]}" (${u["Quantity"]} used at ${u["Where Used"]})?`)) {
    state.usages.splice(index, 1);
    localStorage.setItem('electrastock_usages', JSON.stringify(state.usages));
    updateUI();

    if (state.appMode === 'cloud' && state.sheetUrl) {
      setSyncingAnimation(true);
      const query = new URLSearchParams({
        action: 'deleteUsage',
        date: u["Date"] || '',
        materialName: u["Material Name"] || '',
        quantity: u["Quantity"] || '',
        whereUsed: u["Where Used"] || '',
        remarks: u["Remarks"] || ''
      });
      fetch(`${state.sheetUrl}?${query.toString()}`, { method: 'GET', mode: 'cors', redirect: 'follow' })
        .then(res => res.json())
        .then(data => {
          if (data && data.status === 'success') {
            showToast(`Deleted usage entry for "${u["Material Name"]}".`, 'info');
          } else {
            showToast(`Usage deleted locally.`, 'info');
          }
          return syncWithCloud();
        })
        .catch(err => {
          console.error(err);
          showToast(`Usage deleted locally. Cloud sync warning: ${err.message || 'Network error'}`, 'warning');
          setSyncingAnimation(false);
        });
    } else {
      showToast(`Deleted usage entry for "${u["Material Name"]}".`, 'info');
    }
  }
}

/**
 * Renders previous purchases history & stock breakdown inside the Record Material Usage form
 * when a user selects a material.
 * @param {string} materialName
 */
function renderUsagePurchasesBreakdown(materialName) {
  const container = document.getElementById('usage-purchases-breakdown');
  if (!container) return;

  if (!materialName) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  const inventory = calculateInventory();
  const item = inventory[materialName];
  if (!item) {
    container.style.display = 'none';
    return;
  }

  // Find all purchase records matching this material
  const matchingPurchases = state.purchases.filter(p => p["Material Name"] === materialName);

  // Sort descending by date
  matchingPurchases.sort((a, b) => parseDate(b["Received Date"]) - parseDate(a["Received Date"]));

  const makesArray = Array.from(item.makes || []);
  const makesDisplay = makesArray.length > 0
    ? makesArray.map(m => `<span class="make-badge">${m}</span>`).join(' ')
    : `<span class="kpi-subtext">None specified</span>`;

  let purchasesRowsHtml = '';
  if (matchingPurchases.length === 0) {
    purchasesRowsHtml = `<tr><td colspan="7" class="empty-state" style="padding: 12px; font-size: 0.8rem;">No purchase history logged for this material.</td></tr>`;
  } else {
    matchingPurchases.forEach((p, idx) => {
      const makeVal = p["Make"] ? p["Make"].toString().trim() : '';
      const makeTag = makeVal ? `<span class="make-badge">${makeVal}</span>` : `<span class="kpi-subtext">—</span>`;
      const rawLink = p["PO Link"] || p["poLink"] || p["fileUrl"] || '';
      const invBtn = rawLink
        ? `<button type="button" class="btn btn-secondary btn-usage-view-inv" data-idx="${idx}" style="padding: 2px 7px; font-size: 0.72rem; color: #818cf8; background: rgba(99,102,241,0.12); border-color: rgba(99,102,241,0.3);"><i data-lucide="file-text" style="width: 11px; height: 11px; margin-right: 2px;"></i> Invoice</button>`
        : `<span class="kpi-subtext">—</span>`;

      purchasesRowsHtml += `
        <tr>
          <td style="font-family: monospace; font-size: 0.78rem; font-weight: 600;">${p["Indent No"] || 'N/A'}</td>
          <td style="font-size: 0.8rem; color: var(--text-secondary);">${p["Received Date"] || '—'}</td>
          <td>${makeTag}</td>
          <td style="font-weight: 600; color: #34d399;">+${p["Quantity"]} <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 400;">${p["Unit"] || ''}</span></td>
          <td style="font-size: 0.8rem; font-weight: 500;">₹${Number(p["Rate"] || 0).toLocaleString('en-IN')}</td>
          <td><span class="status-badge ${getSourceBadgeClass(p["Source"])}" style="font-size: 0.7rem; padding: 2px 8px;">${p["Source"] || 'GEM'}</span></td>
          <td>${invBtn}</td>
        </tr>
      `;
    });
  }

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px;">
      <span style="font-weight: 700; font-size: 0.88rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
        <i data-lucide="history" style="width: 15px; height: 15px; color: var(--primary);"></i>
        Previous Purchased Items History
      </span>
      <span class="status-badge in-stock" style="font-size: 0.75rem; font-weight: 700;">Available Stock: ${Math.round(item.available * 100) / 100} ${item.unit}</span>
    </div>

    <!-- Summary Stats Bar -->
    <div style="display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; font-size: 0.82rem; background: rgba(255, 255, 255, 0.02); padding: 8px 12px; border-radius: 8px;">
      <div><span class="kpi-subtext">Total Purchased:</span> <strong style="color:var(--text-primary);">${item.totalPurchased} ${item.unit}</strong></div>
      <div><span class="kpi-subtext">Total Used:</span> <strong style="color:var(--danger);">${item.totalUsed} ${item.unit}</strong></div>
      <div><span class="kpi-subtext">Makes/Brands:</span> ${makesDisplay}</div>
    </div>

    <!-- Purchase Receipts Table -->
    <div style="max-height: 160px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 8px;">
      <table class="data-table" style="font-size: 0.8rem; width: 100%;">
        <thead>
          <tr>
            <th style="padding: 6px 10px;">Indent No</th>
            <th style="padding: 6px 10px;">Date</th>
            <th style="padding: 6px 10px;">Make</th>
            <th style="padding: 6px 10px;">Purchased</th>
            <th style="padding: 6px 10px;">Rate</th>
            <th style="padding: 6px 10px;">Source</th>
            <th style="padding: 6px 10px;">Invoice</th>
          </tr>
        </thead>
        <tbody>
          ${purchasesRowsHtml}
        </tbody>
      </table>
    </div>
  `;

  container.querySelectorAll('.btn-usage-view-inv').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (matchingPurchases[idx]) openInvoiceViewerModal(matchingPurchases[idx]);
    };
  });

  container.style.display = 'block';
  lucide.createIcons();
}

// ─────────────────────────────────────────────────────────────────
// Completed Stock Folder Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Renders the Completed Stock Folder table and KPI metrics.
 * Displays all materials with available stock <= 0, their originating Indent No(s)
 * with quantity split, and the complete location breakdown of where items were used.
 * @param {Object} inventory
 */
function renderCompletedStockTab(inventory) {
  const tbody = document.getElementById('completed-stock-table-body');
  const kpiContainer = document.getElementById('completed-stock-kpis');
  const badge = document.getElementById('completed-stock-badge');
  if (!tbody) return;

  const allCompleted = Object.values(inventory).filter(item => item.totalPurchased > 0 && item.available <= 0);

  // Update badge in navigation
  if (badge) {
    if (allCompleted.length > 0) {
      badge.textContent = allCompleted.length;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  // Update KPIs
  if (kpiContainer) {
    const totalUnitsConsumed = allCompleted.reduce((sum, item) => sum + item.totalUsed, 0);
    const totalValueConsumed = allCompleted.reduce((sum, item) => sum + item.totalCost, 0);
    const allLocations = new Set();
    allCompleted.forEach(item => {
      state.usages.filter(u => u["Material Name"] === item.name).forEach(u => {
        if (u["Where Used"]) allLocations.add(u["Where Used"]);
      });
    });

    kpiContainer.innerHTML = `
      <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 10px;">
        <span class="kpi-subtext" style="display: block; font-size: 0.76rem;">Completed Materials</span>
        <strong style="font-size: 1.35rem; color: #f87171;">${allCompleted.length} <span style="font-size: 0.8rem; font-weight: 400; color: var(--text-muted);">Items (0 Stock)</span></strong>
      </div>
      <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 10px;">
        <span class="kpi-subtext" style="display: block; font-size: 0.76rem;">Total Units Consumed</span>
        <strong style="font-size: 1.35rem; color: var(--text-primary);">${totalUnitsConsumed}</strong>
      </div>
      <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 10px;">
        <span class="kpi-subtext" style="display: block; font-size: 0.76rem;">Locations Served</span>
        <strong style="font-size: 1.35rem; color: #a5b4fc;">${allLocations.size} <span style="font-size: 0.8rem; font-weight: 400; color: var(--text-muted);">Sites / DBs</span></strong>
      </div>
      <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 10px;">
        <span class="kpi-subtext" style="display: block; font-size: 0.76rem;">Total Value Consumed</span>
        <strong style="font-size: 1.35rem; color: #34d399;">₹${totalValueConsumed.toLocaleString('en-IN')}</strong>
      </div>
    `;
  }

  // Filter based on search input
  const searchInput = document.getElementById('completed-stock-search-input');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const filtered = allCompleted.filter(item => {
    if (!query) return true;
    const nameMatch = item.name.toLowerCase().includes(query);
    const splits = getMaterialIndentSplits(item.name);
    const indentMatch = splits.some(s => s.indentNo.toLowerCase().includes(query));
    const usages = state.usages.filter(u => u["Material Name"] === item.name);
    const locMatch = usages.some(u => (u["Where Used"] || '').toLowerCase().includes(query) || (u["Remarks"] || '').toLowerCase().includes(query));
    return nameMatch || indentMatch || locMatch;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state" style="padding: 36px 16px; text-align: center;">
          <div style="max-width: 440px; margin: 0 auto;">
            <i data-lucide="archive" style="width: 36px; height: 36px; color: var(--text-muted); margin-bottom: 8px; opacity: 0.6;"></i>
            <p style="margin: 0; font-size: 0.95rem; font-weight: 600; color: var(--text-secondary);">
              ${query ? `No completed stock matched "${escapeHtml(query)}"` : 'No Completed Stock Records Yet'}
            </p>
            <p class="kpi-subtext" style="margin-top: 4px; font-size: 0.82rem;">
              ${query ? 'Try searching by a different term or clear the filter.' : 'When available stock for any material reaches zero, it will automatically be archived in this folder with originating indents and full usage locations.'}
            </p>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  const rowsHtml = filtered.map((item, idx) => {
    const makesList = item.makes && item.makes.size > 0 ? [...item.makes].join(', ') : '';
    const splits = getMaterialIndentSplits(item.name);
    
    // Originating indents badges & split
    const indentsHtml = splits.map(s => `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); padding: 3px 8px; border-radius: 6px;">
        <span style="font-family: monospace; font-size: 0.8rem; font-weight: 700; color: #34d399;">
          <i data-lucide="file-text" style="width: 10px; height: 10px; margin-right: 3px;"></i>${s.indentNo}
        </span>
        <strong style="font-size: 0.82rem; color: var(--text-primary);">${s.qty} <span style="font-size: 0.7rem; font-weight: normal; color: var(--text-muted);">${item.unit}</span></strong>
      </div>
    `).join('');

    // Where used breakdown
    const usages = state.usages.filter(u => u["Material Name"] === item.name);
    const locationMap = {};
    usages.forEach(u => {
      const loc = u["Where Used"] || 'Unspecified';
      const q = Number(u["Quantity"]) || 0;
      locationMap[loc] = (locationMap[loc] || 0) + q;
    });

    const locationEntries = Object.entries(locationMap);
    const locationPillsHtml = locationEntries.length === 0
      ? `<span class="kpi-subtext" style="font-size: 0.78rem;">No usage records logged</span>`
      : locationEntries.map(([loc, q]) => `
          <div style="background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.25); padding: 4px 10px; border-radius: 6px; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 5px; margin: 2px;">
            <i data-lucide="map-pin" style="width: 11px; height: 11px; color: #818cf8;"></i>
            <strong>${escapeHtml(loc)}</strong>: <span style="color: #f87171; font-weight: 700;">${q} ${item.unit}</span>
          </div>
        `).join('');

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem;">${idx + 1}</td>
        <td style="padding: 10px 14px;">
          <div style="font-weight: 700; color: var(--text-primary); font-size: 0.9rem; cursor: pointer;" class="btn-inspect-completed-mat" data-material="${escapeHtml(item.name)}">
            ${escapeHtml(item.name)}
          </div>
          <div style="display: flex; gap: 6px; align-items: center; margin-top: 3px; flex-wrap: wrap;">
            ${makesList ? `<span class="make-badge" style="font-size: 0.68rem;">Make: ${escapeHtml(makesList)}</span>` : ''}
            <span style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">${item.category}</span>
          </div>
        </td>
        <td style="padding: 10px 12px; min-width: 200px;">
          ${indentsHtml}
        </td>
        <td style="text-align: center; font-weight: 700; color: var(--text-primary); white-space: nowrap;">
          ${item.totalPurchased} <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">${item.unit}</span>
        </td>
        <td style="text-align: center; font-weight: 700; color: var(--danger); white-space: nowrap;">
          ${item.totalUsed} <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">${item.unit}</span>
        </td>
        <td style="text-align: center; white-space: nowrap;">
          <span class="status-badge out-of-stock" style="font-size: 0.72rem; padding: 3px 8px; font-weight: 700;">
            <i data-lucide="check-circle" style="width: 10px; height: 10px; margin-right: 3px;"></i> Completed
          </span>
          <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">0 Available</div>
        </td>
        <td style="padding: 10px 14px;">
          <div style="display: flex; flex-wrap: wrap; gap: 4px; max-width: 420px;">
            ${locationPillsHtml}
          </div>
        </td>
        <td style="text-align: center; white-space: nowrap;">
          <button type="button" class="btn btn-secondary btn-inspect-completed-mat" data-material="${escapeHtml(item.name)}" style="padding: 4px 10px; font-size: 0.75rem; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px; width: auto; color: #a5b4fc; border-color: rgba(99, 102, 241, 0.35);" title="View 360° Traceability &amp; Logs">
            <i data-lucide="eye" style="width: 12px; height: 12px;"></i> Inspect
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = rowsHtml;

  // Wire search input listener
  if (searchInput && !searchInput.dataset.wired) {
    searchInput.dataset.wired = 'true';
    searchInput.addEventListener('input', () => {
      renderCompletedStockTab(inventory);
    });
  }

  // Wire inspect buttons
  tbody.querySelectorAll('.btn-inspect-completed-mat').forEach(el => {
    el.onclick = () => {
      const mat = el.getAttribute('data-material');
      if (mat) openMaterialDetailModal(mat);
    };
  });

  lucide.createIcons();
}

// Event Listeners Configuration
function setupEventListeners() {
  setupReuploadInvoiceModalEvents();

  // Auto-sync when user returns to app tab or unlocks phone
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.appMode === 'cloud' && state.currentUser && state.sheetUrl) {
      syncWithCloud(true).catch(() => {});
    }
  });
  window.addEventListener('focus', () => {
    if (state.appMode === 'cloud' && state.currentUser && state.sheetUrl) {
      syncWithCloud(true).catch(() => {});
    }
  });
  // Periodic background sync every 45 seconds
  setInterval(() => {
    if (!document.hidden && state.appMode === 'cloud' && state.currentUser && state.sheetUrl) {
      syncWithCloud(true).catch(() => {});
    }
  }, 45000);

  // Purchase Form file picker trigger & hint
  const purchaseFileBtn = document.getElementById('purchase-file-btn');
  const purchaseFileInput = document.getElementById('purchase-file-input');
  const purchaseFileNameHint = document.getElementById('purchase-file-name-hint');

  if (purchaseFileBtn && purchaseFileInput) {
    purchaseFileBtn.onclick = () => purchaseFileInput.click();
    purchaseFileInput.onchange = () => {
      if (purchaseFileInput.files && purchaseFileInput.files[0]) {
        const file = purchaseFileInput.files[0];
        if (file.size > 10 * 1024 * 1024) {
          showToast('Selected file exceeds 10MB limit. Please select a smaller file.', 'error');
          purchaseFileInput.value = '';
          if (purchaseFileNameHint) purchaseFileNameHint.style.display = 'none';
          return;
        }
        if (purchaseFileNameHint) {
          purchaseFileNameHint.textContent = `Attached File: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
          purchaseFileNameHint.style.display = 'block';
        }
      } else {
        if (purchaseFileNameHint) purchaseFileNameHint.style.display = 'none';
      }
    };
  }

  // Previous Stock Form file picker trigger & hint
  const prevFileBtn = document.getElementById('prev-file-btn');
  const prevFileInput = document.getElementById('prev-file-input');
  const prevFileNameHint = document.getElementById('prev-file-name-hint');

  if (prevFileBtn && prevFileInput) {
    prevFileBtn.onclick = () => prevFileInput.click();
    prevFileInput.onchange = () => {
      if (prevFileInput.files && prevFileInput.files[0]) {
        const file = prevFileInput.files[0];
        if (file.size > 10 * 1024 * 1024) {
          showToast('Selected file exceeds 10MB limit.', 'error');
          prevFileInput.value = '';
          if (prevFileNameHint) prevFileNameHint.style.display = 'none';
          return;
        }
        if (prevFileNameHint) {
          prevFileNameHint.textContent = `Attached File: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
          prevFileNameHint.style.display = 'block';
        }
      } else {
        if (prevFileNameHint) prevFileNameHint.style.display = 'none';
      }
    };
  }

  // System & Account Dropdown toggle & click outside
  const sysDropdownBtn = document.getElementById('system-dropdown-btn');
  if (sysDropdownBtn) {
    sysDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSystemDropdown();
    });
  }

  document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('system-dropdown-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
      closeSystemDropdown();
    }
  });

  // Sidebar tab switching
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetTab = item.getAttribute('data-tab');
      if (!targetTab) return;
      switchTab(targetTab);
    });
  });

  // Home page top heading navigation switching
  document.querySelectorAll('.home-nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const targetTab = btn.getAttribute('data-tab');
      if (!targetTab) return;
      switchTab(targetTab);
    });
  });

  // Mobile sidebar toggle (if present)
  const sidebarToggleBtn = document.getElementById('sidebar-toggle');
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', () => {
      const sb = document.getElementById('app-sidebar');
      if (sb) sb.classList.add('mobile-open');
    });
  }

  // Purchase sub-tab toggle: New vs Previous Stock Entry
  document.getElementById('purchase-subtab-new').addEventListener('click', () => {
    document.getElementById('purchase-new-section').style.display = '';
    document.getElementById('purchase-prev-section').style.display = 'none';
    document.getElementById('purchase-subtab-new').classList.add('btn-primary');
    document.getElementById('purchase-subtab-new').classList.remove('btn-secondary');
    document.getElementById('purchase-subtab-prev').classList.add('btn-secondary');
    document.getElementById('purchase-subtab-prev').classList.remove('btn-primary');
    lucide.createIcons();
  });
  document.getElementById('purchase-subtab-prev').addEventListener('click', () => {
    document.getElementById('purchase-new-section').style.display = 'none';
    document.getElementById('purchase-prev-section').style.display = '';
    document.getElementById('purchase-subtab-prev').classList.add('btn-primary');
    document.getElementById('purchase-subtab-prev').classList.remove('btn-secondary');
    document.getElementById('purchase-subtab-new').classList.add('btn-secondary');
    document.getElementById('purchase-subtab-new').classList.remove('btn-primary');
    renderPrevStockTable();
    lucide.createIcons();
  });

  // KPI Card: Available Materials click → drill-down modal
  const kpiMaterialsCard = document.getElementById('kpi-card-materials');
  if (kpiMaterialsCard) {
    kpiMaterialsCard.addEventListener('click', () => {
      openKpiDrilldown('materials');
    });
  }
  // KPI Card: Low Stock Alerts click → drill-down modal
  const kpiLowstockCard = document.getElementById('kpi-card-lowstock');
  if (kpiLowstockCard) {
    kpiLowstockCard.addEventListener('click', () => {
      openKpiDrilldown('lowstock');
    });
  }
  // Close drill-down modal
  document.getElementById('close-drilldown-btn').addEventListener('click', () => {
    document.getElementById('kpi-drilldown-modal').classList.remove('active');
  });
  document.getElementById('kpi-drilldown-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('kpi-drilldown-modal')) {
      document.getElementById('kpi-drilldown-modal').classList.remove('active');
    }
  });

  // Completed Stock folder shortcut from inventory tab
  const btnCompletedFolder = document.getElementById('btn-open-completed-folder-shortcut');
  if (btnCompletedFolder) {
    btnCompletedFolder.addEventListener('click', () => switchTab('completed-stock'));
  }

  // Previous Stock form submit
  document.getElementById('prev-stock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitPrevStock();
  });

  // Close mobile sidebar click outside (if present)
  document.addEventListener('click', (e) => {
    const sidebar = document.getElementById('app-sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    if (sidebar && toggle && !sidebar.contains(e.target) && !toggle.contains(e.target) && sidebar.classList.contains('mobile-open')) {
      sidebar.classList.remove('mobile-open');
    }
  });

  // Smart Search key listener
  document.getElementById('inventory-search').addEventListener('input', () => {
    const inventory = calculateInventory();
    filterAndRenderInventory(inventory);
  });
  
  // Status filter change
  document.getElementById('inventory-status-filter').addEventListener('change', () => {
    const inventory = calculateInventory();
    filterAndRenderInventory(inventory);
  });
  
  // Category filter change
  document.getElementById('inventory-category-filter').addEventListener('change', () => {
    const inventory = calculateInventory();
    filterAndRenderInventory(inventory);
  });

  // Rows per page change
  document.getElementById('inventory-page-size').addEventListener('change', (e) => {
    const val = e.target.value;
    inventoryPagination.pageSize = val === 'all' ? 999999 : parseInt(val, 10);
    inventoryPagination.currentPage = 1;
    renderInventoryTable();
  });
  // Pagination clicks
  document.getElementById('inventory-prev-btn').addEventListener('click', () => {
    if (inventoryPagination.currentPage > 1) {
      inventoryPagination.currentPage--;
      renderInventoryTable();
    }
  });
  
  document.getElementById('inventory-next-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(inventoryPagination.filteredItems.length / inventoryPagination.pageSize) || 1;
    if (inventoryPagination.currentPage < totalPages) {
      inventoryPagination.currentPage++;
      renderInventoryTable();
    }
  });

  // Add item row event listener
  document.getElementById('add-item-row-btn').addEventListener('click', () => {
    addPurchaseItemRow();
  });

  // Calculate items sum and remove rows via event delegation
  const itemsList = document.getElementById('purchase-items-list');
  itemsList.addEventListener('input', (e) => {
    if (e.target.classList.contains('item-quantity') || e.target.classList.contains('item-rate')) {
      const row = e.target.closest('.purchase-item-row');
      calculateRowAmount(row);
      calculatePurchaseGrandTotal();
    }
  });

  itemsList.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.remove-item-row-btn');
    if (removeBtn) {
      const row = removeBtn.closest('.purchase-item-row');
      row.remove();
      updateRemoveRowButtonsVisibility();
      calculatePurchaseGrandTotal();
    }
  });

  // Auto-open calendar picker on clicking the date inputs
  const purchaseDateInput = document.getElementById('purchase-date');
  if (purchaseDateInput) {
    purchaseDateInput.addEventListener('click', function() {
      if (typeof this.showPicker === 'function') {
        try { this.showPicker(); } catch (err) { console.log(err); }
      }
    });
  }

  const usageDateInput = document.getElementById('usage-date');
  if (usageDateInput) {
    usageDateInput.addEventListener('click', function() {
      if (typeof this.showPicker === 'function') {
        try { this.showPicker(); } catch (err) { console.log(err); }
      }
    });
  }

  // Purchase Form submit
  document.getElementById('purchase-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitPurchase();
  });

  // Usage Material selector change (to show maximum stock allowed to use and purchase history)
  document.getElementById('usage-material').addEventListener('change', (e) => {
    const name = e.target.value;
    const inventory = calculateInventory();
    const item = inventory[name];
    if (item) {
      document.getElementById('usage-max-hint').textContent = `Max available: ${item.available} ${item.unit}`;
      document.getElementById('usage-quantity').max = item.available;
    } else {
      document.getElementById('usage-max-hint').textContent = '';
    }
    renderUsagePurchasesBreakdown(name);
  });

  // Where Used — Block type change handler
  document.getElementById('usage-block-type').addEventListener('change', (e) => {
    const blockVal = e.target.value;
    const unitGroup = document.getElementById('usage-unit-group');
    const unitLabel = document.getElementById('usage-unit-label');
    const otherGroup = document.getElementById('usage-other-group');
    const unitSelect = document.getElementById('usage-unit-number');

    // Map of block codes -> { prefix, count }
    const blockMap = {
      'C':   { prefix: 'C',   count: 9  },
      'D':   { prefix: 'D',   count: 20 },
      'E':   { prefix: 'E',   count: 28 },
      'F':   { prefix: 'F',   count: 52 },
      'G':   { prefix: 'G',   count: 88 },
      'SRU': { prefix: 'SRU', count: 32 },
      'DRU': { prefix: 'DRU', count: 44 },
      'TRU': { prefix: 'TRU', count: 12 }
    };

    // Reset
    if (unitLabel) unitLabel.textContent = 'Unit / Quarter Number';
    unitGroup.style.display = 'none';
    otherGroup.style.display = 'none';
    unitSelect.innerHTML = '<option value="" disabled selected>Select unit number...</option>';
    document.getElementById('usage-location').value = '';

    if (blockVal === 'A&B') {
      // No sub-number for A&B, location is the block itself
      document.getElementById('usage-location').value = 'A&B Block';
    } else if (blockVal === 'Pragyan') {
      // Pragyan Hostel: floors 0-5, rooms 01-16 per floor
      const floors = [0, 1, 2, 3, 4, 5];
      floors.forEach(floor => {
        // Add an optgroup label as a disabled separator option
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = floor === 0 ? '── Ground Floor (01–16) ──' : `── Floor ${floor} (${floor}01–${floor}16) ──`;
        unitSelect.appendChild(sep);
        for (let room = 1; room <= 16; room++) {
          const roomNum = floor === 0
            ? String(room).padStart(2, '0')
            : `${floor}${String(room).padStart(2, '0')}`;
          const opt = document.createElement('option');
          opt.value = `Room ${roomNum}`;
          opt.textContent = `Room ${roomNum}`;
          unitSelect.appendChild(opt);
        }
      });
      unitGroup.style.display = 'block';
    } else if (blockVal === 'Electrical Substation' || blockVal === 'Substation' || blockVal === 'Substations') {
      if (unitLabel) unitLabel.textContent = 'Substation / Unit Number';
      unitSelect.innerHTML = '<option value="" disabled selected>Select substation (SS-I, SS-II, SS-III)...</option>';
      const substations = ['SS-I', 'SS-II', 'SS-III'];
      substations.forEach(ss => {
        const opt = document.createElement('option');
        opt.value = ss;
        opt.textContent = ss;
        unitSelect.appendChild(opt);
      });
      unitGroup.style.display = 'block';
    } else if (blockVal === 'SS-I' || blockVal === 'SS-II' || blockVal === 'SS-III') {
      document.getElementById('usage-location').value = `Electrical Substation — ${blockVal}`;
    } else if (blockVal === 'Pump House' || blockVal === 'Pump Houses') {
      if (unitLabel) unitLabel.textContent = 'Pump House / Station Name';
      unitSelect.innerHTML = '<option value="" disabled selected>Select pump house location...</option>';
      const pumpHouses = ['Internal Pump House', 'Habsiguda Pump House', 'NEERI Pump House', 'Colony Borewell'];
      pumpHouses.forEach(ph => {
        const opt = document.createElement('option');
        opt.value = ph;
        opt.textContent = ph;
        unitSelect.appendChild(opt);
      });
      unitGroup.style.display = 'block';
    } else if (['Internal Pump House', 'Habsiguda Pump House', 'NEERI Pump House', 'Colony Borewell'].includes(blockVal)) {
      document.getElementById('usage-location').value = `Pump House — ${blockVal}`;
    } else if (blockVal === 'Street Lights' || blockVal === 'Street Lighting') {
      if (unitLabel) unitLabel.textContent = 'Street Light Section / Location';
      unitSelect.innerHTML = '<option value="" disabled selected>Select street light location...</option>';
      const streetLights = ['Incampus Street Lights', 'Outcampus Street Lights'];
      streetLights.forEach(sl => {
        const opt = document.createElement('option');
        opt.value = sl;
        opt.textContent = sl;
        unitSelect.appendChild(opt);
      });
      unitGroup.style.display = 'block';
    } else if (['Incampus Street Lights', 'Outcampus Street Lights'].includes(blockVal)) {
      document.getElementById('usage-location').value = `Street Lights — ${blockVal}`;
    } else if (blockVal === 'Other') {
      otherGroup.style.display = 'block';
    } else if (blockMap[blockVal]) {
      const { prefix, count } = blockMap[blockVal];
      for (let i = 1; i <= count; i++) {
        const opt = document.createElement('option');
        opt.value = `${prefix}${i}`;
        opt.textContent = `${prefix}${i}`;
        unitSelect.appendChild(opt);
      }
      unitGroup.style.display = 'block';
    } else {
      // Fixed location (Main Office, Conference Hall etc.)
      document.getElementById('usage-location').value = blockVal;
    }
  });

  // Unit number selected — combine into hidden field
  document.getElementById('usage-unit-number').addEventListener('change', (e) => {
    const blockVal = document.getElementById('usage-block-type').value;
    const unitVal = e.target.value;
    if (blockVal && unitVal) {
      const labelMap = {
        'C': 'C-Type Quarter',
        'D': 'D-Type Quarter',
        'E': 'E-Type Quarter',
        'F': 'F-Type Quarter',
        'G': 'G-Type Quarter',
        'SRU': 'SRU Quarter',
        'DRU': 'DRU Quarter',
        'TRU': 'TRU Quarter',
        'Pragyan': 'Pragyan Hostel',
        'Electrical Substation': 'Electrical Substation',
        'Substation': 'Electrical Substation',
        'Substations': 'Electrical Substation',
        'Pump House': 'Pump House',
        'Pump Houses': 'Pump House',
        'Street Lights': 'Street Lights',
        'Street Lighting': 'Street Lights'
      };
      const label = labelMap[blockVal] || blockVal;
      document.getElementById('usage-location').value = `${label} — ${unitVal}`;
    }
  });

  // Other text — update hidden field
  document.getElementById('usage-other-text').addEventListener('input', (e) => {
    document.getElementById('usage-location').value = e.target.value.trim();
  });

  // Usage Form submit
  document.getElementById('usage-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitUsage();
  });

  // Manual Sync Button
  document.getElementById('manual-sync-btn').addEventListener('click', () => {
    closeSystemDropdown();
    if (state.appMode === 'cloud') {
      syncWithCloud();
    } else {
      showToast('Currently running in Local Demo Mode. Set Sheets URL in Settings to sync.', 'info');
    }
  });

  // Settings Save URL
  document.getElementById('save-settings-btn').addEventListener('click', () => {
    const url = document.getElementById('settings-sheet-url').value.trim();
    if (url === '') {
      state.sheetUrl = '';
      state.appMode = 'local';
      localStorage.removeItem('electrastock_url');
      updateDbBadge(false);
      loadLocalData();
      updateUI();
      showToast('Switched to Local Demo Mode.', 'success');
    } else {
      if (!url.startsWith('https://script.google.com/macros/s/') || !url.endsWith('/exec')) {
        showToast('Invalid Apps Script Web App URL structure!', 'error');
        return;
      }
      state.sheetUrl = url;
      state.appMode = 'cloud';
      localStorage.setItem('electrastock_url', url);
      updateDbBadge(true);
      syncWithCloud();
    }
  });

  // Test Connection
  document.getElementById('test-connection-btn').addEventListener('click', () => {
    testGoogleSheetsConnection();
  });

  // Reset to Demo Data
  document.getElementById('reset-data-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to reset all data back to the default local demo records? This will clear local edits.')) {
      localStorage.removeItem('electrastock_purchases');
      localStorage.removeItem('electrastock_usages');
      localStorage.removeItem('electrastock_thresholds');
      loadLocalData();
      updateUI();
      showToast('Inventory reset to default demo data.', 'success');
    }
  });

  // Push local-only invoices to Google Drive so all PCs can see them
  const syncLocalInvBtn = document.getElementById('sync-local-invoices-btn');
  if (syncLocalInvBtn) {
    syncLocalInvBtn.addEventListener('click', () => {
      syncLocalInvoicesToDrive();
    });
  }

  // Threshold edit modal save
  document.getElementById('threshold-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitThresholdUpdate();
  });

  // Modal Cancel Close
  document.getElementById('close-modal-btn').addEventListener('click', closeThresholdModal);

  // Full Edit Previous Stock Modal Handlers
  const editPrevForm = document.getElementById('edit-prev-stock-form');
  if (editPrevForm) {
    editPrevForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitEditPrevStock();
    });
  }
  const closeEditPrevBtn = document.getElementById('close-edit-prev-modal-btn');
  if (closeEditPrevBtn) {
    closeEditPrevBtn.addEventListener('click', closeEditPrevStockModal);
  }

  // Dynamic Add Building Modal Handlers
  const openAddBldgBtn = document.getElementById('open-add-building-btn');
  if (openAddBldgBtn) {
    openAddBldgBtn.addEventListener('click', openAddBuildingModal);
  }
  const closeAddBldgBtn = document.getElementById('close-add-building-modal-btn');
  if (closeAddBldgBtn) {
    closeAddBldgBtn.addEventListener('click', closeAddBuildingModal);
  }
  const addBldgForm = document.getElementById('add-building-form');
  if (addBldgForm) {
    addBldgForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitNewBuilding();
    });
  }

  const closeMatDetailBtn = document.getElementById('close-mat-detail-modal-btn');
  if (closeMatDetailBtn) {
    closeMatDetailBtn.addEventListener('click', closeMaterialDetailModal);
  }

  // Make edit modal save
  document.getElementById('make-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitMakeUpdate();
  });
  document.getElementById('close-make-modal-btn')?.addEventListener('click', closeEditMakeModal);
  document.getElementById('close-make-modal-cancel-btn')?.addEventListener('click', closeEditMakeModal);
  
  // Copy script to clipboard
  document.getElementById('copy-script-btn').addEventListener('click', () => {
    copyScriptCode();
  });

  // Login Form Submit Event
  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitLogin();
  });

  // Logout Click Event
  document.getElementById('logout-btn').addEventListener('click', (e) => {
    e.preventDefault();
    handleLogout();
  });
}

// Handle login submissions
function submitLogin() {
  const user = document.getElementById('login-username').value.trim();
  const pass = document.getElementById('login-password').value.trim();
  const card = document.querySelector('#login-overlay .modal-content');
  
  let role = null;
  if (user === 'admin' && pass === 'admin123') {
    role = 'admin';
  } else if (user === 'staff' && pass === 'staff123') {
    role = 'staff';
  }
  
  if (role) {
    state.currentUser = role;
    sessionStorage.setItem('electrastock_role', role);
    
    // Hide login screen
    document.getElementById('login-overlay').classList.remove('active');
    
    // Apply role limits
    applyRoleRestrictions();
    
    // Reset forms
    document.getElementById('login-form').reset();
    
    // Initialize data
    if (state.appMode === 'cloud') {
      syncWithCloud();
    } else {
      loadLocalData();
      updateUI();
    }
    
    showToast(`Logged in successfully as ${role === 'admin' ? 'Administrator' : 'Staff'}!`, 'success');
  } else {
    // Shake login card to indicate error
    card.classList.add('shake');
    showToast('Invalid username or password!', 'error');
    setTimeout(() => card.classList.remove('shake'), 500);
  }
}

// Handle logout actions
function handleLogout() {
  closeSystemDropdown();
  if (confirm('Are you sure you want to log out of Electrical Inventory?')) {
    sessionStorage.removeItem('electrastock_role');
    state.currentUser = null;
    
    // Show login overlay
    document.getElementById('login-overlay').classList.add('active');
    showToast('Logged out of session.', 'info');
  }
}

// Open Set Threshold Dialog
function openThresholdModal(name, currentThreshold, unit) {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can adjust stock thresholds.', 'error');
    return;
  }
  document.getElementById('threshold-material-name').value = name;
  document.getElementById('threshold-display-name').value = name;
  document.getElementById('threshold-value').value = currentThreshold;
  document.getElementById('threshold-unit-hint').textContent = `Unit measurement: ${unit}`;
  document.getElementById('threshold-modal').classList.add('active');
}

// Close Set Threshold Dialog
function closeThresholdModal() {
  document.getElementById('threshold-modal').classList.remove('active');
}

// Toast System
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'info';
  if (type === 'success') icon = 'check-circle';
  if (type === 'error') icon = 'alert-octagon';
  
  toast.innerHTML = `
    <i data-lucide="${icon}"></i>
    <span class="toast-message">${message}</span>
  `;
  
  container.appendChild(toast);
  lucide.createIcons();
  
  // Slide out and remove
  setTimeout(() => {
    toast.style.animation = 'toastIn 0.3s ease reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Submit a purchase entry (write to Local or Cloud)
// Submit a purchase batch entry (supports separate PO/Invoice per item)
function submitPurchase() {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can record purchases.', 'error');
    return;
  }
  const indentNo = document.getElementById('purchase-indent').value.trim();
  const receivedDateRaw = document.getElementById('purchase-date').value;
  const receivedDate = formatDateToDDMMYYYY(receivedDateRaw);
  const source = document.getElementById('purchase-source').value;
  const indentPoLinkEl = document.getElementById('purchase-indent-po-link');
  const indentPoLink = indentPoLinkEl ? indentPoLinkEl.value.trim() : '';
  
  // Collect all items from the form rows
  const itemRows = document.querySelectorAll('.purchase-item-row');
  const items = [];
  
  let isValid = true;
  itemRows.forEach(row => {
    const materialName = row.querySelector('.item-material').value.trim();
    const make = row.querySelector('.item-make') ? row.querySelector('.item-make').value.trim() : '';
    const unit = row.querySelector('.item-unit').value;
    const quantity = parseFloat(row.querySelector('.item-quantity').value) || 0;
    const rate = parseFloat(row.querySelector('.item-rate').value) || 0;
    const amount = quantity * rate;
    const itemPoLink = row.querySelector('.item-po-link') ? row.querySelector('.item-po-link').value.trim() : '';
    const poLink = itemPoLink || indentPoLink;
    const fileInput = row.querySelector('.item-file-input');
    const fileObj = (fileInput && fileInput.files && fileInput.files[0]) ? fileInput.files[0] : null;
    
    if (!materialName || quantity <= 0 || rate <= 0) {
      isValid = false;
    }
    
    items.push({
      materialName: materialName,
      make: make,
      unit: unit,
      quantity: quantity,
      rate: rate,
      amount: amount,
      poLink: poLink,
      fileObj: fileObj,
      fileData: ''
    });
  });
  
  if (!isValid || items.length === 0) {
    showToast('Please fill all material item fields with valid quantities and rates.', 'error');
    return;
  }

  // Read any per-item selected files into Base64 Data URLs
  const filePromises = items.map(item => {
    if (!item.fileObj) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        item.fileData = e.target.result;
        resolve();
      };
      reader.onerror = () => reject(new Error(`Error reading file for ${item.materialName}`));
      reader.readAsDataURL(item.fileObj);
    });
  });

  Promise.all(filePromises)
    .then(() => {
      processPurchaseSubmission(indentNo, receivedDate, source, items);
    })
    .catch(err => {
      showToast(err.message || 'Error reading selected invoice file.', 'error');
    });
}

/** Process purchase batch submission (handles per-item IndexedDB local saving & Drive POST uploading) */
async function processPurchaseSubmission(indentNo, receivedDate, source, items) {
  // 1. Save Base64 file into IndexedDB for each item that has a file
  for (const item of items) {
    if (item.fileData) {
      const pRecord = {
        "Indent No": indentNo,
        "Received Date": receivedDate,
        "Material Name": item.materialName
      };
      const key = makePurchaseKey(pRecord);
      await InvoiceStorage.saveInvoice(key, item.fileData, item.fileObj ? item.fileObj.name : 'invoice.pdf');
    }
  }

  // 2. If Cloud mode is connected
  if (state.appMode === 'cloud' && state.sheetUrl) {
    const hasAnyFile = items.some(it => it.fileData && it.fileObj);
    if (hasAnyFile) {
      setSyncingAnimation(true);
      // Send per-item addPurchase requests so each item gets its own separate Drive file & PO Link
      const itemPromises = items.map(item => {
        if (item.fileData && item.fileObj) {
          const payload = {
            action: 'addPurchase',
            indentNo: indentNo,
            receivedDate: receivedDate,
            materialName: item.materialName,
            make: item.make,
            unit: item.unit,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
            source: source,
            poLink: item.poLink || '',
            fileName: item.fileObj.name,
            fileData: item.fileData
          };
          return fetch(state.sheetUrl, {
            method: 'POST',
            mode: 'cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
          }).then(res => res.json());
        } else {
          const query = new URLSearchParams({
            action: 'addPurchase',
            indentNo: indentNo,
            receivedDate: receivedDate,
            materialName: item.materialName,
            make: item.make,
            unit: item.unit,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
            source: source,
            poLink: item.poLink || ''
          });
          return fetch(`${state.sheetUrl}?${query.toString()}`, {
            method: 'GET',
            mode: 'cors',
            redirect: 'follow'
          }).then(res => res.json());
        }
      });

      Promise.all(itemPromises)
        .then(results => {
          setSyncingAnimation(false);
          let uploadedToDrive = false;
          items.forEach((item, idx) => {
            const res = results[idx];
            const pRecord = {
              "Indent No": indentNo,
              "Received Date": receivedDate,
              "Material Name": item.materialName
            };
            const itemKey = makePurchaseKey(pRecord);
            const driveUrl = (res && res.status === 'success' && res.fileUrl)
              ? res.fileUrl
              : (item.fileData ? ('idb:' + itemKey) : (item.poLink || ''));
            if (driveUrl.startsWith('https://')) uploadedToDrive = true;

            try {
              const overrides = JSON.parse(localStorage.getItem('electrastock_invoice_overrides') || '{}');
              if (driveUrl) {
                overrides[itemKey] = driveUrl;
              } else {
                delete overrides[itemKey];
              }
              localStorage.setItem('electrastock_invoice_overrides', JSON.stringify(overrides));
            } catch (e) {}

            state.purchases.unshift({
              "Indent No": indentNo,
              "Received Date": receivedDate,
              "Material Name": item.materialName,
              "Make": item.make,
              "Unit": item.unit,
              "Quantity": item.quantity,
              "Rate": item.rate,
              "Amount": item.amount,
              "Source": source,
              "PO Link": driveUrl
            });
          });

          savePurchasesToLocalStorage();
          if (uploadedToDrive) {
            showToast('Purchases recorded & PO/invoices uploaded to Google Drive! Visible on all PCs.', 'success');
          } else {
            showToast('Purchases recorded! Note: Drive upload issue; invoices stored locally on this PC as fallback.', 'warning');
          }
          resetPurchaseForm();
          syncWithCloud();
        })
        .catch(err => {
          console.error('Cloud per-item POST failed, falling back locally:', err);
          setSyncingAnimation(false);
          showToast(`Drive upload failed (${err.message || 'Network/CORS error'}). Falling back to local storage.`, 'warning');
          sendPurchaseBatchNormal(indentNo, receivedDate, source, items);
        });
      return;
    }
  }

  sendPurchaseBatchNormal(indentNo, receivedDate, source, items);
}

// Send purchase batch using per-item PO links (CORS-safe GET requests or local storage).
async function sendPurchaseBatchNormal(indentNo, receivedDate, source, items, poLink = '') {
  // If any item has base64 fileData or poLink starting with data:, ensure it's saved in IndexedDB
  let hasLocalFiles = false;
  for (const item of items) {
    const itemLink = item.fileData || item.poLink || poLink || '';
    if (itemLink && (itemLink.startsWith('data:') || item.fileData)) {
      hasLocalFiles = true;
      const pRecord = {
        "Indent No": indentNo,
        "Received Date": receivedDate,
        "Material Name": item.materialName
      };
      const key = makePurchaseKey(pRecord);
      await InvoiceStorage.saveInvoice(key, itemLink, item.fileObj ? item.fileObj.name : 'invoice.pdf');
    }
  }

  if (state.appMode === 'local') {
    items.forEach(item => {
      const pRecord = {
        "Indent No": indentNo,
        "Received Date": receivedDate,
        "Material Name": item.materialName
      };
      const key = makePurchaseKey(pRecord);
      const itemLink = item.fileData ? ('idb:' + key) : (item.poLink || poLink || '');
      state.purchases.unshift({
        "Indent No": indentNo,
        "Received Date": receivedDate,
        "Material Name": item.materialName,
        "Make": item.make,
        "Unit": item.unit,
        "Quantity": item.quantity,
        "Rate": item.rate,
        "Amount": item.amount,
        "Source": source,
        "PO Link": itemLink
      });
    });
    savePurchasesToLocalStorage();
    updateUI();
    if (hasLocalFiles) {
      showToast('Batch purchase saved locally. Connect Google Sheet in Settings to save files to Google Drive across all PCs.', 'warning');
    } else {
      showToast('Batch purchase saved locally in Demo Mode.', 'success');
    }
    resetPurchaseForm();
  } else {
    setSyncingAnimation(true);

    const fetchPromises = items.map(item => {
      const itemLink = item.poLink || poLink || '';
      const query = new URLSearchParams({
        action: 'addPurchase',
        indentNo: indentNo,
        receivedDate: receivedDate,
        materialName: item.materialName,
        make: item.make,
        unit: item.unit,
        quantity: item.quantity,
        rate: item.rate,
        amount: item.amount,
        source: source,
        poLink: itemLink.startsWith('data:') ? '' : itemLink
      });
      return fetch(`${state.sheetUrl}?${query.toString()}`, {
        method: 'GET',
        mode: 'cors',
        redirect: 'follow'
      }).then(res => res.json());
    });

    Promise.all(fetchPromises)
      .then(results => {
        const allOk = results.every(r => r.status === 'success');
        if (allOk) {
          showToast('Batch purchases synced to Google Sheets!', 'success');
          resetPurchaseForm();
          syncWithCloud();
        } else {
          const failed = results.find(r => r.status !== 'success');
          throw new Error(failed ? failed.message : 'One or more items failed to save');
        }
      })
      .catch(err => {
        console.error(err);
        showToast(`Sync failed: ${err.message || 'Could not reach Google Sheets.'}`, 'error');
        items.forEach(item => {
          const pRecord = {
            "Indent No": indentNo,
            "Received Date": receivedDate,
            "Material Name": item.materialName
          };
          const key = makePurchaseKey(pRecord);
          const itemLink = item.fileData ? ('idb:' + key) : (item.poLink || poLink || '');
          state.purchases.unshift({
            "Indent No": indentNo,
            "Received Date": receivedDate,
            "Material Name": item.materialName,
            "Make": item.make,
            "Unit": item.unit,
            "Quantity": item.quantity,
            "Rate": item.rate,
            "Amount": item.amount,
            "Source": source,
            "PO Link": itemLink
          });
        });
        savePurchasesToLocalStorage();
        updateUI();
      })
      .finally(() => {
        setSyncingAnimation(false);
      });
  }
}

/** Save state.purchases to LocalStorage without exceeding 5MB quota */
function savePurchasesToLocalStorage() {
  // 1. Sanitize in-memory state so state.purchases never holds raw base64 data URLs
  state.purchases.forEach(item => {
    const link = (item["PO Link"] || item["poLink"] || item["fileUrl"] || '').toString();
    if (link.startsWith('data:')) {
      const key = makePurchaseKey(item);
      item["PO Link"] = 'idb:' + key;
      delete item["poLink"];
      delete item["fileUrl"];
      delete item["fileData"];
      delete item["fileObj"];
    }
  });

  // 2. Prepare safe copy for localStorage, filtering out synthetic prev-stock rows
  const safePurchases = state.purchases
    .filter(item => !item["_prevId"] && item["Indent No"] !== 'PREV-STOCK')
    .map(item => {
      const itemCopy = { ...item };
      const link = (itemCopy["PO Link"] || itemCopy["poLink"] || itemCopy["fileUrl"] || '').toString();
      if (link.startsWith('data:')) {
        const key = makePurchaseKey(itemCopy);
        itemCopy["PO Link"] = 'idb:' + key;
      }
      delete itemCopy["poLink"];
      delete itemCopy["fileUrl"];
      delete itemCopy["fileData"];
      delete itemCopy["fileObj"];
      return itemCopy;
    });

  try {
    localStorage.setItem('electrastock_purchases', JSON.stringify(safePurchases));
  } catch (e) {
    console.warn('LocalStorage quota warning for purchases:', e);
    try {
      // Fallback: minimal metadata
      const minimal = safePurchases.map(p => ({
        "Indent No": p["Indent No"],
        "Received Date": p["Received Date"],
        "Material Name": p["Material Name"],
        "Make": p["Make"],
        "Unit": p["Unit"],
        "Quantity": p["Quantity"],
        "Rate": p["Rate"],
        "Amount": p["Amount"],
        "Source": p["Source"],
        "PO Link": (p["PO Link"] && p["PO Link"].length < 300) ? p["PO Link"] : ''
      }));
      localStorage.setItem('electrastock_purchases', JSON.stringify(minimal));
    } catch (err2) {
      console.error('LocalStorage write failed completely:', err2);
    }
  }
}

// Add a new material input row to the purchase form (with its own separate PO / Invoice upload)
function addPurchaseItemRow(materialName = '', make = '', unit = 'Meters', quantity = '', rate = '', poLink = '') {
  const container = document.getElementById('purchase-items-list');
  const row = document.createElement('div');
  row.className = 'purchase-item-row';
  
  row.innerHTML = `
    <div class="form-group" style="flex: 2.2; min-width: 160px; margin-bottom: 0;">
      <label class="form-label">Material Name</label>
      <input type="text" class="form-input item-material" required placeholder="e.g. 1.5 sqmm copper wire" value="${materialName}" list="material-suggestions">
    </div>
    <div class="form-group" style="flex: 1.8; min-width: 130px; margin-bottom: 0;">
      <label class="form-label">Make / Brand</label>
      <input type="text" class="form-input item-make" placeholder="e.g. Havells, Polycab" value="${make}" list="make-suggestions">
    </div>
    <div class="form-group" style="flex: 1.2; min-width: 100px; margin-bottom: 0;">
      <label class="form-label">Unit</label>
      <select class="form-select item-unit" required>
        <option value="Meters" ${unit === 'Meters' ? 'selected' : ''}>Meters</option>
        <option value="Nos" ${unit === 'Nos' ? 'selected' : ''}>Nos</option>
        <option value="Coils" ${unit === 'Coils' ? 'selected' : ''}>Coils</option>
        <option value="Sets" ${unit === 'Sets' ? 'selected' : ''}>Sets</option>
        <option value="DBs" ${unit === 'DBs' ? 'selected' : ''}>DBs</option>
      </select>
    </div>
    <div class="form-group" style="flex: 1; min-width: 75px; margin-bottom: 0;">
      <label class="form-label">Quantity</label>
      <input type="number" step="any" min="0.01" class="form-input item-quantity" required placeholder="Qty" value="${quantity}">
    </div>
    <div class="form-group" style="flex: 1; min-width: 75px; margin-bottom: 0;">
      <label class="form-label">Rate (₹)</label>
      <input type="number" step="any" min="0.01" class="form-input item-rate" required placeholder="Rate" value="${rate}">
    </div>
    <div style="flex: 1.2; min-width: 75px; text-align: right; padding-bottom: 12px; font-weight: 600; font-size: 0.95rem;">
      <span class="kpi-subtext" style="display: block; font-size: 0.75rem; text-align: right; margin-bottom: 4px; text-transform: uppercase;">Amount</span>
      ₹<span class="item-amount-val">0.00</span>
    </div>
    <button type="button" class="btn btn-danger remove-item-row-btn" style="align-self: flex-end; flex-shrink: 0; margin-bottom: 0;">
      <i data-lucide="trash-2" style="width: 16px; height: 16px;"></i>
    </button>
    <div style="flex-basis: 100%; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 10px; margin-top: 2px; border-top: 1px dashed rgba(255,255,255,0.08);">
      <span class="kpi-subtext" style="font-size: 0.78rem; display: inline-flex; align-items: center; gap: 5px; color: #34d399; font-weight: 600;">
        <i data-lucide="link" style="width: 13px; height: 13px;"></i> Google Drive PO/Invoice Link:
      </span>
      <input type="url" class="form-input item-po-link" placeholder="Paste Google Drive Link (Anyone with the link can view)" value="${poLink}" style="flex: 1; min-width: 250px; padding: 7px 12px; font-size: 0.82rem; border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.04);">
      <input type="file" class="item-file-input" accept=".pdf,image/png,image/jpeg,image/jpg" style="display: none;">
      <button type="button" class="btn btn-secondary item-file-btn" style="padding: 6px 12px; font-size: 0.76rem; width: auto; flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted);" title="Upload local file instead">
        <i data-lucide="upload-cloud" style="width: 13px; height: 13px;"></i> Or Upload File
      </button>
      <div class="item-file-hint-wrap" style="display: none; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 6px;">
        <span class="item-file-hint" style="font-size: 0.76rem; color: var(--success); font-weight: 600;"></span>
        <button type="button" class="item-file-clear-btn" title="Remove selected file" style="background: none; border: none; color: var(--danger); cursor: pointer; padding: 0 2px; display: inline-flex; align-items: center;">
          <i data-lucide="x" style="width: 13px; height: 13px;"></i>
        </button>
      </div>
    </div>
  `;
  
  container.appendChild(row);

  // Wire per-item PO/Invoice file picker & clear button
  const itemFileBtn = row.querySelector('.item-file-btn');
  const itemFileInput = row.querySelector('.item-file-input');
  const itemHintWrap = row.querySelector('.item-file-hint-wrap');
  const itemHint = row.querySelector('.item-file-hint');
  const itemClearBtn = row.querySelector('.item-file-clear-btn');

  if (itemFileBtn && itemFileInput) {
    itemFileBtn.addEventListener('click', () => itemFileInput.click());
    itemFileInput.addEventListener('change', () => {
      if (itemFileInput.files && itemFileInput.files[0]) {
        const file = itemFileInput.files[0];
        if (file.size > 10 * 1024 * 1024) {
          showToast('Selected file exceeds 10MB limit. Please select a smaller file.', 'error');
          itemFileInput.value = '';
          if (itemHintWrap) itemHintWrap.style.display = 'none';
          return;
        }
        if (itemHint) itemHint.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        if (itemHintWrap) itemHintWrap.style.display = 'inline-flex';
      } else {
        if (itemHintWrap) itemHintWrap.style.display = 'none';
      }
    });
  }

  if (itemClearBtn && itemFileInput) {
    itemClearBtn.addEventListener('click', () => {
      itemFileInput.value = '';
      if (itemHint) itemHint.textContent = '';
      if (itemHintWrap) itemHintWrap.style.display = 'none';
    });
  }

  lucide.createIcons();
  
  calculateRowAmount(row);
  updateRemoveRowButtonsVisibility();
}

// Calculate total for a single row (Qty * Rate)
function calculateRowAmount(row) {
  const qty = parseFloat(row.querySelector('.item-quantity').value) || 0;
  const rate = parseFloat(row.querySelector('.item-rate').value) || 0;
  const amountVal = row.querySelector('.item-amount-val');
  amountVal.textContent = (qty * rate).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Recalculate Grand Total of all rows
function calculatePurchaseGrandTotal() {
  const itemRows = document.querySelectorAll('.purchase-item-row');
  let grandTotal = 0;
  
  itemRows.forEach(row => {
    const qty = parseFloat(row.querySelector('.item-quantity').value) || 0;
    const rate = parseFloat(row.querySelector('.item-rate').value) || 0;
    grandTotal += qty * rate;
  });
  
  document.getElementById('purchase-grand-total').textContent = '₹' + grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Hide the trash remove icon if there is only one row in the list
function updateRemoveRowButtonsVisibility() {
  const rows = document.querySelectorAll('.purchase-item-row');
  rows.forEach(row => {
    const btn = row.querySelector('.remove-item-row-btn');
    if (rows.length <= 1) {
      btn.style.display = 'none';
    } else {
      btn.style.display = 'inline-flex';
    }
  });
}

// Reset invoice form back to empty headers and exactly one blank item row
function resetPurchaseForm() {
  const indentField = document.getElementById('purchase-indent');
  if (indentField) indentField.value = '';
  setDefaultDates();
  const sourceField = document.getElementById('purchase-source');
  if (sourceField) sourceField.value = 'GEM';
  const poLinkField = document.getElementById('purchase-po-link');
  if (poLinkField) poLinkField.value = '';
  const indentPoLinkField = document.getElementById('purchase-indent-po-link');
  if (indentPoLinkField) indentPoLinkField.value = '';

  const fileInput = document.getElementById('purchase-file-input');
  if (fileInput) fileInput.value = '';
  const fileHint = document.getElementById('purchase-file-name-hint');
  if (fileHint) fileHint.style.display = 'none';


  // Clear items list and add one empty row
  const container = document.getElementById('purchase-items-list');
  if (container) {
    container.innerHTML = '';
    addPurchaseItemRow();
  }
  
  calculatePurchaseGrandTotal();
}

// Submit a usage entry (write to Local or Cloud with stock verification)
function submitUsage() {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can log material usages.', 'error');
    return;
  }
  const dateRaw = document.getElementById('usage-date').value;
  const date = formatDateToDDMMYYYY(dateRaw);
  const materialName = document.getElementById('usage-material').value;
  const quantity = parseFloat(document.getElementById('usage-quantity').value);
  const whereUsed = document.getElementById('usage-location').value.trim();
  const remarks = document.getElementById('usage-remarks').value.trim();

  if (!dateRaw) {
    showToast('Please select the Date Used from the calendar.', 'error');
    document.getElementById('usage-date').focus();
    return;
  }

  if (!materialName) {
    showToast('Please select a material in stock.', 'error');
    return;
  }

  if (!whereUsed) {
    showToast('Please select a location / quarter in "Where Used".', 'error');
    return;
  }
  
  // Verify stock
  const inventory = calculateInventory();
  const item = inventory[materialName];
  if (!item || item.available < quantity) {
    showToast(`Insufficient stock! Available: ${item ? item.available : 0}`, 'error');
    return;
  }
  
  const record = {
    "Date": date,
    "Material Name": materialName,
    "Quantity": quantity,
    "Where Used": whereUsed,
    "Remarks": remarks
  };
  
  if (state.appMode === 'local') {
    state.usages.unshift(record);
    localStorage.setItem('electrastock_usages', JSON.stringify(state.usages));
    updateUI();
    showToast('Usage record saved locally.', 'success');
    document.getElementById('usage-form').reset();
    // Reset location selector UI
    document.getElementById('usage-unit-group').style.display = 'none';
    document.getElementById('usage-other-group').style.display = 'none';
    document.getElementById('usage-location').value = '';
    setDefaultDates();
    document.getElementById('usage-max-hint').textContent = '';
    renderUsagePurchasesBreakdown('');
  } else {
    // Cloud Mode Sync
    setSyncingAnimation(true);
    
    // Construct query parameters for GET CORS fallback write
    const query = new URLSearchParams({
      action: 'addUsage',
      date: date,
      materialName: materialName,
      quantity: quantity,
      whereUsed: whereUsed,
      remarks: remarks
    });
    
    fetch(`${state.sheetUrl}?${query.toString()}`, {
      method: 'GET',
      mode: 'cors',
      redirect: 'follow'
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === 'success') {
        showToast('Usage synced to Google Sheet successfully!', 'success');
        document.getElementById('usage-form').reset();
        // Reset location selector UI
        document.getElementById('usage-unit-group').style.display = 'none';
        document.getElementById('usage-other-group').style.display = 'none';
        document.getElementById('usage-location').value = '';
        setDefaultDates();
        document.getElementById('usage-max-hint').textContent = '';
        renderUsagePurchasesBreakdown('');
        // Trigger a pull to refresh inventory
        syncWithCloud();
      } else {
        throw new Error(data.message || 'Unknown sheets error');
      }
    })
    .catch(err => {
      console.error(err);
      if (err.message && err.message !== 'Failed to fetch') {
        showToast(`Sync failed: ${err.message}`, 'error');
      } else {
        showToast('Error syncing to Sheet. Saved locally instead.', 'error');
      }
      // Save locally as temporary fallback
      state.usages.unshift(record);
      localStorage.setItem('electrastock_usages', JSON.stringify(state.usages));
      updateUI();
    })
    .finally(() => {
      setSyncingAnimation(false);
    });
  }
}

// Submit stock warning limit threshold updates
function submitThresholdUpdate() {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can adjust stock thresholds.', 'error');
    return;
  }
  const name = document.getElementById('threshold-material-name').value;
  const threshold = parseFloat(document.getElementById('threshold-value').value);
  
  if (state.appMode === 'local') {
    state.thresholds[name] = threshold;
    localStorage.setItem('electrastock_thresholds', JSON.stringify(state.thresholds));
    updateUI();
    showToast(`Threshold updated for ${name}`, 'success');
    closeThresholdModal();
  } else {
    // Cloud Mode Sync
    setSyncingAnimation(true);
    
    const query = new URLSearchParams({
      action: 'updateThreshold',
      materialName: name,
      threshold: threshold
    });
    
    fetch(`${state.sheetUrl}?${query.toString()}`, {
      method: 'GET',
      mode: 'cors',
      redirect: 'follow'
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === 'success') {
        state.thresholds[name] = threshold; // update locally
        localStorage.setItem('electrastock_thresholds', JSON.stringify(state.thresholds));
        showToast(`Threshold synced to Google Sheets for ${name}`, 'success');
        closeThresholdModal();
        syncWithCloud();
      } else {
        throw new Error(data.message || 'Unknown sheets error');
      }
    })
    .catch(err => {
      console.error(err);
      if (err.message && err.message !== 'Failed to fetch') {
        showToast(`Sync failed: ${err.message}`, 'error');
      } else {
        showToast('Failed to update threshold on Sheets. Saved locally.', 'error');
      }
      state.thresholds[name] = threshold;
      localStorage.setItem('electrastock_thresholds', JSON.stringify(state.thresholds));
      updateUI();
      closeThresholdModal();
    })
    .finally(() => {
      setSyncingAnimation(false);
    });
  }
}

// Sync Pull data from Google Sheet Web App
function syncWithCloud(isSilent = false) {
  if (state.appMode !== 'cloud' || !state.sheetUrl) {
    if (!isSilent) showToast('Google Sheets URL not configured in settings!', 'error');
    return Promise.resolve();
  }
  
  if (!isSilent) setSyncingAnimation(true);
  
  const separator = state.sheetUrl.includes('?') ? '&' : '?';
  const fetchUrl = `${state.sheetUrl}${separator}_t=${Date.now()}`;

  return fetch(fetchUrl, {
    method: 'GET',
    mode: 'cors',
    cache: 'no-cache',
    redirect: 'follow'
  })
  .then(res => {
    if (!res.ok) throw new Error('Network response not OK');
    return res.json();
  })
  .then(async data => {
    if (data.purchases && data.usages) {
      state.purchases = data.purchases;
      state.usages = data.usages;
      
      // Parse thresholds list into key-value map
      const thresholdMap = {};
      if (data.thresholds && Array.isArray(data.thresholds)) {
        data.thresholds.forEach(t => {
          thresholdMap[t["Material Name"]] = Number(t["Low Stock Threshold"]);
        });
      }
      state.thresholds = thresholdMap;
      
      // Sync any brand/make values from cloud into electrastock_material_makes
      try {
        const matMakes = JSON.parse(localStorage.getItem('electrastock_material_makes') || '{}');
        let matMakesUpdated = false;
        state.purchases.forEach(p => {
          const mat = (p['Material Name'] || '').toString().trim();
          const mk = (p['Make'] || p['make'] || '').toString().trim();
          if (mat && mk && (!matMakes[mat] || matMakes[mat] !== mk)) {
            matMakes[mat] = mk;
            matMakesUpdated = true;
          }
        });
        if (matMakesUpdated) {
          localStorage.setItem('electrastock_material_makes', JSON.stringify(matMakes));
        }
      } catch (e) {}

      // Sanitize cloud overrides first: if cloud removed an invoice, discard local cache so it won't resurrect
      sanitizeCloudOverrides();

      // Re-apply local Make & Invoice overrides BEFORE caching — cloud data may not carry local files yet
      applyMakeOverrides();
      await applyInvoiceOverrides();

      // Update local storage cache safely
      savePurchasesToLocalStorage();
      try {
        localStorage.setItem('electrastock_usages', JSON.stringify(state.usages));
      } catch (e) {
        console.warn('LocalStorage usages quota warning:', e);
      }
      try {
        localStorage.setItem('electrastock_thresholds', JSON.stringify(state.thresholds));
      } catch (e) {
        console.warn('LocalStorage thresholds quota warning:', e);
      }
      
      updateUI();
      if (!isSilent) showToast('Inventory synced successfully from Google Sheets!', 'success');
    } else {
      throw new Error('Data payload structure invalid');
    }
  })
  .catch(err => {
    console.error(err);
    if (!isSilent) {
      if (err.message && err.message !== 'Failed to fetch') {
        showToast(`Failed to fetch from Google Sheets: ${err.message}`, 'error');
      } else {
        showToast('Failed to fetch from Google Sheets! Using local cache instead.', 'error');
      }
    }
    loadLocalData();
    updateUI();
  })
  .finally(() => {
    if (!isSilent) setSyncingAnimation(false);
  });
}

// Test sheet configuration without saving it permanently
function testGoogleSheetsConnection() {
  const url = document.getElementById('settings-sheet-url').value.trim();
  
  if (url === '') {
    showToast('Please enter a Web App URL to test.', 'error');
    return;
  }
  
  if (!url.startsWith('https://script.google.com/macros/s/') || !url.endsWith('/exec')) {
    showToast('Invalid Apps Script Web App URL structure!', 'error');
    return;
  }
  
  setSyncingAnimation(true);
  
  fetch(url, {
    method: 'GET',
    mode: 'cors',
    redirect: 'follow'
  })
  .then(res => {
    if (!res.ok) throw new Error('API connection refused.');
    return res.json();
  })
  .then(data => {
    if (data.purchases && data.usages) {
      showToast('Connection Test Successful! Google Sheet database structure found.', 'success');
    } else {
      showToast('Connection Successful, but Sheets data is uninitialized.', 'warning');
    }
  })
  .catch(err => {
    console.error(err);
    if (err.message && err.message !== 'Failed to fetch') {
      showToast(`Connection Failed: ${err.message}`, 'error');
    } else {
      showToast('Connection Failed! Ensure script is deployed correctly as "Anyone" has access.', 'error');
    }
  })
  .finally(() => {
    setSyncingAnimation(false);
  });
}

// Syncing button spinning animation toggle
function setSyncingAnimation(isSyncing) {
  const btn = document.getElementById('manual-sync-btn');
  if (isSyncing) {
    btn.classList.add('spinning');
    btn.querySelector('span').textContent = 'Syncing...';
  } else {
    btn.classList.remove('spinning');
    btn.querySelector('span').textContent = 'Sync Data';
  }
}

// Copy Code Helper
function copyScriptCode() {
  fetch('google-apps-script.js')
    .then(res => res.text())
    .then(text => {
      navigator.clipboard.writeText(text)
        .then(() => showToast('Apps Script code copied to clipboard!', 'success'))
        .catch(() => showToast('Failed to copy. Please copy from google-apps-script.js manually.', 'error'));
    })
    .catch(() => {
      showToast('Error reading google-apps-script.js file.', 'error');
    });
}

// ─────────────────────────────────────────────────────────────────
// KPI Drill-Down Modal
// ─────────────────────────────────────────────────────────────────

/**
 * Opens the KPI drill-down modal.
 * @param {'materials'|'lowstock'} type
 */
function openKpiDrilldown(type) {
  const modal = document.getElementById('kpi-drilldown-modal');
  const heading = document.getElementById('kpi-drilldown-heading');
  const icon = document.getElementById('kpi-drilldown-icon');
  const thead = document.getElementById('kpi-drilldown-thead');
  const tbody = document.getElementById('kpi-drilldown-tbody');

  const inventory = calculateInventory();
  tbody.innerHTML = '';

  if (type === 'materials') {
    heading.textContent = 'Available Materials';
    icon.setAttribute('data-lucide', 'package-open');
    thead.innerHTML = `<tr>
      <th style="width:36px; text-align:center;">#</th>
      <th style="text-align:left;">Material Name</th>
      <th style="width:110px; text-align:left;">Make / Brand</th>
      <th style="width:80px; text-align:center;">Purchased</th>
      <th style="width:65px; text-align:center;">Used</th>
      <th style="width:95px; text-align:center;">Available</th>
      <th style="width:65px; text-align:center;">Unit</th>
      <th style="width:100px; text-align:center;">Status</th>
    </tr>`;

    const items = Object.values(inventory).sort((a, b) => a.name.localeCompare(b.name));
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No materials found.</td></tr>';
    } else {
      items.forEach((item, idx) => {
        let statusClass = 'in-stock', statusText = 'In Stock';
        if (item.status === 'out-of-stock') { statusClass = 'out-of-stock'; statusText = 'Out of Stock'; }
        else if (item.status === 'low-stock') { statusClass = 'low-stock'; statusText = 'Low Stock'; }

        const makesArray = Array.from(item.makes || []);
        const makesDisplay = makesArray.length > 0
          ? makesArray.map(m => `<span class="make-badge">${m}</span>`).join(' ')
          : `<span class="kpi-subtext">—</span>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="text-align:center; color:var(--text-muted); font-size:0.8rem;">${idx + 1}</td>
          <td style="font-weight:600; word-break:break-word;">${item.name}</td>
          <td>${makesDisplay}</td>
          <td style="text-align:center;">${item.totalPurchased}</td>
          <td style="text-align:center; color:var(--danger);">${item.totalUsed}</td>
          <td style="text-align:center; font-weight:700; color:var(--success);">${Math.round(item.available * 100) / 100}</td>
          <td class="kpi-subtext">${item.unit}</td>
          <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        `;
        tbody.appendChild(tr);
      });
    }

  } else if (type === 'lowstock') {
    heading.textContent = 'Low Stock & Out of Stock Items';
    icon.setAttribute('data-lucide', 'alert-triangle');
    thead.innerHTML = `<tr>
      <th style="text-align:left;">Material Name</th>
      <th>Left Qty</th>
      <th>Unit</th>
      <th>Threshold</th>
      <th>Status</th>
    </tr>`;

    const alertItems = Object.values(inventory).filter(i => i.status !== 'in-stock');
    if (alertItems.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state" style="color:var(--success);">✅ All materials are well stocked!</td></tr>';
    } else {
      alertItems.sort((a, b) => a.available - b.available).forEach(item => {
        let statusClass = item.status === 'out-of-stock' ? 'out-of-stock' : 'low-stock';
        let statusText = item.status === 'out-of-stock' ? 'Out of Stock' : 'Low Stock';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight:600;">${item.name}</td>
          <td style="text-align:center; font-weight:700; color:${item.status === 'out-of-stock' ? 'var(--danger)' : 'var(--warning)'};">
            ${Math.round(item.available * 100) / 100}
          </td>
          <td class="kpi-subtext">${item.unit}</td>
          <td style="text-align:center; font-family:monospace;">${item.threshold}</td>
          <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  lucide.createIcons();
  modal.classList.add('active');
}

// ─────────────────────────────────────────────────────────────────
// Previous Stock Entry & Dynamic Building Functions
// ─────────────────────────────────────────────────────────────────

/** Synchronize electrastock_prev_stocks with state.purchases and state.usages */
function syncPrevStocksToGlobalState() {
  const prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
  
  // Clean out any previously synced prev-stock records from state
  state.purchases = state.purchases.filter(p => !p["_prevId"] && p["Indent No"] !== 'PREV-STOCK');
  state.usages = state.usages.filter(u => !u["_prevId"]);

  prevStocks.forEach((rec, index) => {
    const id = rec.id || ('PREV-' + index + '-' + Date.now());
    rec.id = id;

    // Purchase record
    const pRecord = {
      "_prevId": id,
      "Indent No": rec.indentNo || 'PREV-STOCK',
      "Received Date": rec.date || 'Before App Setup',
      "Material Name": rec.name,
      "Make": rec.make || '',
      "Unit": rec.unit || 'Nos',
      "Quantity": Number(rec.purchasedQty) || 0,
      "Rate": Number(rec.rate) || 0,
      "Amount": (Number(rec.purchasedQty) || 0) * (Number(rec.rate) || 0),
      "Source": rec.source || 'GEM',
      "PO Link": rec.poLink || "",
      "Note": "Previous stock entry"
    };
    state.purchases.push(pRecord);

    // Usage record if usedQty > 0
    const usedQty = Number(rec.usedQty) || 0;
    if (usedQty > 0) {
      const uRecord = {
        "_prevId": id,
        "Date": rec.date || 'Before App Setup',
        "Material Name": rec.name,
        "Quantity": usedQty,
        "Where Used": "Pre-App Usage (Location Unknown)",
        "Remarks": rec.remarks || 'Previous stock usage'
      };
      state.usages.push(uRecord);
    }
  });

  // Note: syncPrevStocksToGlobalState is an in-memory sync for inventory calculations.
  // We intentionally do not serialize unsanitized state.purchases to localStorage here
  // to avoid QuotaExceededError during continuous UI updates.
}

/** Submit a Previous Stock Entry (purchased qty + left qty, usage auto-calculated) */
function submitPrevStock() {
  const indentNo = document.getElementById('prev-indent') ? document.getElementById('prev-indent').value.trim() || 'PREV-STOCK' : 'PREV-STOCK';
  const name     = document.getElementById('prev-material-name').value.trim();
  const make     = document.getElementById('prev-make') ? document.getElementById('prev-make').value.trim() : '';
  const unit     = document.getElementById('prev-unit').value;
  const source   = document.getElementById('prev-source').value;
  const pQty     = parseFloat(document.getElementById('prev-purchased-qty').value) || 0;
  const leftQty  = parseFloat(document.getElementById('prev-left-qty').value);
  const date     = document.getElementById('prev-date').value || 'Before App Setup';
  const rate     = parseFloat(document.getElementById('prev-rate').value) || 0;
  const prevFileInput = document.getElementById('prev-file-input');
  const selectedPrevFile = prevFileInput && prevFileInput.files && prevFileInput.files[0] ? prevFileInput.files[0] : null;

  if (!name) { showToast('Please enter a material name.', 'error'); return; }
  if (isNaN(leftQty)) { showToast('Please enter the left/available quantity.', 'error'); return; }
  if (leftQty > pQty) { showToast('Left quantity cannot exceed purchased quantity.', 'error'); return; }

  if (selectedPrevFile) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const dataUrl = e.target.result;
      processPrevStockSubmission(indentNo, name, make, unit, source, pQty, leftQty, date, rate, poLink || dataUrl, remarks, selectedPrevFile, dataUrl);
    };
    reader.readAsDataURL(selectedPrevFile);
  } else {
    processPrevStockSubmission(indentNo, name, make, unit, source, pQty, leftQty, date, rate, poLink, remarks, null, '');
  }
}

/** Process previous stock submission with optional file upload & IndexedDB persistence */
async function processPrevStockSubmission(indentNo, name, make, unit, source, pQty, leftQty, date, rate, poLink, remarks, fileObj, base64DataUrl) {
  const usedQty = pQty - leftQty;
  const id = 'PREV-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

  const pTemp = { "Indent No": indentNo, "Received Date": date, "Material Name": name };
  const key = makePurchaseKey(pTemp);

  if (base64DataUrl) {
    await InvoiceStorage.saveInvoice(key, base64DataUrl, fileObj ? fileObj.name : 'invoice.pdf');
    poLink = 'idb:' + key;
  }

  const record = { id, indentNo, name, make, unit, source, purchasedQty: pQty, leftQty, usedQty, date, rate, remarks, poLink };

  let prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
  prevStocks.push(record);
  localStorage.setItem('electrastock_prev_stocks', JSON.stringify(prevStocks));

  syncPrevStocksToGlobalState();

  if (state.appMode === 'cloud') {
    syncWithCloud();
  } else {
    updateUI();
  }

  renderPrevStockTable();

  // Reset form & file hints
  document.getElementById('prev-stock-form').reset();
  if (prevFileInput) prevFileInput.value = '';
  const prevHint = document.getElementById('prev-file-name-hint');
  if (prevHint) prevHint.style.display = 'none';

  showToast(`Previous stock for "${name}" saved successfully!`, 'success');
}

/** Renders the Previous Stock history table */
function renderPrevStockTable() {
  const tbody = document.getElementById('prev-stock-table-body');
  if (!tbody) return;

  const prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
  tbody.innerHTML = '';

  if (prevStocks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No previous stock entries uploaded yet.</td></tr>';
    return;
  }

  // Populate datalist
  const datalist = document.getElementById('prev-material-suggestions');
  if (datalist) {
    datalist.innerHTML = '';
    prevStocks.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.name;
      datalist.appendChild(opt);
    });
  }

  const inventory = calculateInventory();
  const canEdit = state.currentUser !== 'staff';

  [...prevStocks].reverse().forEach((record, revIdx) => {
    const realIndex = prevStocks.length - 1 - revIdx;
    const makeVal = record.make ? record.make.toString().trim() : '';
    const makeDisplay = makeVal ? `<span class="make-badge">${escapeHtml(makeVal)}</span>` : `<span class="kpi-subtext">—</span>`;

    // Calculate Low Stock status badge for previous data
    const itemInv = inventory[record.name];
    let statusClass = 'in-stock', statusText = 'In Stock';
    if (itemInv) {
      if (itemInv.status === 'out-of-stock') { statusClass = 'out-of-stock'; statusText = 'Out of Stock'; }
      else if (itemInv.status === 'low-stock') { statusClass = 'low-stock'; statusText = 'Low Stock'; }
    } else {
      if (record.leftQty <= 0) { statusClass = 'out-of-stock'; statusText = 'Out of Stock'; }
    }

    const actionCell = canEdit
      ? `<td style="text-align: center; white-space: nowrap;">
          <div style="display: inline-flex; align-items: center; gap: 5px;">
            <button type="button" class="btn btn-secondary btn-edit-prev-stock" data-index="${realIndex}" title="Edit Indent &amp; Material Details for ${escapeHtml(record.name)}" style="padding: 4px 8px; font-size: 0.78rem; width: auto; min-width: unset; border-radius: 6px; display: inline-flex; align-items: center; gap: 3px;">
              <i data-lucide="edit-3" style="width: 12px; height: 12px;"></i> Edit
            </button>
            <button type="button" class="btn btn-danger btn-delete-prev-stock" data-index="${realIndex}" title="Delete Record for ${escapeHtml(record.name)}" style="padding: 4px 7px; font-size: 0.78rem; width: auto; min-width: unset; border-radius: 6px; display: inline-flex; align-items: center; gap: 2px; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.35); color: #fca5a5;">
              <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
            </button>
          </div>
        </td>`
      : `<td style="text-align: center;"><span class="kpi-subtext">—</span></td>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="kpi-subtext" style="font-family: monospace; font-weight: 600; color: #34d399;">${escapeHtml(record.indentNo || 'PREV-STOCK')}</span>
          ${canEdit ? `<button type="button" class="btn-quick-edit-prev-indent" data-index="${realIndex}" title="Edit Indent No" style="background:none; border:none; color:#818cf8; cursor:pointer; padding:2px;"><i data-lucide="edit-2" style="width:11px; height:11px;"></i></button>` : ''}
        </div>
      </td>
      <td style="font-weight: 600;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span>${escapeHtml(record.name)}</span>
          ${canEdit ? `<button type="button" class="btn-quick-edit-prev-mat" data-index="${realIndex}" title="Edit Material Name" style="background:none; border:none; color:#818cf8; cursor:pointer; padding:2px;"><i data-lucide="edit-2" style="width:11px; height:11px;"></i></button>` : ''}
        </div>
      </td>
      <td>${makeDisplay}</td>
      <td style="text-align: center;">${record.purchasedQty} <span class="kpi-subtext">${escapeHtml(record.unit)}</span></td>
      <td style="text-align: center; font-weight: 700; color: var(--success);">${record.leftQty}</td>
      <td style="text-align: center; color: var(--danger);">${record.usedQty > 0 ? record.usedQty : '0'}</td>
      <td class="kpi-subtext">${escapeHtml(record.unit)}</td>
      <td><span class="status-badge ${getSourceBadgeClass(record.source)}">${escapeHtml(record.source || 'GEM')}</span></td>
      <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      ${actionCell}
    `;
    tbody.appendChild(tr);
  });

  // Wire action buttons
  if (canEdit) {
    tbody.querySelectorAll('.btn-edit-prev-stock, .btn-quick-edit-prev-indent, .btn-quick-edit-prev-mat').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        openEditPrevStockModal(idx);
        if (btn.classList.contains('btn-quick-edit-prev-indent')) {
          setTimeout(() => {
            const el = document.getElementById('edit-prev-indent');
            if (el) { el.focus(); el.select(); }
          }, 100);
        } else if (btn.classList.contains('btn-quick-edit-prev-mat')) {
          setTimeout(() => {
            const el = document.getElementById('edit-prev-material-name');
            if (el) { el.focus(); el.select(); }
          }, 100);
        }
      });
    });

    tbody.querySelectorAll('.btn-delete-prev-stock').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        deletePrevStock(idx);
      });
    });
  }

  lucide.createIcons();
}

/** Open Full Edit Previous Stock Modal */
function openEditPrevStockModal(index) {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can edit previous stock.', 'error');
    return;
  }
  const prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
  const record = prevStocks[index];
  if (!record) return;

  document.getElementById('edit-prev-index').value = index;
  document.getElementById('edit-prev-indent').value = record.indentNo || '';
  document.getElementById('edit-prev-material-name').value = record.name || '';
  document.getElementById('edit-prev-make').value = record.make || '';
  document.getElementById('edit-prev-unit').value = record.unit || 'Nos';
  document.getElementById('edit-prev-source').value = record.source || 'GEM';
  document.getElementById('edit-prev-purchased-qty').value = record.purchasedQty || '';
  document.getElementById('edit-prev-left-qty').value = record.leftQty !== undefined ? record.leftQty : '';
  document.getElementById('edit-prev-date').value = record.date && record.date !== 'Before App Setup' ? record.date : '';
  document.getElementById('edit-prev-rate').value = record.rate || '';
  const poLinkInput = document.getElementById('edit-prev-po-link');
  if (poLinkInput) poLinkInput.value = record.poLink || '';
  document.getElementById('edit-prev-remarks').value = record.remarks || '';

  // Check if other records share this indent
  const batchWrap = document.getElementById('edit-prev-indent-batch-wrap');
  const batchCountEl = document.getElementById('edit-prev-batch-count');
  const batchCheck = document.getElementById('edit-prev-update-all-indent-items');
  if (batchWrap) {
    const curIndent = (record.indentNo || '').toString().trim();
    if (curIndent) {
      const otherSameIndent = prevStocks.filter((r, idx) => idx !== index && (r.indentNo || '').toString().trim() === curIndent);
      if (otherSameIndent.length > 0) {
        batchWrap.style.display = 'block';
        if (batchCountEl) batchCountEl.textContent = otherSameIndent.length;
        if (batchCheck) batchCheck.checked = false;
      } else {
        batchWrap.style.display = 'none';
      }
    } else {
      batchWrap.style.display = 'none';
    }
  }

  const modal = document.getElementById('edit-prev-stock-modal');
  modal.classList.add('active');
  lucide.createIcons();
}

/** Close Full Edit Previous Stock Modal */
function closeEditPrevStockModal() {
  const modal = document.getElementById('edit-prev-stock-modal');
  if (modal) modal.classList.remove('active');
}

/** Submit Full Edit Previous Stock Updates */
function submitEditPrevStock() {
  const index = parseInt(document.getElementById('edit-prev-index').value, 10);
  let prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
  const record = prevStocks[index];
  if (!record) return;

  const oldIndentNo = (record.indentNo || '').toString().trim();
  const oldName = record.name;

  const indentNo = document.getElementById('edit-prev-indent').value.trim() || 'PREV-STOCK';
  const name     = document.getElementById('edit-prev-material-name').value.trim();
  const make     = document.getElementById('edit-prev-make').value.trim();
  const unit     = document.getElementById('edit-prev-unit').value;
  const source   = document.getElementById('edit-prev-source').value;
  const pQty     = parseFloat(document.getElementById('edit-prev-purchased-qty').value) || 0;
  const leftQty  = parseFloat(document.getElementById('edit-prev-left-qty').value);
  const date     = document.getElementById('edit-prev-date').value || 'Before App Setup';
  const rate     = parseFloat(document.getElementById('edit-prev-rate').value) || 0;
  const poLinkEl = document.getElementById('edit-prev-po-link');
  const poLink   = poLinkEl ? poLinkEl.value.trim() : (record.poLink || '');
  const remarks  = document.getElementById('edit-prev-remarks').value.trim() || 'Previous stock entry';

  if (!name) { showToast('Please enter a material name.', 'error'); return; }
  if (isNaN(leftQty)) { showToast('Please enter the left/available quantity.', 'error'); return; }
  if (leftQty > pQty) { showToast('Left quantity cannot exceed purchased quantity.', 'error'); return; }

  const usedQty = pQty - leftQty;

  record.indentNo = indentNo;
  record.name = name;
  record.make = make;
  record.unit = unit;
  record.source = source;
  record.purchasedQty = pQty;
  record.leftQty = leftQty;
  record.usedQty = usedQty;
  record.date = date;
  record.rate = rate;
  record.poLink = poLink;
  record.remarks = remarks;

  // If batch update checked:
  const batchCheck = document.getElementById('edit-prev-update-all-indent-items');
  if (batchCheck && batchCheck.checked && oldIndentNo && oldIndentNo !== indentNo) {
    prevStocks.forEach((r, idx) => {
      if (idx !== index && (r.indentNo || '').toString().trim() === oldIndentNo) {
        r.indentNo = indentNo;
      }
    });
  }

  // If material name was changed, also update any usage records referencing oldName
  if (oldName && oldName !== name) {
    state.usages.forEach(u => {
      if (u["Material Name"] === oldName && u["_prevId"] === record.id) {
        u["Material Name"] = name;
      }
    });
    localStorage.setItem('electrastock_usages', JSON.stringify(state.usages));
  }

  localStorage.setItem('electrastock_prev_stocks', JSON.stringify(prevStocks));
  syncPrevStocksToGlobalState();

  closeEditPrevStockModal();
  updateUI();
  renderPrevStockTable();
  showToast(`Updated previous stock for "${name}" successfully!`, 'success');
}

/** Delete Previous Stock Entry */
function deletePrevStock(index) {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can delete records.', 'error');
    return;
  }
  let prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
  const record = prevStocks[index];
  if (!record) return;

  const matName = record.name;
  if (confirm(`Are you sure you want to delete the previous stock entry for "${matName}"?`)) {
    const matchingUsages = state.usages.filter(u => u["Material Name"] === matName);
    let deleteUsagesToo = false;

    if (matchingUsages.length > 0) {
      deleteUsagesToo = confirm(`"${matName}" also has ${matchingUsages.length} maintenance usage record(s) logged.\n\nDo you want to delete those usage records as well so "${matName}" is completely removed from stock inventory?`);
    }

    prevStocks.splice(index, 1);
    localStorage.setItem('electrastock_prev_stocks', JSON.stringify(prevStocks));

    if (deleteUsagesToo) {
      state.usages = state.usages.filter(u => u["Material Name"] !== matName);
      localStorage.setItem('electrastock_usages', JSON.stringify(state.usages));
    }

    syncPrevStocksToGlobalState();
    updateUI();
    renderPrevStockTable();
    showToast(`Deleted previous stock entry for "${matName}".`, 'info');
  }
}

/** Delete Purchase Entry */
async function deletePurchaseRecord(index) {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can delete records.', 'error');
    return;
  }
  const p = state.purchases[index];
  if (!p) return;

  const matName = p["Material Name"] || p.name || 'this item';
  const indentNo = p["Indent No"] || p.indentNo || '';
  const date = p["Received Date"] || p.date || '';
  if (!confirm(`Are you sure you want to delete the purchase entry for "${matName}" (Indent: ${indentNo})?`)) {
    return;
  }

  if (p["_prevId"]) {
    let prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
    prevStocks = prevStocks.filter(r => r.id !== p["_prevId"]);
    localStorage.setItem('electrastock_prev_stocks', JSON.stringify(prevStocks));
  }

  state.purchases.splice(index, 1);
  savePurchasesToLocalStorage();

  // Check if any purchase records remain for matName
  const remainingPurchases = state.purchases.filter(item => item["Material Name"] === matName);
  const matchingUsages = state.usages.filter(u => u["Material Name"] === matName);

  if (remainingPurchases.length === 0 && matchingUsages.length > 0) {
    if (confirm(`No remaining purchase records exist for "${matName}".\n\nDo you also want to delete its ${matchingUsages.length} usage record(s) so it is completely removed from stock inventory?`)) {
      state.usages = state.usages.filter(u => u["Material Name"] !== matName);
      localStorage.setItem('electrastock_usages', JSON.stringify(state.usages));
    }
  }

  updateUI();

  if (state.appMode === 'cloud' && state.sheetUrl) {
    setSyncingAnimation(true);
    try {
      const query = new URLSearchParams({
        action: 'deletePurchase',
        indentNo: indentNo,
        materialName: matName,
        date: date,
        _t: Date.now().toString()
      });
      await fetch(`${state.sheetUrl}?${query.toString()}`, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-cache',
        redirect: 'follow'
      });
      await syncWithCloud();
      showToast(`Deleted purchase entry for "${matName}" across all PCs.`, 'success');
    } catch (err) {
      console.error(err);
      await syncWithCloud();
      showToast(`Deleted purchase entry for "${matName}".`, 'info');
    } finally {
      setSyncingAnimation(false);
    }
  } else {
    showToast(`Deleted purchase entry for "${matName}".`, 'info');
  }
}

// ─────────────────────────────────────────────────────────────────
// Dynamic Building Addition Logic
// ─────────────────────────────────────────────────────────────────

/** Loads custom added building options into usage block selector */
function loadCustomBuildings() {
  const custom = JSON.parse(localStorage.getItem('electrastock_custom_buildings') || '[]');
  const group = document.getElementById('usage-custom-optgroup');
  if (!group) return;

  group.innerHTML = '';
  if (custom.length > 0) {
    group.style.display = 'block';
    custom.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      group.appendChild(opt);
    });
  } else {
    group.style.display = 'none';
  }
}

/** Open Add Building Modal */
function openAddBuildingModal() {
  document.getElementById('new-building-name').value = '';
  const modal = document.getElementById('add-building-modal');
  modal.classList.add('active');
  lucide.createIcons();
}

/** Close Add Building Modal */
function closeAddBuildingModal() {
  const modal = document.getElementById('add-building-modal');
  if (modal) modal.classList.remove('active');
}

/** Submit New Custom Building */
function submitNewBuilding() {
  const name = document.getElementById('new-building-name').value.trim();
  if (!name) { showToast('Please enter a building name.', 'error'); return; }

  let custom = JSON.parse(localStorage.getItem('electrastock_custom_buildings') || '[]');
  if (!custom.includes(name)) {
    custom.push(name);
    localStorage.setItem('electrastock_custom_buildings', JSON.stringify(custom));
  }

  loadCustomBuildings();

  // Select the newly added building
  const select = document.getElementById('usage-block-type');
  select.value = name;
  document.getElementById('usage-location').value = name;
  document.getElementById('usage-unit-group').style.display = 'none';
  document.getElementById('usage-other-group').style.display = 'none';

  closeAddBuildingModal();
  showToast(`Building / Area "${name}" added successfully!`, 'success');
}

// Dynamic Make / Brand Suggestions Datalist Updater
function updateMakeSuggestionsDatalist() {
  const datalist = document.getElementById('make-suggestions');
  if (!datalist) return;
  const standardMakes = [
    'Havells', 'Polycab', 'Finolex', 'Schneider Electric', 'Legrand',
    'Anchor by Panasonic', 'L&T Electrical', 'Crompton', 'Philips',
    'Wipro', 'Syska', 'Siemens', 'ABB', 'RR Kabel', 'KEI Industries',
    'Orient Electric', 'Bajaj', 'Goldmedal', 'V-Guard'
  ];
  const allMakes = new Set(standardMakes);
  if (Array.isArray(state.purchases)) {
    state.purchases.forEach(p => {
      if (p['Make'] && p['Make'].toString().trim()) {
        allMakes.add(p['Make'].toString().trim());
      }
    });
  }
  try {
    const matMakes = JSON.parse(localStorage.getItem('electrastock_material_makes') || '{}');
    Object.values(matMakes).forEach(m => {
      if (m && m.toString().trim()) allMakes.add(m.toString().trim());
    });
  } catch (e) {}
  try {
    const prev = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
    prev.forEach(r => {
      if (r.make && r.make.toString().trim()) allMakes.add(r.make.toString().trim());
    });
  } catch (e) {}

  datalist.innerHTML = '';
  Array.from(allMakes).sort((a, b) => a.localeCompare(b)).forEach(makeName => {
    const opt = document.createElement('option');
    opt.value = makeName;
    datalist.appendChild(opt);
  });
}

// Edit Make Modal State & Handlers
let currentEditMakeState = { type: 'purchase', index: -1, materialName: '' };

const POPULAR_MAKE_BRANDS = [
  'Crompton', 'Havells', 'Polycab', 'Finolex', 'Philips',
  'Schneider Electric', 'Legrand', 'Anchor by Panasonic',
  'L&T Electrical', 'Siemens', 'Syska', 'Wipro', 'Orient Electric', 'Bajaj', 'Goldmedal'
];

/**
 * Render Quick 1-click popular brand autofill chips inside the Make Modal
 * @param {string} currentVal
 */
function renderMakeQuickChips(currentVal = '') {
  const container = document.getElementById('make-quick-chips');
  if (!container) return;
  const input = document.getElementById('make-input-val');
  
  container.innerHTML = POPULAR_MAKE_BRANDS.map(brand => {
    const isMatch = currentVal && currentVal.trim().toLowerCase() === brand.toLowerCase();
    return `<button type="button" class="brand-chip-btn ${isMatch ? 'active' : ''}" data-brand="${escapeHtml(brand)}">${escapeHtml(brand)}</button>`;
  }).join('');

  container.querySelectorAll('.brand-chip-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const brand = btn.getAttribute('data-brand');
      if (input && brand) {
        input.value = brand;
        container.querySelectorAll('.brand-chip-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        input.focus();
      }
    };
  });
}

function openEditMakeModal(type, index) {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can edit Make / Brand.', 'error');
    return;
  }
  currentEditMakeState = { type, index, materialName: '' };
  const modal = document.getElementById('make-modal');
  const materialInput = document.getElementById('make-display-material');
  const indentInput = document.getElementById('make-display-indent');
  const makeInput = document.getElementById('make-input-val');
  const applyAllCheckbox = document.getElementById('make-apply-all-checkbox');

  if (type === 'purchase') {
    const p = state.purchases[index];
    if (!p) return;
    materialInput.value = p["Material Name"] || '';
    indentInput.value = p["Indent No"] || 'Purchase Entry';
    makeInput.value = p["Make"] || '';
    currentEditMakeState.materialName = p["Material Name"] || '';
    if (applyAllCheckbox) {
      applyAllCheckbox.checked = false;
      applyAllCheckbox.disabled = false;
    }
  } else if (type === 'prev') {
    openEditPrevStockModal(index);
    return;
  }
  updateMakeSuggestionsDatalist();
  renderMakeQuickChips(makeInput.value);
  modal.classList.add('active');
  lucide.createIcons();
  setTimeout(() => { if (makeInput) makeInput.focus(); }, 60);
}

// Set or Edit Make / Brand for an entire material in Stock Inventory
function openEditMakeForMaterial(materialName) {
  if (!materialName) return;
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can edit Make / Brand.', 'error');
    return;
  }
  currentEditMakeState = { type: 'material', index: -1, materialName: materialName };
  const modal = document.getElementById('make-modal');
  const materialInput = document.getElementById('make-display-material');
  const indentInput = document.getElementById('make-display-indent');
  const makeInput = document.getElementById('make-input-val');
  const applyAllCheckbox = document.getElementById('make-apply-all-checkbox');

  materialInput.value = materialName;
  indentInput.value = 'Stock Inventory (Applies to all entries)';
  if (applyAllCheckbox) {
    applyAllCheckbox.checked = true;
    applyAllCheckbox.disabled = true;
  }

  // Find existing make if any
  let existingMake = '';
  try {
    const matMakes = JSON.parse(localStorage.getItem('electrastock_material_makes') || '{}');
    if (matMakes[materialName]) {
      existingMake = matMakes[materialName];
    }
  } catch (e) {}

  if (!existingMake) {
    const matchingPurchases = state.purchases.filter(p => p["Material Name"] === materialName && p["Make"]);
    if (matchingPurchases.length > 0) {
      existingMake = matchingPurchases[matchingPurchases.length - 1]["Make"];
    }
  }

  makeInput.value = existingMake || '';
  updateMakeSuggestionsDatalist();
  renderMakeQuickChips(makeInput.value);
  modal.classList.add('active');
  lucide.createIcons();
  setTimeout(() => { if (makeInput) makeInput.focus(); }, 60);
}

function closeEditMakeModal() {
  const modal = document.getElementById('make-modal');
  if (modal) modal.classList.remove('active');
  const applyAllCheckbox = document.getElementById('make-apply-all-checkbox');
  if (applyAllCheckbox) {
    applyAllCheckbox.disabled = false;
    applyAllCheckbox.checked = false;
  }
}

function submitMakeUpdate() {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can edit Make / Brand.', 'error');
    return;
  }
  const newMake = document.getElementById('make-input-val').value.trim();
  const applyAll = document.getElementById('make-apply-all-checkbox')?.checked;
  const { type, index, materialName } = currentEditMakeState;

  if (type === 'material' || applyAll) {
    const mat = materialName || (type === 'purchase' && state.purchases[index] ? state.purchases[index]["Material Name"] : '');
    if (!mat) return;
    const matNorm = mat.toString().trim().toLowerCase();

    // 1. Update in-memory purchases matching material (trimmed / case-insensitive)
    const overrides = JSON.parse(localStorage.getItem('electrastock_make_overrides') || '{}');
    state.purchases.forEach(p => {
      const pMatNorm = (p["Material Name"] || '').toString().trim().toLowerCase();
      if (pMatNorm === matNorm) {
        p["Make"] = newMake;
        const overrideKey = makePurchaseKey(p);
        if (newMake) {
          overrides[overrideKey] = newMake;
        } else {
          delete overrides[overrideKey];
        }
      }
    });
    localStorage.setItem('electrastock_make_overrides', JSON.stringify(overrides));

    // 2. Persist in electrastock_material_makes
    const matMakes = JSON.parse(localStorage.getItem('electrastock_material_makes') || '{}');
    Object.keys(matMakes).forEach(k => {
      if (k.trim().toLowerCase() === matNorm) {
        delete matMakes[k];
      }
    });
    if (newMake) {
      matMakes[mat] = newMake;
    }
    localStorage.setItem('electrastock_material_makes', JSON.stringify(matMakes));

    // 3. Update electrastock_prev_stocks if matching (check both r.name and r.materialName)
    let prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
    let prevUpdated = false;
    prevStocks.forEach(r => {
      const rName = ((r.name || r.materialName) || '').toString().trim().toLowerCase();
      if (rName === matNorm) {
        r.make = newMake;
        prevUpdated = true;
      }
    });
    if (prevUpdated) {
      localStorage.setItem('electrastock_prev_stocks', JSON.stringify(prevStocks));
    }

    // 4. Save purchases to localStorage
    savePurchasesToLocalStorage();

    // 5. Cloud sync if connected
    if (state.appMode === 'cloud') {
      sendMakeUpdateToCloud(mat, newMake);
    }

    showToast(`Make set to "${newMake || 'None'}" for all entries of ${mat}`, 'success');
  } else if (type === 'purchase') {
    const p = state.purchases[index];
    if (p) {
      // 1. Update in-memory state immediately
      p['Make'] = newMake;

      // 2. Persist in the dedicated Make override store
      const overrideKey = makePurchaseKey(p);
      const overrides = JSON.parse(localStorage.getItem('electrastock_make_overrides') || '{}');
      if (newMake) {
        overrides[overrideKey] = newMake;
      } else {
        delete overrides[overrideKey];
      }
      localStorage.setItem('electrastock_make_overrides', JSON.stringify(overrides));

      // 3. If prev-stock synthetic entry, update source record
      if (p['_prevId']) {
        let prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
        const rec = prevStocks.find(r => r.id === p['_prevId']);
        if (rec) {
          rec.make = newMake;
          localStorage.setItem('electrastock_prev_stocks', JSON.stringify(prevStocks));
        }
      } else {
        savePurchasesToLocalStorage();
      }

      // 4. Also record in electrastock_material_makes if material has no make yet
      const mat = (p['Material Name'] || '').toString().trim();
      if (mat && newMake) {
        try {
          const matMakes = JSON.parse(localStorage.getItem('electrastock_material_makes') || '{}');
          if (!matMakes[mat]) {
            matMakes[mat] = newMake;
            localStorage.setItem('electrastock_material_makes', JSON.stringify(matMakes));
          }
        } catch (e) {}
      }

      // 5. Cloud sync if connected
      if (state.appMode === 'cloud') {
        sendMakeUpdateToCloud(p['Material Name'], newMake, p['Indent No']);
      }

      showToast(`Make updated to "${newMake || 'None'}" for ${p['Material Name']}`, 'success');
    }
  }

  closeEditMakeModal();
  updateUI();

  // Refresh active modals or views if open
  if (currentViewerContext && currentViewerContext.type === 'indent') {
    openIndentInvoiceViewerModal(currentViewerContext.indentNo);
  }
  const matDetailModal = document.getElementById('material-detail-modal');
  const activeMat = materialName || (state.purchases[index] ? state.purchases[index]["Material Name"] : '');
  if (matDetailModal && matDetailModal.classList.contains('active') && activeMat) {
    openMaterialDetailModal(activeMat);
  }
  
  // Refresh current indent materials table on dashboard
  const selIndent = document.getElementById('dashboard-indent-lookup-select');
  if (selIndent && selIndent.value) {
    renderIndentLookupResult(selIndent.value);
  }
}

// ─────────────────────────────────────────────────────────────────
// Material 360° Traceability, Search & Indent Split Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Extract all indents where a material was purchased with quantities, dates & rates
 * @param {string} materialName
 * @returns {Array<Object>}
 */
function getMaterialIndentSplits(materialName) {
  if (!materialName) return [];
  const purchases = state.purchases.filter(p => p["Material Name"] === materialName);
  const indentMap = new Map();

  purchases.forEach(p => {
    const indent = (p["Indent No"] || 'PREV-STOCK').toString().trim() || 'PREV-STOCK';
    if (!indentMap.has(indent)) {
      indentMap.set(indent, {
        indentNo: indent,
        qty: 0,
        amount: 0,
        dates: new Set(),
        sources: new Set(),
        makes: new Set(),
        rates: new Set(),
        hasDoc: false
      });
    }
    const rec = indentMap.get(indent);
    rec.qty += Number(p["Quantity"]) || 0;
    rec.amount += Number(p["Amount"]) || 0;
    if (p["Received Date"]) rec.dates.add(p["Received Date"]);
    if (p["Source"]) rec.sources.add(p["Source"]);
    if (p["Make"] && p["Make"].toString().trim()) rec.makes.add(p["Make"].toString().trim());
    if (p["Rate"]) rec.rates.add(Number(p["Rate"]));
    if (getEffectiveItemPoLink(p)) rec.hasDoc = true;
  });

  return [...indentMap.values()];
}

/**
 * Render professional Quantity Split HTML as per Indent No.
 * Handles both single indent and multiple indent scenarios with explicit sum formula.
 * @param {string} materialName
 * @param {string} unit
 * @returns {string}
 */
function renderMaterialIndentSplitHtml(materialName, unit = '') {
  const splits = getMaterialIndentSplits(materialName);
  if (splits.length === 0) return '<span class="kpi-subtext">—</span>';

  const totalQty = splits.reduce((sum, s) => sum + s.qty, 0);

  if (splits.length === 1) {
    const s = splits[0];
    const dateStr = [...s.dates].join(', ');
    const sourceStr = [...s.sources].join(', ');
    return `
      <div class="indent-split-box single-indent" style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 8px; padding: 8px 12px; margin-top: 6px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
          <span style="font-size: 0.82rem; color: #6ee7b7; font-weight: 600; display: flex; align-items: center; gap: 5px;">
            <i data-lucide="file-text" style="width: 13px; height: 13px;"></i>
            Indent: <code style="color: #34d399; font-size: 0.85rem; font-family: monospace;">${escapeHtml(s.indentNo)}</code>
          </span>
          <span style="font-size: 0.85rem; font-weight: 700; color: var(--text-primary);">${s.qty} <span style="font-size: 0.74rem; font-weight: 400; color: var(--text-muted);">${escapeHtml(unit)}</span> (100%)</span>
        </div>
        ${(dateStr || sourceStr) ? `<div style="font-size: 0.73rem; color: var(--text-muted); margin-top: 3px;">${dateStr ? `Date: ${dateStr}` : ''} ${sourceStr ? `&bull; Source: ${sourceStr}` : ''}</div>` : ''}
      </div>
    `;
  }

  // Multiple indents! Show professional split sum:
  const splitPills = splits.map(s => {
    const pct = totalQty > 0 ? Math.round((s.qty / totalQty) * 100) : 0;
    const dateStr = [...s.dates].join(', ');
    const sourceStr = [...s.sources].join(', ');
    return `
      <div class="indent-split-chip" style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 8px; padding: 7px 12px; flex: 1; min-width: 190px;">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <span style="font-size: 0.8rem; font-weight: 700; color: #a5b4fc; font-family: monospace;">
            <i data-lucide="file-check" style="width: 12px; height: 12px; margin-right: 3px;"></i>${escapeHtml(s.indentNo)}
          </span>
          <strong style="color: #34d399; font-size: 0.88rem;">${s.qty} <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;">${escapeHtml(unit)}</span></strong>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 0.72rem; color: var(--text-muted);">
          <span>${sourceStr || 'GEM'} &bull; ${dateStr || '—'}</span>
          <span class="mode-badge cloud" style="font-size: 0.65rem; padding: 1px 6px;">${pct}%</span>
        </div>
      </div>
    `;
  }).join('');

  const formulaText = splits.map(s => `<strong>${s.qty}</strong> (${escapeHtml(s.indentNo)})`).join(' + ');

  return `
    <div class="indent-split-box multi-indent" style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(15, 23, 42, 0.6)); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 10px; padding: 10px 14px; margin-top: 6px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px;">
        <span style="font-size: 0.82rem; font-weight: 700; color: #818cf8; display: flex; align-items: center; gap: 6px;">
          <i data-lucide="split" style="width: 14px; height: 14px;"></i>
          Quantity Split as per Indent No. (${splits.length} Indents)
        </span>
        <span style="font-size: 0.85rem; font-weight: 800; color: var(--text-primary); background: rgba(99, 102, 241, 0.2); padding: 2px 8px; border-radius: 6px;">
          Total: ${totalQty} ${escapeHtml(unit)}
        </span>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px;">
        ${splitPills}
      </div>
      <div style="font-size: 0.75rem; color: var(--text-muted); border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 5px;">
        <span style="color: #a5b4fc; font-weight: 600;">Sum Split:</span> ${formulaText} = <strong style="color: var(--success); font-size: 0.82rem;">${totalQty} ${escapeHtml(unit)}</strong>
      </div>
    </div>
  `;
}

/**
 * Setup Home Screen Real-Time Material Search Option
 * Allows users to search any material name and immediately inspect its available stock,
 * status, originating indents, and where used locations without searching through indents.
 * @param {Object} inventory
 */
function setupDashboardMaterialSearch(inventory) {
  const searchInput = document.getElementById('dashboard-material-search-input');
  const clearBtn = document.getElementById('dashboard-material-search-clear');
  const resultsBox = document.getElementById('dashboard-material-search-results');
  if (!searchInput || !resultsBox) return;

  const handleSearch = () => {
    const q = searchInput.value.trim().toLowerCase();
    if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
    if (!q) {
      resultsBox.style.display = 'none';
      resultsBox.innerHTML = '';
      return;
    }
    renderDashboardMaterialSearchResults(q, inventory);
  };

  searchInput.oninput = handleSearch;

  if (clearBtn) {
    clearBtn.onclick = () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      resultsBox.style.display = 'none';
      resultsBox.innerHTML = '';
      searchInput.focus();
    };
  }

  // Refresh results if an active query exists
  if (searchInput.value.trim()) {
    handleSearch();
  }
}

/**
 * Render Matched Materials Search Results on Dashboard
 * @param {string} query
 * @param {Object} inventory
 */
function renderDashboardMaterialSearchResults(query, inventory) {
  const resultsBox = document.getElementById('dashboard-material-search-results');
  if (!resultsBox) return;

  const items = Object.values(inventory).filter(item => {
    const nameMatch = item.name.toLowerCase().includes(query);
    const catMatch = (item.category || '').toLowerCase().includes(query);
    const makeMatch = item.makes && [...item.makes].some(m => m.toLowerCase().includes(query));
    const splits = getMaterialIndentSplits(item.name);
    const indentMatch = splits.some(s => s.indentNo.toLowerCase().includes(query));
    return nameMatch || catMatch || makeMatch || indentMatch;
  });

  if (items.length === 0) {
    resultsBox.style.display = 'block';
    resultsBox.innerHTML = `
      <div style="padding: 18px; text-align: center; color: var(--text-muted); background: rgba(15, 23, 42, 0.65); border-radius: 8px; border: 1px dashed var(--border-color);">
        <i data-lucide="search-x" style="width: 24px; height: 24px; margin-bottom: 4px; opacity: 0.6;"></i>
        <p style="margin: 0; font-size: 0.88rem;">No materials matched "<strong>${escapeHtml(query)}</strong>". Try searching by keyword like <code>flood</code>, <code>batten</code>, <code>wire</code>, <code>MCB</code>, or an indent number.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const resultsHtml = items.map(item => {
    let statusClass = 'in-stock', statusText = 'In Stock (Healthy)';
    if (item.status === 'out-of-stock') { statusClass = 'out-of-stock'; statusText = 'Out of Stock'; }
    else if (item.status === 'low-stock') { statusClass = 'low-stock'; statusText = 'Low Stock Alert'; }

    const makesList = item.makes && item.makes.size > 0 ? [...item.makes].join(', ') : '';
    const roundedAvail = Math.round(item.available * 100) / 100;
    const availColor = item.available > 0 ? 'var(--success)' : 'var(--danger)';

    // Usages breakdown summary
    const usages = state.usages.filter(u => u["Material Name"] === item.name);
    const locationMap = {};
    usages.forEach(u => {
      const loc = u["Where Used"] || 'Unspecified';
      const q = Number(u["Quantity"]) || 0;
      locationMap[loc] = (locationMap[loc] || 0) + q;
    });
    const locationEntries = Object.entries(locationMap);
    const locationSummaryHtml = locationEntries.length === 0
      ? `<span class="kpi-subtext" style="font-size: 0.75rem;">No usage recorded yet</span>`
      : locationEntries.slice(0, 3).map(([loc, q]) => `
          <span style="background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.25); padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; color: #c7d2fe; display: inline-flex; align-items: center; gap: 4px;">
            <i data-lucide="map-pin" style="width: 10px; height: 10px; color: #818cf8;"></i>${escapeHtml(loc)}: <strong style="color: #f87171;">${q} ${escapeHtml(item.unit)}</strong>
          </span>
        `).join(' ') + (locationEntries.length > 3 ? `<span class="kpi-subtext" style="font-size: 0.72rem;"> +${locationEntries.length - 3} more</span>` : '');

    // Professional Indent Split
    const indentSplitHtml = renderMaterialIndentSplitHtml(item.name, item.unit);

    const makesDisplay = makesList
      ? `<button type="button" class="make-badge clickable btn-search-edit-make" data-material="${escapeHtml(item.name)}" title="Click to edit Make / Brand for ${escapeHtml(item.name)}" style="border:none; cursor:pointer; font-size: 0.72rem;">Make: ${escapeHtml(makesList)} <i data-lucide="edit-2" style="width:10px;height:10px;margin-left:3px;opacity:0.75;"></i></button>`
      : `<button type="button" class="btn btn-secondary btn-search-edit-make" data-material="${escapeHtml(item.name)}" title="Set Make / Brand for ${escapeHtml(item.name)}" style="padding: 2px 7px; font-size: 0.7rem; border: 1px dashed rgba(99,102,241,0.35); color: #a5b4fc; background: rgba(99,102,241,0.08); border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; width: auto;"><i data-lucide="tag" style="width: 10px; height: 10px;"></i> + Set Make</button>`;

    return `
      <div class="mat-search-result-card" data-material="${escapeHtml(item.name)}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 8px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <strong style="font-size: 1rem; color: var(--text-primary); cursor: pointer;" class="btn-search-inspect-mat" data-material="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
              <span class="status-badge ${statusClass}" style="font-size: 0.7rem; padding: 2px 8px;">${statusText}</span>
              ${makesDisplay}
              <span style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">Category: ${escapeHtml(item.category)}</span>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="text-align: right;">
              <span class="kpi-subtext" style="font-size: 0.72rem; display: block;">Available Stock:</span>
              <strong style="font-size: 1.2rem; color: ${availColor}; font-weight: 800;">${roundedAvail}</strong>
              <span style="font-size: 0.76rem; color: var(--text-muted); font-weight: normal;">${escapeHtml(item.unit)}</span>
            </div>
            <button type="button" class="btn btn-secondary btn-search-inspect-mat" data-material="${escapeHtml(item.name)}" style="padding: 5px 12px; font-size: 0.78rem; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px; width: auto; color: #a5b4fc; border-color: rgba(99, 102, 241, 0.4);" title="Inspect complete traceability and audit logs">
              <i data-lucide="eye" style="width: 13px; height: 13px;"></i> Full Details
            </button>
          </div>
        </div>

        <!-- Quantity Split as per Indent No. -->
        <div style="margin-top: 6px;">
          ${indentSplitHtml}
        </div>

        <!-- Where Used Quick Summary -->
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255, 255, 255, 0.08); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span class="kpi-subtext" style="font-size: 0.74rem; font-weight: 600;">Where Used:</span>
          ${locationSummaryHtml}
        </div>
      </div>
    `;
  }).join('');

  resultsBox.style.display = 'block';
  resultsBox.innerHTML = `
    <div style="margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
      <span style="font-size: 0.78rem; font-weight: 700; color: #818cf8; text-transform: uppercase; letter-spacing: 0.5px;">
        Matched Materials (${items.length})
      </span>
      <span class="kpi-subtext" style="font-size: 0.72rem;">Click "Full Details" to inspect 360° traceability &amp; audit records</span>
    </div>
    ${resultsHtml}
  `;

  resultsBox.querySelectorAll('.btn-search-inspect-mat').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const mat = el.getAttribute('data-material');
      if (mat) openMaterialDetailModal(mat);
    };
  });

  resultsBox.querySelectorAll('.btn-search-edit-make').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const mat = btn.getAttribute('data-material');
      if (mat) openEditMakeForMaterial(mat);
    };
  });

  lucide.createIcons();
}

/** Compatibility Stubs for legacy references */
function renderDashboardAvailableMaterials(inventory, selectedMaterialName = '') {}
function setupDashboardQuickLookup(inventory) {
  setupDashboardMaterialSearch(inventory);
}
function renderDashboardMaterialLookupResult(materialName, inventory) {
  if (materialName) openMaterialDetailModal(materialName);
}

// ─────────────────────────────────────────────────────────────────
// Indent No & Materials List Master-Detail Widget
// ─────────────────────────────────────────────────────────────────

/**
 * Render quick indent selector pills (horizontal bar) on the dashboard.
 * Uses a sleek 1-click horizontal pill selector so the materials table has 100% full screen width.
 * @param {string} selectedIndentNo
 */
function renderDashboardAvailableIndents(selectedIndentNo = '') {
  const pillsBar = document.getElementById('dashboard-indent-pills-bar');
  const legacyContainer = document.getElementById('dashboard-available-indents-section');
  if (!pillsBar && !legacyContainer) return;

  const indentMap = new Map();
  state.purchases.forEach(p => {
    const indent = (p['Indent No'] || '').toString().trim();
    if (!indent || indent === 'PREV-STOCK') return;
    if (!indentMap.has(indent)) {
      indentMap.set(indent, {
        indentNo: indent,
        date: p['Received Date'] || '',
        source: p['Source'] || '',
        count: 0,
        totalAmount: 0,
        rows: []
      });
    }
    const meta = indentMap.get(indent);
    meta.count++;
    meta.totalAmount += Number(p['Amount']) || 0;
    meta.rows.push(p);
  });

  const indents = [...indentMap.values()].sort((a, b) => a.indentNo.localeCompare(b.indentNo));

  // Determine active indent
  const activeIndent = selectedIndentNo || (indents.length > 0 ? indents[0].indentNo : '');

  if (pillsBar) {
    if (indents.length === 0) {
      pillsBar.innerHTML = '';
    } else {
      pillsBar.innerHTML = indents.map(meta => {
        const isSelected = activeIndent && meta.indentNo === activeIndent;
        return `
          <button type="button" class="indent-pill-btn ${isSelected ? 'active' : ''}" data-indent="${escapeHtml(meta.indentNo)}" title="View materials in Indent ${escapeHtml(meta.indentNo)}">
            <i data-lucide="file-spreadsheet" style="width: 14px; height: 14px; color: ${isSelected ? '#34d399' : 'var(--text-muted)'};"></i>
            <span style="font-weight: 700; font-family: monospace;">${escapeHtml(meta.indentNo)}</span>
            <span style="font-size: 0.72rem; padding: 1px 6px; border-radius: 10px; background: rgba(255, 255, 255, 0.08); color: var(--text-secondary);">${meta.count} item${meta.count !== 1 ? 's' : ''}</span>
            <span style="font-size: 0.7rem; color: #a5b4fc;">${escapeHtml(meta.source || '')}</span>
          </button>
        `;
      }).join('');

      pillsBar.querySelectorAll('.indent-pill-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const indent = btn.getAttribute('data-indent');
          if (indent) {
            const sel = document.getElementById('dashboard-indent-lookup-select');
            if (sel) sel.value = indent;
            renderIndentLookupResult(indent);
            renderDashboardAvailableIndents(indent);
          }
        });
      });
    }
  }

  if (legacyContainer) {
    legacyContainer.innerHTML = '';
    legacyContainer.style.display = 'none';
  }

  lucide.createIcons();
}

/** Populate the Indent No. dropdown and wire up the change handler */
function setupIndentLookup() {
  const select = document.getElementById('dashboard-indent-lookup-select');
  if (!select) return;

  // Collect all unique indent nos from purchases (exclude blank / PREV-STOCK)
  const indentSet = new Map(); // indentNo -> { date, source, count }
  state.purchases.forEach(p => {
    const indent = (p['Indent No'] || '').toString().trim();
    if (!indent || indent === 'PREV-STOCK') return;
    if (!indentSet.has(indent)) {
      indentSet.set(indent, {
        date: p['Received Date'] || '',
        source: p['Source'] || '',
        count: 0
      });
    }
    indentSet.get(indent).count++;
  });

  const currentVal = select.value;

  // Rebuild option list
  select.innerHTML = '<option value="" disabled selected>Select an Indent No. to view materials...</option>';

  // Sort alphabetically
  const sorted = [...indentSet.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  sorted.forEach(([indent, meta]) => {
    const opt = document.createElement('option');
    opt.value = indent;
    opt.textContent = `${indent} (${meta.count} item${meta.count !== 1 ? 's' : ''} · ${meta.source})`;
    select.appendChild(opt);
  });

  // Determine active indent
  let activeIndent = '';
  if (currentVal && [...select.options].some(o => o.value === currentVal)) {
    activeIndent = currentVal;
    select.value = currentVal;
  } else if (sorted.length > 0) {
    activeIndent = sorted[0][0];
    select.value = activeIndent;
  }

  if (activeIndent) {
    renderIndentLookupResult(activeIndent);
    renderDashboardAvailableIndents(activeIndent);
  } else {
    renderDashboardAvailableIndents('');
  }

  select.onchange = (e) => {
    const val = e.target.value;
    if (val) {
      renderIndentLookupResult(val);
      renderDashboardAvailableIndents(val);
    }
  };
}

/** Render all items purchased under a given Indent No. */
/** Get the effective PO/Invoice link for a specific purchase item (item-level first, then indent document) */
function getEffectiveItemPoLink(p) {
  if (!p) return '';
  const myMat = (p["Material Name"] || p.name || '').toString().trim().toLowerCase();
  const indentNo = (p["Indent No"] || p.indentNo || '').toString().trim();
  const cleanIndent = indentNo.toLowerCase();
  const key = makePurchaseKey(p);
  const indentKey = 'indent_' + indentNo;
  const cleanIndentKey = 'indent_' + cleanIndent;

  // 1. Local overrides ALWAYS take top precedence (allows immediate deletion and prevents cache resurrection)
  try {
    const overrides = JSON.parse(localStorage.getItem('electrastock_invoice_overrides') || '{}');
    if (overrides[key] === '__DELETED__' || overrides[indentKey] === '__DELETED__' || overrides[cleanIndentKey] === '__DELETED__') {
      return '';
    }
    if (overrides[key]) {
      return overrides[key];
    }
    if (indentNo && (overrides[indentKey] || overrides[cleanIndentKey])) {
      const indentOverride = overrides[indentKey] || overrides[cleanIndentKey];
      if (indentOverride !== '__DELETED__' && !indentOverride.includes('||')) {
        return indentOverride;
      }
    }
  } catch (e) {}

  const direct = (p["PO Link"] || p["poLink"] || p["fileUrl"] || '').toString().trim();

  // 2. Direct web link (Google Drive / Cloud URL from Google Sheet)
  if (direct && (direct.startsWith('http://') || direct.startsWith('https://'))) {
    return direct;
  }

  // 3. Direct data URL (in-memory base64)
  if (direct && direct.startsWith('data:')) {
    return direct;
  }

  // 4. Direct IDB pointer (ensure it belongs to this item)
  if (direct && direct.startsWith('idb:')) {
    const rawKey = direct.replace('idb:', '');
    if (rawKey.includes('||')) {
      const parts = rawKey.split('||');
      const keyMat = (parts[1] || '').trim().toLowerCase();
      if (myMat && keyMat && keyMat !== myMat) {
        // Document belongs to a different item, ignore it
      } else {
        return direct;
      }
    } else {
      return direct;
    }
  }

  // 5. Fallback to shared Indent document from other items of the same indent
  if (indentNo) {
    const indentDoc = findIndentPoLink(indentNo);
    if (indentDoc) return indentDoc;
  }

  return '';
}

/** Delete / remove an item's PO or Invoice document (removes from Sheet & trashes from Drive) */
async function deleteItemInvoice(p) {
  if (!p) return;
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can delete invoices.', 'error');
    return;
  }
  const matName = p["Material Name"] || p.name || 'this item';
  const indentNo = (p["Indent No"] || p.indentNo || '').toString().trim();
  const currentDocLink = getEffectiveItemPoLink(p);

  if (!confirm(`Delete the attached PO / Invoice for "${matName}"${indentNo ? ` (Indent: ${indentNo})` : ''}?\n\nThis will remove the file from Google Drive and unlink it across all PCs.`)) {
    return;
  }

  setSyncingAnimation(true);
  const key = makePurchaseKey(p);
  const cleanIndent = indentNo.toLowerCase();
  const indentKey = 'indent_' + indentNo;
  const cleanIndentKey = 'indent_' + cleanIndent;

  // 1. Mark in local overrides as __DELETED__ so it is NEVER restored by stale sync or cache
  let overrides = {};
  try {
    overrides = JSON.parse(localStorage.getItem('electrastock_invoice_overrides') || '{}');
  } catch(e) {}

  overrides[key] = '__DELETED__';
  await InvoiceStorage.deleteInvoice(key);

  // Clear in-memory record
  p["PO Link"] = '';
  p["poLink"] = '';
  p["fileUrl"] = '';

  // Check if other rows in the same indent share this EXACT document link (or if it was an indent-shared document)
  let isEntireIndentDeleted = false;
  if (cleanIndent) {
    const matchingRows = state.purchases.filter(otherP =>
      (otherP["Indent No"] || otherP.indentNo || '').toString().trim().toLowerCase() === cleanIndent
    );

    const hasIndentOverride = (overrides[indentKey] && overrides[indentKey] !== '__DELETED__') ||
                              (overrides[cleanIndentKey] && overrides[cleanIndentKey] !== '__DELETED__');

    if (hasIndentOverride || matchingRows.every(r => {
      const rLink = (r["PO Link"] || r.poLink || r.fileUrl || '').toString().trim();
      return !rLink || rLink === currentDocLink;
    })) {
      // Clear for ALL items in this indent because it is a shared indent document
      isEntireIndentDeleted = true;
      overrides[indentKey] = '__DELETED__';
      overrides[cleanIndentKey] = '__DELETED__';
      await InvoiceStorage.deleteInvoice(indentKey);
      await InvoiceStorage.deleteInvoice(cleanIndentKey);

      matchingRows.forEach(otherP => {
        otherP["PO Link"] = '';
        otherP["poLink"] = '';
        otherP["fileUrl"] = '';
        const otherKey = makePurchaseKey(otherP);
        overrides[otherKey] = '__DELETED__';
        InvoiceStorage.deleteInvoice(otherKey);
      });
    }
  }

  try {
    localStorage.setItem('electrastock_invoice_overrides', JSON.stringify(overrides));
  } catch(e) {}

  savePurchasesToLocalStorage();

  // 2. Immediately update the UI so the PO disappears right now
  updateUI();
  const indentSelect = document.getElementById('dashboard-indent-lookup-select');
  if (indentSelect && indentSelect.value === indentNo) {
    renderIndentLookupResult(indentNo);
  }
  const invoiceModal = document.getElementById('invoice-viewer-modal');
  if (invoiceModal && invoiceModal.classList.contains('active')) {
    closeInvoiceViewerModal();
  }

  // 3. Cloud delete (Google Sheet & Google Drive trash) with guaranteed GET primary execution
  if (state.appMode === 'cloud' && state.sheetUrl) {
    try {
      const query = new URLSearchParams({
        action: 'deleteInvoice',
        indentNo: indentNo,
        materialName: isEntireIndentDeleted ? '' : matName,
        deleteAllForIndent: isEntireIndentDeleted ? 'true' : 'false',
        fileUrl: currentDocLink || '',
        _t: Date.now().toString()
      });
      await fetch(`${state.sheetUrl}?${query.toString()}`, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-cache',
        redirect: 'follow'
      });

      // Also send POST as secondary assurance
      const payload = {
        action: 'deleteInvoice',
        indentNo: indentNo,
        materialName: isEntireIndentDeleted ? '' : matName,
        deleteAllForIndent: isEntireIndentDeleted,
        fileUrl: currentDocLink || ''
      };
      fetch(state.sheetUrl, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      }).catch(e => console.warn('Secondary POST delete warning:', e));

      await syncWithCloud();
      setSyncingAnimation(false);
      showToast(`PO / Invoice deleted and unlinked across all PCs & mobiles!`, 'success');
    } catch(err) {
      console.warn('Cloud delete error:', err);
      await syncWithCloud();
      setSyncingAnimation(false);
      showToast(`Invoice removed for "${matName}".`, 'info');
    }
  } else {
    setSyncingAnimation(false);
    showToast(`Invoice removed locally for "${matName}".`, 'success');
  }

  // 4. Final UI and Lookup re-render
  updateUI();
  if (indentSelect && indentSelect.value === indentNo) {
    renderIndentLookupResult(indentNo);
  }
}

/** Delete entire Indent PO / Invoice document across all items (removes from Sheet & trashes from Drive) */
async function deleteIndentInvoice(indentNo) {
  if (!indentNo) return;
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can delete invoices.', 'error');
    return;
  }

  const cleanIndent = indentNo.toString().trim().toLowerCase();
  const rows = state.purchases.filter(p =>
    (p['Indent No'] || p.indentNo || '').toString().trim().toLowerCase() === cleanIndent
  );
  const currentDocLink = findIndentPoLink(indentNo, rows);

  if (!confirm(`Delete the PO / Invoice document attached to Indent "${indentNo}"?\n\nThis will remove the invoice document from all ${rows.length} item(s) in this indent, delete the file from Google Drive, and update all connected PCs & mobiles.`)) {
    return;
  }

  setSyncingAnimation(true);
  const indentKey = 'indent_' + indentNo;
  const cleanIndentKey = 'indent_' + cleanIndent;

  // 1. Mark overrides as __DELETED__ so it is NEVER restored by stale sync
  let overrides = {};
  try {
    overrides = JSON.parse(localStorage.getItem('electrastock_invoice_overrides') || '{}');
  } catch(e) {}

  overrides[indentKey] = '__DELETED__';
  overrides[cleanIndentKey] = '__DELETED__';
  await InvoiceStorage.deleteInvoice(indentKey);
  await InvoiceStorage.deleteInvoice(cleanIndentKey);

  rows.forEach(p => {
    p["PO Link"] = '';
    p["poLink"] = '';
    p["fileUrl"] = '';
    const key = makePurchaseKey(p);
    overrides[key] = '__DELETED__';
    InvoiceStorage.deleteInvoice(key);
  });

  try {
    localStorage.setItem('electrastock_invoice_overrides', JSON.stringify(overrides));
  } catch(e) {}

  savePurchasesToLocalStorage();

  // 2. Immediately update the UI
  updateUI();
  const indentSelect = document.getElementById('dashboard-indent-lookup-select');
  if (indentSelect && indentSelect.value === indentNo) {
    renderIndentLookupResult(indentNo);
  }
  closeInvoiceViewerModal();

  // 3. Cloud delete (Google Sheet & Google Drive trash) with guaranteed GET primary execution
  if (state.appMode === 'cloud' && state.sheetUrl) {
    try {
      const query = new URLSearchParams({
        action: 'deleteInvoice',
        indentNo: indentNo,
        materialName: '',
        deleteAllForIndent: 'true',
        fileUrl: currentDocLink || '',
        _t: Date.now().toString()
      });
      await fetch(`${state.sheetUrl}?${query.toString()}`, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-cache',
        redirect: 'follow'
      });

      // Secondary: also send POST
      const payload = {
        action: 'deleteInvoice',
        indentNo: indentNo,
        materialName: '',
        deleteAllForIndent: true,
        fileUrl: currentDocLink || ''
      };
      fetch(state.sheetUrl, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      }).catch(e => console.warn('Secondary indent POST delete warning:', e));

      await syncWithCloud();
      setSyncingAnimation(false);
      showToast(`PO / Invoice for Indent ${indentNo} deleted across all PCs & mobiles!`, 'success');
    } catch(err) {
      console.warn('Cloud delete indent error:', err);
      await syncWithCloud();
      setSyncingAnimation(false);
      showToast(`Invoice unlinked for Indent ${indentNo}.`, 'info');
    }
  } else {
    setSyncingAnimation(false);
    showToast(`Invoice unlinked locally for Indent ${indentNo}.`, 'success');
  }

  // 4. Final UI update
  updateUI();
  if (indentSelect && indentSelect.value === indentNo) {
    renderIndentLookupResult(indentNo);
  }
}

/** Find PO/Invoice document link for an Indent (checks items' PO links from Google Sheets first, then local overrides) */
function findIndentPoLink(indentNo, rows = null) {
  if (!indentNo) return '';
  const cleanIndent = indentNo.toString().trim().toLowerCase();
  const indentKey = 'indent_' + indentNo;
  const cleanIndentKey = 'indent_' + cleanIndent;

  // 1. Check local overrides FIRST! If explicitly deleted, NEVER return a link
  let overrides = {};
  try {
    overrides = JSON.parse(localStorage.getItem('electrastock_invoice_overrides') || '{}');
    if (overrides[indentKey] === '__DELETED__' || overrides[cleanIndentKey] === '__DELETED__') {
      return '';
    }
  } catch (e) {}

  // 2. Check candidate rows in state.purchases (skipping explicitly deleted rows)
  const candidateRows = (rows && rows.length) ? rows : state.purchases.filter(p =>
    (p['Indent No'] || p.indentNo || '').toString().trim().toLowerCase() === cleanIndent
  );

  if (candidateRows && candidateRows.length) {
    for (let i = 0; i < candidateRows.length; i++) {
      const p = candidateRows[i];
      const pKey = makePurchaseKey(p);
      if (overrides[pKey] === '__DELETED__') continue;

      const link = (p['PO Link'] || p['poLink'] || p['fileUrl'] || '').toString().trim();
      if (link && (link.startsWith('http://') || link.startsWith('https://'))) {
        return link;
      }
    }
  }

  // In cloud mode: If Google Sheets data for this indent has no PO document,
  // do NOT resurrect an old cloud URL from local overrides!
  if (state.appMode === 'cloud') {
    return '';
  }

  // 3. In local demo mode only, check local overrides or IDB
  try {
    const indentVal = overrides[indentKey] || overrides[cleanIndentKey];
    if (indentVal && typeof indentVal === 'string' && indentVal.trim() && !indentVal.includes('||') && indentVal !== '__DELETED__') {
      return indentVal.trim();
    }
  } catch (e) {}

  if (candidateRows && candidateRows.length) {
    for (let i = 0; i < candidateRows.length; i++) {
      const p = candidateRows[i];
      const pKey = makePurchaseKey(p);
      if (overrides[pKey] === '__DELETED__') continue;

      const link = (p['PO Link'] || p['poLink'] || p['fileUrl'] || '').toString().trim();
      if (link && link.startsWith('idb:')) {
        return link;
      }
    }
  }

  return '';
}

/**
 * Render all materials purchased under a given Indent No.
 * Displays material names, makes, quantities, available stock in inventory,
 * stock status badges, rates, amounts, and actions.
 * @param {string} indentNo
 */
function renderIndentLookupResult(indentNo) {
  const result = document.getElementById('dashboard-indent-lookup-result');
  if (!result) return;

  if (!indentNo) {
    result.innerHTML = `
      <div style="padding: 32px; text-align: center; color: var(--text-muted); background: rgba(15, 23, 42, 0.45); border-radius: 10px; border: 1px dashed var(--border-color);">
        <i data-lucide="file-spreadsheet" style="width: 32px; height: 32px; margin-bottom: 8px; opacity: 0.5;"></i>
        <p style="margin: 0; font-size: 0.92rem; font-weight: 600; color: var(--text-secondary);">Select an Indent to View Materials</p>
        <p class="kpi-subtext" style="margin-top: 4px; font-size: 0.8rem;">Click any indent on the left or choose from the dropdown above to inspect all materials purchased under it.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  // Find all purchase rows matching this indent
  const rows = state.purchases.filter(p =>
    (p['Indent No'] || '').toString().trim() === indentNo.toString().trim()
  );

  if (rows.length === 0) {
    result.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--text-muted); background: rgba(15, 23, 42, 0.45); border-radius: 10px; border: 1px dashed var(--border-color);">
        <p style="margin: 0; font-size: 0.88rem;">No materials recorded under Indent "<strong>${escapeHtml(indentNo)}</strong>".</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  // Sort by date descending
  rows.sort((a, b) => parseDate(b['Received Date']) - parseDate(a['Received Date']));

  // Compute summary
  const totalItems = rows.length;
  const grandTotal = rows.reduce((sum, p) => sum + (Number(p['Amount']) || 0), 0);
  const receivedDate = rows[0]['Received Date'] || '—';
  const source = rows[0]['Source'] || '—';
  const isAdmin = state.currentUser !== 'staff';

  // Check for Invoice link in this indent
  const itemsWithDocs = rows.filter(p => !!getEffectiveItemPoLink(p));
  const indentPoLink = findIndentPoLink(indentNo, rows);
  const hasAnyDoc = itemsWithDocs.length > 0 || !!indentPoLink;
  const docCount = itemsWithDocs.length;

  // Indent PO / Invoice card HTML
  const indentDocCardHtml = hasAnyDoc
    ? `
      <div class="indent-po-card" style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(15, 23, 42, 0.7)); border: 1px solid rgba(99, 102, 241, 0.35); border-radius: 12px; padding: 12px 18px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 38px; height: 38px; border-radius: 10px; background: rgba(99, 102, 241, 0.2); display: flex; align-items: center; justify-content: center; color: #818cf8; flex-shrink: 0; box-shadow: 0 0 12px rgba(99, 102, 241, 0.3);">
            <i data-lucide="file-check" style="width: 20px; height: 20px;"></i>
          </div>
          <div>
            <div style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
              <span>Official PO / Invoice Document Attached</span>
              <span class="mode-badge cloud" style="font-size: 0.68rem; padding: 2px 8px; font-weight: 600;">Linked</span>
            </div>
            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">
              Document attached to Indent <strong>${escapeHtml(indentNo)}</strong> (${totalItems} items${docCount > 0 ? ` &bull; ${docCount} item documents` : ''})
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button type="button" class="btn btn-secondary" id="btn-view-indent-doc" style="width: auto; padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; color: #818cf8; border-color: rgba(99,102,241,0.35); background: rgba(99,102,241,0.12);">
            <i data-lucide="eye" style="width: 14px; height: 14px;"></i> View Document
          </button>
          ${isAdmin ? `
          <button type="button" class="btn btn-secondary" id="btn-upload-indent-doc" style="width: auto; padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; color: #a5b4fc; border-color: rgba(99,102,241,0.3);">
            <i data-lucide="upload-cloud" style="width: 14px; height: 14px;"></i> Reupload
          </button>
          <button type="button" class="btn btn-secondary" id="btn-delete-indent-doc" style="width: auto; padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; color: var(--danger); border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.08);">
            <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Delete
          </button>` : ''}
        </div>
      </div>
    `
    : `
      <div class="indent-po-card" style="background: linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(15, 23, 42, 0.7)); border: 1px dashed rgba(245, 158, 11, 0.4); border-radius: 12px; padding: 12px 18px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="width: 38px; height: 38px; border-radius: 10px; background: rgba(245, 158, 11, 0.15); display: flex; align-items: center; justify-content: center; color: #fbbf24; flex-shrink: 0;">
            <i data-lucide="file-plus" style="width: 20px; height: 20px;"></i>
          </div>
          <div>
            <div style="font-weight: 700; font-size: 0.95rem; color: #fbbf24;">No PO / Invoice Document Attached</div>
            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">
              ${isAdmin ? `Attach the official purchase order or supplier invoice (.pdf, .jpg, .png) for Indent <strong>${escapeHtml(indentNo)}</strong>` : `No official purchase order or supplier invoice attached for Indent <strong>${escapeHtml(indentNo)}</strong>`}
            </div>
          </div>
        </div>
        ${isAdmin ? `<button type="button" class="btn btn-primary" id="btn-upload-indent-doc" style="width: auto; padding: 6px 16px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 6px; background: linear-gradient(135deg, #f59e0b, #d97706); border: none; font-weight: 600; box-shadow: 0 4px 14px rgba(245, 158, 11, 0.3);">
          <i data-lucide="upload-cloud" style="width: 15px; height: 15px;"></i> Attach Invoice
        </button>` : ''}
      </div>
    `;

  // Get current inventory state to display available quantities for each material
  const inventory = calculateInventory();

  const tableRows = rows.map((p, idx) => {
    const matName = p['Material Name'] || '';
    const makeVal = p['Make'] ? p['Make'].toString().trim() : '';
    const realIndex = state.purchases.indexOf(p);
    const makeDisplay = makeVal
      ? (isAdmin
          ? `<button type="button" class="make-badge clickable btn-indent-edit-make" data-realindex="${realIndex}" title="Click to edit Make / Brand for ${escapeHtml(matName)}" style="border:none; cursor:pointer;">${escapeHtml(makeVal)} <i data-lucide="edit-2" style="width:10px;height:10px;margin-left:3px;opacity:0.75;"></i></button>`
          : `<span class="make-badge" style="border:none;">${escapeHtml(makeVal)}</span>`)
      : (isAdmin
          ? `<button type="button" class="btn btn-secondary btn-indent-edit-make" data-realindex="${realIndex}" title="Give Make / Brand for ${escapeHtml(matName)}" style="padding: 2px 7px; font-size: 0.72rem; border: 1px dashed rgba(99,102,241,0.35); color: #a5b4fc; background: rgba(99,102,241,0.08); border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; width: auto;"><i data-lucide="tag" style="width: 10px; height: 10px;"></i> + Set Make</button>`
          : `<span style="font-size: 0.78rem; color: var(--text-muted);">—</span>`);

    // Available quantity calculation
    const itemInv = inventory[matName];
    const availQty = itemInv ? (Math.round(itemInv.available * 100) / 100) : 0;
    const availColor = availQty > 0 ? 'var(--success)' : 'var(--danger)';
    let statusClass = 'in-stock', statusText = 'In Stock';
    if (itemInv) {
      if (itemInv.status === 'out-of-stock') { statusClass = 'out-of-stock'; statusText = 'Out of Stock'; }
      else if (itemInv.status === 'low-stock') { statusClass = 'low-stock'; statusText = 'Low Stock'; }
    } else {
      if (availQty <= 0) { statusClass = 'out-of-stock'; statusText = 'Out of Stock'; }
    }

    const itemLink = getEffectiveItemPoLink(p);
    let invBtn = '';
    if (itemLink) {
      invBtn = `<div style="display: flex; gap: 4px; align-items: center; justify-content: center;">
          <button type="button" class="btn btn-secondary btn-indent-view-inv" data-idx="${idx}" title="View Item PO / Invoice" style="padding: 3px 8px; font-size: 0.75rem; color: #818cf8; background: rgba(99,102,241,0.12); border-color: rgba(99,102,241,0.3); display: inline-flex; align-items: center; gap: 3px; width: auto;"><i data-lucide="eye" style="width: 12px; height: 12px;"></i> View</button>
          ${isAdmin ? `<button type="button" class="btn btn-secondary btn-indent-attach-inv" data-idx="${idx}" title="Edit / Reupload Item PO / Invoice" style="padding: 3px 6px; font-size: 0.75rem; color: #a5b4fc; background: rgba(99,102,241,0.08); border-color: rgba(99,102,241,0.25); display: inline-flex; align-items: center; width: auto;"><i data-lucide="upload-cloud" style="width: 12px; height: 12px;"></i></button>
          <button type="button" class="btn btn-secondary btn-indent-delete-inv" data-idx="${idx}" title="Delete Item PO / Invoice" style="padding: 3px 6px; font-size: 0.75rem; color: var(--danger); background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.25); display: inline-flex; align-items: center; width: auto;"><i data-lucide="trash-2" style="width: 12px; height: 12px;"></i></button>` : ''}
        </div>`;
    } else {
      invBtn = isAdmin
        ? `<button type="button" class="btn btn-secondary btn-indent-attach-inv" data-idx="${idx}" style="padding: 3px 8px; font-size: 0.75rem; color: var(--success); background: rgba(16,185,129,0.1); border-color: rgba(16,185,129,0.3); display: inline-flex; align-items: center; gap: 3px; width: auto;"><i data-lucide="paperclip" style="width: 12px; height: 12px;"></i> + Attach</button>`
        : `<span style="font-size: 0.75rem; color: var(--text-muted); padding: 3px 6px;">Pending</span>`;
    }

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem;">${idx + 1}</td>
        <td style="font-weight: 600; cursor: pointer; color: var(--text-primary);" class="clickable-mat-name" data-material="${escapeHtml(matName)}" title="Click to inspect 360° traceability">
          ${escapeHtml(matName)}
        </td>
        <td>${makeDisplay}</td>
        <td style="text-align: center; font-weight: 700; color: #34d399; white-space: nowrap;">
          ${p['Quantity']} <span style="font-size: 0.74rem; color: var(--text-muted); font-weight: 400;">${escapeHtml(p['Unit'] || '')}</span>
        </td>
        <td style="text-align: right; white-space: nowrap;">
          <strong style="color: ${availColor}; font-size: 0.92rem;">${availQty}</strong>
          <span style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(p['Unit'] || '')}</span>
        </td>
        <td style="text-align: center; white-space: nowrap;">
          <span class="status-badge ${statusClass}" style="font-size: 0.68rem; padding: 2px 7px;">${statusText}</span>
        </td>
        <td style="text-align: right; white-space: nowrap;">₹${Number(p['Rate'] || 0).toLocaleString('en-IN')}</td>
        <td style="text-align: right; font-weight: 600; white-space: nowrap;">₹${Number(p['Amount'] || 0).toLocaleString('en-IN')}</td>
        <td style="text-align: center; white-space: nowrap;"><span class="status-badge ${getSourceBadgeClass(p['Source'])}" style="font-size: 0.7rem;">${escapeHtml(p['Source'] || '—')}</span></td>
        <td style="text-align: center; white-space: nowrap;">${invBtn}</td>
        <td style="text-align: center; white-space: nowrap;">
          <button type="button" class="btn btn-secondary btn-indent-inspect-mat" data-material="${escapeHtml(matName)}" style="padding: 3px 8px; font-size: 0.74rem; border-radius: 6px; display: inline-flex; align-items: center; gap: 3px; width: auto;" title="Inspect Traceability">
            <i data-lucide="eye" style="width: 11px; height: 11px;"></i> Details
          </button>
        </td>
      </tr>
    `;
  }).join('');

  result.innerHTML = `
    <!-- Summary Strip -->
    <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; align-items: center;">
      <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); padding: 8px 14px; border-radius: 8px; display: flex; align-items: center; gap: 8px;">
        <i data-lucide="file-text" style="width: 16px; height: 16px; color: var(--success);"></i>
        <span class="kpi-subtext">Selected Indent:</span>
        <strong style="font-family: monospace; font-size: 0.95rem; color: var(--success);">${escapeHtml(indentNo)}</strong>
      </div>
      <div style="background: rgba(15, 23, 42, 0.5); border: 1px solid var(--border-color); padding: 8px 12px; border-radius: 8px;">
        <span class="kpi-subtext">Received Date:</span>
        <strong style="margin-left: 5px;">${formatDateToDDMMYYYY(receivedDate) || receivedDate}</strong>
      </div>
      <div style="background: rgba(15, 23, 42, 0.5); border: 1px solid var(--border-color); padding: 8px 12px; border-radius: 8px;">
        <span class="kpi-subtext">Source:</span>
        <strong style="margin-left: 5px;">${escapeHtml(source)}</strong>
      </div>
      <div style="background: rgba(15, 23, 42, 0.5); border: 1px solid var(--border-color); padding: 8px 12px; border-radius: 8px;">
        <span class="kpi-subtext">Items Count:</span>
        <strong style="margin-left: 5px; color: var(--text-primary);">${totalItems}</strong>
      </div>
      <div style="background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.3); padding: 8px 14px; border-radius: 8px; margin-left: auto;">
        <span class="kpi-subtext">Total Value:</span>
        <strong style="margin-left: 5px; font-size: 1.05rem; color: #a5b4fc;">₹${grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong>
      </div>
    </div>

    <!-- Attached PO / Invoice Section -->
    ${indentDocCardHtml}

    <!-- Materials Table under this Indent -->
    <div style="border: 1px solid var(--border-color); border-radius: 10px; overflow-x: auto; background: rgba(15, 23, 42, 0.45);">
      <table class="data-table" style="font-size: 0.82rem; width: 100%; margin: 0;">
        <thead>
          <tr>
            <th style="text-align: center; width: 32px;">#</th>
            <th>Material Name</th>
            <th>Make / Brand</th>
            <th style="text-align: center;">Purchased</th>
            <th style="text-align: right;">Available Stock</th>
            <th style="text-align: center;">Status</th>
            <th style="text-align: right;">Rate (₹)</th>
            <th style="text-align: right;">Amount (₹)</th>
            <th style="text-align: center;">Source</th>
            <th style="text-align: center;">PO / Invoice</th>
            <th style="text-align: center;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border-color); background: rgba(99, 102, 241, 0.06);">
            <td colspan="7" style="padding: 10px 14px; font-weight: 700; color: var(--text-secondary); text-align: right; font-size: 0.85rem;">Grand Total:</td>
            <td style="padding: 10px 14px; font-weight: 800; font-size: 0.95rem; color: #a5b4fc; text-align: right;">₹${grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
            <td colspan="3"></td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;

  result.style.display = 'block';

  // Wire View Indent Doc button
  const viewIndentBtn = result.querySelector('#btn-view-indent-doc');
  if (viewIndentBtn) {
    viewIndentBtn.onclick = () => openIndentInvoiceViewerModal(indentNo);
  }

  // Wire Upload Indent Doc button
  const uploadIndentBtn = result.querySelector('#btn-upload-indent-doc');
  if (uploadIndentBtn) {
    uploadIndentBtn.onclick = () => openReuploadInvoiceModalForIndent(indentNo);
  }

  // Wire Delete Indent Doc button
  const deleteIndentBtn = result.querySelector('#btn-delete-indent-doc');
  if (deleteIndentBtn) {
    deleteIndentBtn.onclick = () => deleteIndentInvoice(indentNo);
  }

  // Wire row invoice buttons
  result.querySelectorAll('.btn-indent-view-inv').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (rows[idx]) {
        openInvoiceViewerModal(rows[idx]);
      } else {
        openIndentInvoiceViewerModal(indentNo);
      }
    };
  });

  result.querySelectorAll('.btn-indent-attach-inv').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (rows[idx]) {
        openReuploadInvoiceModal(rows[idx], 'purchase');
      } else {
        openReuploadInvoiceModalForIndent(indentNo);
      }
    };
  });

  result.querySelectorAll('.btn-indent-delete-inv').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (rows[idx]) deleteItemInvoice(rows[idx]);
    };
  });

  // Wire Edit Make button click on indent item rows
  result.querySelectorAll('.btn-indent-edit-make').forEach(btn => {
    btn.onclick = () => {
      const realIdx = parseInt(btn.getAttribute('data-realindex'), 10);
      if (!isNaN(realIdx) && state.purchases[realIdx]) {
        openEditMakeModal('purchase', realIdx);
      }
    };
  });

  // Wire material name click & action button click to open Material 360 Traceability
  result.querySelectorAll('.clickable-mat-name, .btn-indent-inspect-mat').forEach(el => {
    el.onclick = () => {
      const mat = el.getAttribute('data-material');
      if (mat) openMaterialDetailModal(mat);
    };
  });

  lucide.createIcons();
}

/** Helper to extract Google Drive PDF embeddable preview URL */
function extractDrivePreviewUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const str = url.trim();
  if (!str) return null;

  if (str.startsWith('data:')) {
    return str;
  }

  let match = str.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://drive.google.com/file/d/${match[1]}/preview`;
  }

  match = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://drive.google.com/file/d/${match[1]}/preview`;
  }

  match = str.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://drive.google.com/file/d/${match[1]}/preview`;
  }

  if (str.startsWith('http://') || str.startsWith('https://')) {
    return str;
  }

  return null;
}

/** Render appropriate viewer HTML for Base64 files, images, or Google Drive URLs */
function renderDocumentViewerHtml(rawPoLink, pRecord = null) {
  if (!rawPoLink || typeof rawPoLink !== 'string') return '';
  const str = rawPoLink.trim();
  if (!str) return '';
  const isAdmin = state.currentUser !== 'staff';

  // 1. Base64 Data URL (uploaded from PC)
  if (str.startsWith('data:')) {
    if (str.startsWith('data:image/')) {
      return `
        <div style="margin-top: 18px; border-top: 1px solid var(--border-color); padding-top: 18px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
            <h3 style="font-size: 1rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
              <i data-lucide="file-text" style="color: var(--primary); width: 18px; height: 18px;"></i>
              Official PO / Invoice Image Document
            </h3>
            ${pRecord && isAdmin ? `<div style="display: flex; gap: 8px; align-items: center;">
              <button type="button" class="btn btn-primary btn-reupload-invoice-now" style="padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; width: auto;">
                <i data-lucide="upload-cloud" style="width: 14px; height: 14px;"></i> Reupload / Change Invoice
              </button>
              <button type="button" class="btn btn-danger btn-delete-invoice-now" style="padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; width: auto; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.35);">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Delete Invoice
              </button>
            </div>` : ''}
          </div>
          <div style="width: 100%; height: calc(95vh - 280px); min-height: 560px; border-radius: 12px; overflow: auto; border: 1px solid var(--border-color); background: rgba(15, 23, 42, 0.8); text-align: center; padding: 16px;">
            <img src="${str}" style="max-width: 100%; max-height: calc(95vh - 310px); object-fit: contain; border-radius: 8px; border: 1px solid var(--border-color);" alt="Invoice Document">
          </div>
        </div>
      `;
    } else {
      return `
        <div style="margin-top: 18px; border-top: 1px solid var(--border-color); padding-top: 18px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
            <h3 style="font-size: 1rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
              <i data-lucide="file-text" style="color: var(--primary); width: 18px; height: 18px;"></i>
              Official PO / Invoice Document (PDF)
            </h3>
            ${pRecord && isAdmin ? `<div style="display: flex; gap: 8px; align-items: center;">
              <button type="button" class="btn btn-primary btn-reupload-invoice-now" style="padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; width: auto;">
                <i data-lucide="upload-cloud" style="width: 14px; height: 14px;"></i> Reupload / Change Invoice
              </button>
              <button type="button" class="btn btn-danger btn-delete-invoice-now" style="padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; width: auto; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.35);">
                <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Delete Invoice
              </button>
            </div>` : ''}
          </div>
          <div style="position: relative; width: 100%; height: calc(95vh - 280px); min-height: 560px; border-radius: 12px; overflow: hidden; border: 1px solid var(--border-color); background: rgba(15, 23, 42, 0.8);">
            <embed src="${str}" type="application/pdf" style="width: 100%; height: 100%; border: none;">
          </div>
        </div>
      `;
    }
  }

  // 2. Google Drive or External URL
  const previewUrl = extractDrivePreviewUrl(str);
  if (!previewUrl) return '';

  return `
    <div style="margin-top: 18px; border-top: 1px solid var(--border-color); padding-top: 18px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
        <h3 style="font-size: 1rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
          <i data-lucide="file-text" style="color: var(--primary); width: 18px; height: 18px;"></i>
          Official PO / Invoice Document (Google Drive / Cloud)
        </h3>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          ${pRecord && isAdmin ? `<button type="button" class="btn btn-primary btn-reupload-invoice-now" style="padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; width: auto;">
            <i data-lucide="upload-cloud" style="width: 14px; height: 14px;"></i> Reupload / Change Invoice
          </button>
          <button type="button" class="btn btn-danger btn-delete-invoice-now" style="padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px; width: auto; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.35);">
            <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Delete Invoice
          </button>` : ''}
          <a href="${str}" target="_blank" class="btn btn-secondary" style="padding: 6px 14px; font-size: 0.8rem; text-decoration: none; width: auto; display: inline-flex; align-items: center; gap: 6px; color: #818cf8; border-color: rgba(99,102,241,0.3);">
            <i data-lucide="external-link" style="width: 14px; height: 14px;"></i> Open PDF
          </a>
        </div>
      </div>
      <div style="position: relative; width: 100%; height: calc(95vh - 280px); min-height: 560px; border-radius: 12px; overflow: hidden; border: 1px solid var(--border-color); background: rgba(15, 23, 42, 0.8);">
        <iframe src="${previewUrl}" style="width: 100%; height: 100%; border: none;" allow="autoplay"></iframe>
      </div>
      ${isAdmin ? `<div style="margin-top: 10px; font-size: 0.78rem; color: #cbd5e1; display: flex; align-items: center; gap: 8px; background: rgba(99, 102, 241, 0.08); padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(99, 102, 241, 0.2);">
        <i data-lucide="info" style="width: 16px; height: 16px; color: #818cf8; flex-shrink: 0;"></i>
        <span>Seeing <em>"Sorry, the file you have requested does not exist"</em> above? The Google Drive link is either broken, deleted, or restricted. Click <strong>Reupload / Change Invoice</strong> to attach a file directly from your PC or paste a valid link.</span>
      </div>` : ''}
    </div>
  `;
}

let currentViewerContext = { type: null, indentNo: null, record: null };

/** Open Dedicated Invoice & Item Clarity Viewer Modal */
async function openInvoiceViewerModal(p) {
  const modal = document.getElementById('invoice-viewer-modal');
  const body = document.getElementById('invoice-modal-body');
  const subtitleEl = document.getElementById('invoice-modal-subtitle');
  if (!modal || !body || !p) return;

  const indentNo = p["Indent No"] || 'N/A';
  currentViewerContext = { type: 'single', record: p, indentNo: indentNo !== 'N/A' ? indentNo : null };

  if (subtitleEl) {
    subtitleEl.textContent = 'Full purchase information and official item invoice document';
  }

  const receivedDate = p["Received Date"] || 'N/A';
  const matName = p["Material Name"] || 'N/A';
  const make = p["Make"] || '—';
  const qty = p["Quantity"] || 0;
  const unit = p["Unit"] || 'Nos';
  const rate = Number(p["Rate"] || 0);
  const amount = Number(p["Amount"] || (qty * rate));
  const source = p["Source"] || 'GEM';
  let rawPoLink = getEffectiveItemPoLink(p);

  if (rawPoLink.startsWith('idb:')) {
    const key = rawPoLink.replace('idb:', '');
    const idbData = await InvoiceStorage.getInvoice(key);
    if (idbData) {
      rawPoLink = idbData;
    }
  }

  const inventory = calculateInventory();
  const itemInv = inventory[matName];
  const availStock = itemInv ? Math.round(itemInv.available * 100) / 100 : 'N/A';
  const statusBadgeClass = getSourceBadgeClass(source);
  const isAdmin = state.currentUser !== 'staff';

  let pdfViewerHtml = renderDocumentViewerHtml(rawPoLink, p);
  if (!pdfViewerHtml) {
    pdfViewerHtml = `
      <div style="margin-top: 18px; border-top: 1px solid var(--border-color); padding-top: 18px; text-align: center;">
        <div style="background: rgba(15, 23, 42, 0.5); border: 1px dashed var(--border-color); padding: 26px; border-radius: 12px;">
          <i data-lucide="file-warning" style="width: 32px; height: 32px; color: var(--warning); margin-bottom: 8px;"></i>
          <h4 style="font-size: 0.95rem; font-weight: 600; margin-bottom: 4px;">No Invoice Document Attached</h4>
          <p class="kpi-subtext" style="margin-bottom: 12px;">${isAdmin ? 'You can upload a PDF/Image invoice file or paste a Google Drive URL below.' : 'No official PO or supplier invoice has been attached to this purchase item yet.'}</p>
          ${isAdmin ? `<button type="button" class="btn btn-primary btn-reupload-invoice-now" style="width: auto; padding: 7px 16px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 6px;">
            <i data-lucide="upload-cloud" style="width: 14px; height: 14px;"></i> Attach or Reupload Invoice Document
          </button>` : ''}
        </div>
      </div>
    `;
  }

  body.innerHTML = `
    <!-- Item & Purchase Clarity Card -->
    <div style="background: linear-gradient(135deg, rgba(15, 23, 42, 0.9), rgba(30, 41, 59, 0.7)); border: 1px solid rgba(99, 102, 241, 0.25); border-radius: 14px; padding: 18px; margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px;">
        <div>
          <span class="kpi-subtext" style="text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.5px;">Material Item Name</span>
          <h3 style="font-size: 1.25rem; font-weight: 800; color: var(--text-primary); margin-top: 2px;">${matName}</h3>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${make && make !== '—' ? `<span class="make-badge" style="font-size: 0.82rem; padding: 5px 10px;">${make}</span>` : ''}
          <span class="status-badge ${statusBadgeClass}" style="font-size: 0.82rem; padding: 5px 10px;">${source}</span>
        </div>
      </div>

      <!-- Item Metrics Grid -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px;">
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Indent No.</span>
          <div style="font-family: monospace; font-size: 0.9rem; font-weight: 700; color: #34d399; margin-top: 2px;">${indentNo}</div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Received Date</span>
          <div style="font-size: 0.9rem; font-weight: 600; color: var(--text-primary); margin-top: 2px;">${receivedDate}</div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Purchased Quantity</span>
          <div style="font-size: 1.05rem; font-weight: 800; color: #34d399; margin-top: 2px;">${qty} <span style="font-size: 0.78rem; font-weight: 400; color: var(--text-muted);">${unit}</span></div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Unit Rate (₹)</span>
          <div style="font-size: 0.95rem; font-weight: 700; color: var(--text-primary); margin-top: 2px;">₹${rate.toLocaleString('en-IN')}</div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Total Amount (₹)</span>
          <div style="font-size: 1.05rem; font-weight: 800; color: #a5b4fc; margin-top: 2px;">₹${amount.toLocaleString('en-IN')}</div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Current Stock Available</span>
          <div style="font-size: 1.05rem; font-weight: 800; color: var(--success); margin-top: 2px;">${availStock} <span style="font-size: 0.78rem; font-weight: 400; color: var(--text-muted);">${unit}</span></div>
        </div>
      </div>
    </div>

    <!-- PDF Viewer Section -->
    ${pdfViewerHtml}
  `;

  modal.classList.add('active');
  lucide.createIcons();

  // Wire up close button & attach/reupload buttons
  const closeBtn = document.getElementById('close-invoice-modal-btn');
  if (closeBtn) closeBtn.onclick = closeInvoiceViewerModal;
  
  const reuploadBtns = body.querySelectorAll('.btn-reupload-invoice-now');
  reuploadBtns.forEach(btn => {
    btn.onclick = () => openReuploadInvoiceModal(p);
  });

  const deleteBtns = body.querySelectorAll('.btn-delete-invoice-now');
  deleteBtns.forEach(btn => {
    btn.onclick = () => deleteItemInvoice(p);
  });
}

function closeInvoiceViewerModal() {
  const modal = document.getElementById('invoice-viewer-modal');
  if (modal) modal.classList.remove('active');
  currentViewerContext = { type: null, indentNo: null, record: null };
}

/** Open Dedicated Indent PO / Invoice Viewer Modal (Shows all items' invoices in Merged Form) */
async function openIndentInvoiceViewerModal(indentNo) {
  const modal = document.getElementById('invoice-viewer-modal');
  const body = document.getElementById('invoice-modal-body');
  const subtitleEl = document.getElementById('invoice-modal-subtitle');
  if (!modal || !body || !indentNo) return;

  currentViewerContext = { type: 'indent', indentNo: indentNo, record: null };

  const rows = state.purchases.filter(p =>
    (p['Indent No'] || '').toString().trim() === indentNo.toString().trim()
  );
  if (rows.length === 0) return;

  rows.sort((a, b) => parseDate(b['Received Date']) - parseDate(a['Received Date']));
  const totalItems = rows.length;
  const grandTotal = rows.reduce((sum, p) => sum + (Number(p['Amount']) || 0), 0);
  const receivedDate = rows[0]['Received Date'] || '—';
  const source = rows[0]['Source'] || '—';
  const isAdmin = state.currentUser !== 'staff';

  if (subtitleEl) {
    subtitleEl.textContent = `Consolidated PO & Invoices Dossier — Merged view for Indent ${indentNo} (${totalItems} items)`;
  }

  // Resolve all items' uploaded documents (IndexedDB or URL) - strictly item-specific
  const resolvedItems = [];
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    let docLink = getEffectiveItemPoLink(p);
    if (docLink && docLink.startsWith('idb:')) {
      const key = docLink.replace('idb:', '');
      const idbData = await InvoiceStorage.getInvoice(key);
      if (idbData) docLink = idbData;
    }

    resolvedItems.push({
      record: p,
      idx: i + 1,
      realIndex: state.purchases.indexOf(p),
      materialName: p['Material Name'] || 'Item',
      make: p['Make'] || '',
      quantity: p['Quantity'] || 0,
      unit: p['Unit'] || '',
      rate: Number(p['Rate'] || 0),
      amount: Number(p['Amount'] || 0),
      source: p['Source'] || source,
      docLink: docLink || ''
    });
  }

  const itemsWithDocs = resolvedItems.filter(it => !!it.docLink);

  // If no document attached across the indent
  if (itemsWithDocs.length === 0) {
    body.innerHTML = `
      <!-- Indent Clarity Header Card -->
      <div style="background: linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.75)); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 14px; padding: 18px; margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px;">
          <div>
            <span class="kpi-subtext" style="text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.5px;">Purchase Order &amp; Invoice Registry</span>
            <h3 style="font-size: 1.35rem; font-weight: 800; color: var(--text-primary); margin-top: 2px;">Indent No.: ${indentNo}</h3>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="status-badge ${getSourceBadgeClass(source)}" style="font-size: 0.82rem; padding: 5px 10px;">${source}</span>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
            <span class="kpi-subtext">Received Date</span>
            <div style="font-size: 0.92rem; font-weight: 600; color: var(--text-primary); margin-top: 2px;">${receivedDate}</div>
          </div>
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
            <span class="kpi-subtext">Total Items in Indent</span>
            <div style="font-size: 1.05rem; font-weight: 800; color: #34d399; margin-top: 2px;">${totalItems} items</div>
          </div>
          <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
            <span class="kpi-subtext">Grand Total Value</span>
            <div style="font-size: 1.05rem; font-weight: 800; color: #a5b4fc; margin-top: 2px;">₹${grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
          </div>
        </div>
      </div>

      <div style="margin-top: 18px; border-top: 1px solid var(--border-color); padding-top: 18px; text-align: center;">
        <div style="background: rgba(15, 23, 42, 0.5); border: 1px dashed var(--border-color); padding: 36px 20px; border-radius: 12px;">
          <i data-lucide="file-warning" style="width: 36px; height: 36px; color: var(--warning); margin-bottom: 10px;"></i>
          <h4 style="font-size: 1rem; font-weight: 700; margin-bottom: 6px;">No PO or Invoice Document Attached for Indent ${indentNo}</h4>
          <p class="kpi-subtext" style="margin-bottom: 16px;">${isAdmin ? 'Each item can have its own separate uploaded PO/invoice or you can attach a shared document for this indent.' : 'No official purchase order or invoice document has been attached to this indent yet.'}</p>
          ${isAdmin ? `<button type="button" class="btn btn-primary btn-attach-indent-modal" style="width: auto; padding: 8px 22px; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 7px;">
            <i data-lucide="upload-cloud" style="width: 15px; height: 15px;"></i> Attach / Upload PO or Invoice
          </button>` : ''}
        </div>
      </div>
    `;

    modal.classList.add('active');
    lucide.createIcons();

    const closeBtn = document.getElementById('close-invoice-modal-btn');
    if (closeBtn) closeBtn.onclick = closeInvoiceViewerModal;
    if (isAdmin) {
      body.querySelectorAll('.btn-attach-indent-modal').forEach(btn => {
        btn.onclick = () => openReuploadInvoiceModalForIndent(indentNo);
      });
    }
    return;
  }

  // Quick-Jump navigation pills
  const quickPillsHtml = `
    <div style="display: flex; gap: 8px; overflow-x: auto; padding: 6px 2px 14px 2px; margin-bottom: 16px; border-bottom: 1px solid var(--border-color); align-items: center;">
      <button type="button" class="merged-nav-pill active" id="btn-scroll-top-merged" style="cursor: pointer;">
        <i data-lucide="layers" style="width: 14px; height: 14px;"></i> All Items Merged (${totalItems})
      </button>
      ${resolvedItems.map(it => `
        <button type="button" class="merged-nav-pill ${it.docLink ? 'has-doc' : 'no-doc'}" data-target="merged-doc-item-${it.realIndex}" title="${it.materialName}: ${it.docLink ? 'PO/Invoice Attached' : 'Pending Upload'}">
          ${it.docLink ? '<i data-lucide="check" style="width: 12px; height: 12px; color: var(--success);"></i>' : '<i data-lucide="alert-circle" style="width: 12px; height: 12px; color: var(--warning);"></i>'}
          <span>#${it.idx}: ${it.materialName.length > 22 ? it.materialName.substring(0, 20) + '...' : it.materialName}</span>
        </button>
      `).join('')}
    </div>
  `;

  // Build each item's merged document card
  const mergedCardsHtml = resolvedItems.map(it => {
    let docPreview = '';
    if (it.docLink) {
      if (it.docLink.startsWith('data:image/')) {
        docPreview = `
          <div style="text-align: center; padding: 18px; background: rgba(15, 23, 42, 0.85); border-radius: 0 0 14px 14px;">
            <img src="${it.docLink}" style="max-width: 100%; max-height: 650px; object-fit: contain; border-radius: 8px; border: 1px solid var(--border-color);" alt="${it.materialName}">
          </div>
        `;
      } else if (it.docLink.startsWith('data:')) {
        docPreview = `
          <div style="position: relative; width: 100%; height: 650px; border-radius: 0 0 14px 14px; overflow: hidden; background: rgba(15, 23, 42, 0.85);">
            <embed src="${it.docLink}" type="application/pdf" style="width: 100%; height: 100%; border: none;">
          </div>
        `;
      } else {
        const previewUrl = extractDrivePreviewUrl(it.docLink);
        docPreview = `
          <div style="position: relative; width: 100%; height: 650px; border-radius: 0 0 14px 14px; overflow: hidden; background: rgba(15, 23, 42, 0.85);">
            <iframe src="${previewUrl}" style="width: 100%; height: 100%; border: none;" allow="autoplay"></iframe>
          </div>
        `;
      }
    } else {
      docPreview = `
        <div style="text-align: center; padding: 28px 20px; background: rgba(15, 23, 42, 0.5); border-radius: 0 0 14px 14px;">
          <i data-lucide="file-warning" style="width: 26px; height: 26px; color: var(--warning); margin-bottom: 6px;"></i>
          <div style="font-size: 0.92rem; font-weight: 600; color: var(--text-secondary);">No separate PO or invoice uploaded for this item</div>
          <p class="kpi-subtext" style="margin-bottom: 12px;">${isAdmin ? `Attach the supplier invoice or purchase order for ${it.materialName}.` : `No invoice document attached for ${it.materialName}.`}</p>
          ${isAdmin ? `<button type="button" class="btn btn-primary btn-reupload-in-merged" data-realindex="${it.realIndex}" style="width: auto; padding: 6px 16px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px;">
            <i data-lucide="upload-cloud" style="width: 13px; height: 13px;"></i> Attach Item Invoice
          </button>` : ''}
        </div>
      `;
    }

    return `
      <div class="merged-doc-card" id="merged-doc-item-${it.realIndex}">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.9)); border-bottom: 1px solid var(--border-color); flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <span style="background: rgba(99, 102, 241, 0.22); color: #818cf8; font-weight: 800; font-size: 0.82rem; padding: 3px 9px; border-radius: 6px; letter-spacing: 0.3px;">Item #${it.idx}</span>
            <span style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary); cursor: pointer;" class="clickable-mat-name" data-material="${it.materialName}" title="Inspect Material Traceability">${it.materialName}</span>
            ${it.make
              ? (isAdmin
                  ? `<button type="button" class="make-badge clickable btn-merged-edit-make" data-realindex="${it.realIndex}" title="Click to edit Make / Brand for ${it.materialName}" style="border:none; cursor:pointer;">${it.make} <i data-lucide="edit-2" style="width:10px;height:10px;margin-left:3px;opacity:0.75;"></i></button>`
                  : `<span class="make-badge" style="border:none;">${it.make}</span>`)
              : (isAdmin
                  ? `<button type="button" class="btn btn-secondary btn-merged-edit-make" data-realindex="${it.realIndex}" title="Give Make / Brand for ${it.materialName}" style="padding: 2px 7px; font-size: 0.72rem; border: 1px dashed rgba(99,102,241,0.35); color: #a5b4fc; background: rgba(99,102,241,0.08); border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; width: auto;"><i data-lucide="tag" style="width: 10px; height: 10px;"></i> + Set Make</button>`
                  : '')
            }
            <span style="font-size: 0.84rem; color: #34d399; font-weight: 600;">${it.quantity} ${it.unit}</span>
            <span style="font-size: 0.84rem; color: #a5b4fc; font-weight: 700;">₹${it.amount.toLocaleString('en-IN')}</span>
            ${it.docLink ? `<span class="mode-badge cloud" style="font-size: 0.72rem; padding: 2px 8px; font-weight: 600;">PO / Invoice Linked</span>` : `<span class="mode-badge local" style="font-size: 0.72rem; padding: 2px 8px; color: var(--warning); font-weight: 600;">Pending Upload</span>`}
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            ${isAdmin ? `
              <button type="button" class="btn btn-secondary btn-reupload-in-merged" data-realindex="${it.realIndex}" title="Reupload or Change Invoice" style="padding: 5px 12px; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 5px; width: auto; color: #a5b4fc; border-color: rgba(99,102,241,0.3);">
                <i data-lucide="upload-cloud" style="width: 13px; height: 13px;"></i> ${it.docLink ? 'Reupload / Change' : 'Upload PO'}
              </button>
            ` : ''}
            ${it.docLink ? `
              ${isAdmin ? `
                <button type="button" class="btn btn-danger btn-delete-in-merged" data-realindex="${it.realIndex}" title="Delete Invoice" style="padding: 5px 12px; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 5px; width: auto; background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.3);">
                  <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i> Delete
                </button>
              ` : ''}
              ${it.docLink.startsWith('https://') ? `
                <a href="${it.docLink}" target="_blank" class="btn btn-secondary" style="padding: 5px 12px; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 5px; text-decoration: none; width: auto; color: #818cf8; border-color: rgba(99,102,241,0.3);">
                  <i data-lucide="external-link" style="width: 13px; height: 13px;"></i> Open
                </a>
              ` : ''}
            ` : ''}
          </div>
        </div>
        ${docPreview}
      </div>
    `;
  }).join('');

  body.innerHTML = `
    <!-- Indent Clarity Header Card -->
    <div style="background: linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.75)); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 14px; padding: 18px; margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="mode-badge cloud" style="font-size: 0.72rem; padding: 2px 8px; font-weight: 700;">CONSOLIDATED INDENT DOSSIER</span>
            <span class="mode-badge local" style="font-size: 0.72rem; padding: 2px 8px; font-weight: 600; color: #34d399; background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.3);">${itemsWithDocs.length} of ${totalItems} Uploaded</span>
          </div>
          <h3 style="font-size: 1.35rem; font-weight: 800; color: var(--text-primary); margin-top: 4px;">Indent No.: ${indentNo}</h3>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span class="status-badge ${getSourceBadgeClass(source)}" style="font-size: 0.82rem; padding: 5px 10px;">${source}</span>
          <button type="button" class="btn btn-primary" id="btn-combine-indent-pdfs" style="width: auto; padding: 6px 16px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(99,102,241,0.25);">
            <i data-lucide="layers" style="width: 14px; height: 14px;"></i> Combine &amp; Download Merged PDF
          </button>
          ${isAdmin ? `
            <button type="button" class="btn btn-secondary btn-attach-indent-modal" style="width: auto; padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 5px; color: #a5b4fc; border-color: rgba(99,102,241,0.3);">
              <i data-lucide="upload-cloud" style="width: 14px; height: 14px;"></i> Attach to Entire Indent
            </button>
            <button type="button" class="btn btn-secondary btn-delete-entire-indent-modal" style="width: auto; padding: 6px 14px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 5px; color: var(--danger); border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.08);">
              <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Delete Indent PO
            </button>
          ` : ''}
        </div>
      </div>

      <!-- Metrics Grid -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Received Date</span>
          <div style="font-size: 0.92rem; font-weight: 600; color: var(--text-primary); margin-top: 2px;">${receivedDate}</div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Total Items in Indent</span>
          <div style="font-size: 1.05rem; font-weight: 800; color: #34d399; margin-top: 2px;">${totalItems} items</div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Items with PO/Invoice</span>
          <div style="font-size: 1.05rem; font-weight: 800; color: #818cf8; margin-top: 2px;">${itemsWithDocs.length} / ${totalItems}</div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); padding: 10px 12px; border-radius: 8px;">
          <span class="kpi-subtext">Grand Total Value</span>
          <div style="font-size: 1.05rem; font-weight: 800; color: #a5b4fc; margin-top: 2px;">₹${grandTotal.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
      </div>
    </div>

    <!-- Quick Jump Navigation Strip -->
    ${quickPillsHtml}

    <!-- Merged Sequential Documents Container -->
    <div id="merged-docs-container">
      ${mergedCardsHtml}
    </div>
  `;

  modal.classList.add('active');
  lucide.createIcons();

  // Close button
  const closeBtn = document.getElementById('close-invoice-modal-btn');
  if (closeBtn) closeBtn.onclick = closeInvoiceViewerModal;

  // Indent-level upload & delete
  body.querySelectorAll('.btn-attach-indent-modal').forEach(btn => {
    btn.onclick = () => openReuploadInvoiceModalForIndent(indentNo);
  });
  body.querySelectorAll('.btn-delete-entire-indent-modal').forEach(btn => {
    btn.onclick = () => deleteIndentInvoice(indentNo);
  });

  // Reupload buttons inside merged view
  body.querySelectorAll('.btn-reupload-in-merged').forEach(btn => {
    btn.onclick = () => {
      const realIndex = parseInt(btn.getAttribute('data-realindex'), 10);
      if (state.purchases[realIndex]) {
        openReuploadInvoiceModal(state.purchases[realIndex], 'purchase');
      }
    };
  });

  // Delete buttons inside merged view
  body.querySelectorAll('.btn-delete-in-merged').forEach(btn => {
    btn.onclick = () => {
      const realIndex = parseInt(btn.getAttribute('data-realindex'), 10);
      if (state.purchases[realIndex]) {
        deleteItemInvoice(state.purchases[realIndex]);
      }
    };
  });

  // Edit Make buttons inside merged view
  body.querySelectorAll('.btn-merged-edit-make').forEach(btn => {
    btn.onclick = () => {
      const realIndex = parseInt(btn.getAttribute('data-realindex'), 10);
      if (!isNaN(realIndex) && state.purchases[realIndex]) {
        openEditMakeModal('purchase', realIndex);
      }
    };
  });

  // Combine PDFs button
  const combineBtn = body.querySelector('#btn-combine-indent-pdfs');
  if (combineBtn) {
    combineBtn.onclick = () => combineIndentPdfs(resolvedItems, indentNo);
  }

  // Quick jump pill smooth scroll
  const scrollTopBtn = body.querySelector('#btn-scroll-top-merged');
  if (scrollTopBtn) {
    scrollTopBtn.onclick = () => {
      body.querySelectorAll('.merged-nav-pill').forEach(p => p.classList.remove('active'));
      scrollTopBtn.classList.add('active');
      const firstCard = body.querySelector('.merged-doc-card');
      if (firstCard) firstCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  body.querySelectorAll('.merged-nav-pill[data-target]').forEach(pill => {
    pill.onclick = () => {
      const targetId = pill.getAttribute('data-target');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        body.querySelectorAll('.merged-nav-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
  });

  // Material name click -> Material 360 Traceability
  body.querySelectorAll('.clickable-mat-name').forEach(cell => {
    cell.onclick = () => {
      const mat = cell.getAttribute('data-material');
      if (mat) openMaterialDetailModal(mat);
    };
  });
}

/** Combine all items' PDFs / images in an indent into a single unified multi-page PDF */
async function combineIndentPdfs(items, indentNo = 'Indent') {
  if (typeof PDFLib === 'undefined') {
    showToast('PDF merging library is loading. Please try again in a moment.', 'info');
    return;
  }
  try {
    setSyncingAnimation(true);
    const mergedPdf = await PDFLib.PDFDocument.create();
    let pagesAdded = 0;

    for (const item of items) {
      const link = item.docLink;
      if (!link) continue;

      if (link.startsWith('data:application/pdf') || link.startsWith('data:;base64') || (link.startsWith('data:') && !link.startsWith('data:image/'))) {
        try {
          const parts = link.split(',');
          if (parts.length < 2) continue;
          const binaryStr = atob(parts[1]);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          const srcPdf = await PDFLib.PDFDocument.load(bytes);
          const copiedPages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
          copiedPages.forEach(p => mergedPdf.addPage(p));
          pagesAdded += copiedPages.length;
        } catch (pdfErr) {
          console.warn(`PDF parse error for ${item.materialName}:`, pdfErr);
        }
      } else if (link.startsWith('data:image/')) {
        try {
          const parts = link.split(',');
          if (parts.length < 2) continue;
          const binaryStr = atob(parts[1]);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          let img;
          if (link.startsWith('data:image/png')) {
            img = await mergedPdf.embedPng(bytes);
          } else {
            img = await mergedPdf.embedJpg(bytes);
          }
          const page = mergedPdf.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          pagesAdded++;
        } catch (imgErr) {
          console.warn(`Image embed error for ${item.materialName}:`, imgErr);
        }
      }
    }

    setSyncingAnimation(false);

    if (pagesAdded === 0) {
      showToast('No local PDF or Image files found to merge. Documents might be external Google Drive links.', 'info');
      return;
    }

    const mergedBytes = await mergedPdf.save();
    const blob = new Blob([mergedBytes], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);
    
    // Open in new tab or trigger download
    const newWindow = window.open(blobUrl, '_blank');
    if (!newWindow) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `Merged_PO_Invoices_${indentNo.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      a.click();
    }
    showToast(`Merged ${pagesAdded} document pages from ${items.length} items into a unified PDF dossier!`, 'success');
  } catch (err) {
    setSyncingAnimation(false);
    console.error('PDF combine error:', err);
    showToast('Failed to generate combined PDF: ' + err.message, 'error');
  }
}

/** Open Material 360 Traceability Modal */
async function openMaterialDetailModal(materialName) {
  const modal = document.getElementById('material-detail-modal');
  const title = document.getElementById('mat-detail-title');
  const subtitle = document.getElementById('mat-detail-subtitle');
  const body = document.getElementById('mat-detail-body');
  if (!modal || !body) return;

  const inventory = calculateInventory();
  const item = inventory[materialName];
  if (!item) {
    showToast(`No stock data found for "${materialName}"`, 'error');
    return;
  }

  title.textContent = materialName;
  subtitle.textContent = `Unit: ${item.unit} · Category: ${item.category.toUpperCase()}`;

  // Find all purchase records matching this material
  const purchases = state.purchases.filter(p => p["Material Name"] === materialName);
  purchases.sort((a, b) => parseDate(b["Received Date"]) - parseDate(a["Received Date"]));

  // Find all usage records matching this material
  const usages = state.usages.filter(u => u["Material Name"] === materialName);
  usages.sort((a, b) => parseDate(b["Date"]) - parseDate(a["Date"]));

  // Calculate location summary (Where Used breakdown)
  const locationMap = {};
  usages.forEach(u => {
    const loc = u["Where Used"] || 'Unspecified';
    const qty = Number(u["Quantity"]) || 0;
    locationMap[loc] = (locationMap[loc] || 0) + qty;
  });

  const locationPillsHtml = Object.keys(locationMap).length === 0
    ? `<span class="kpi-subtext">No usage logged yet for this material.</span>`
    : Object.entries(locationMap).map(([loc, qty]) => `
        <div style="background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.3); padding: 6px 12px; border-radius: 8px; font-size: 0.82rem; display: flex; align-items: center; gap: 6px;">
          <i data-lucide="map-pin" style="width: 13px; height: 13px; color: #818cf8;"></i>
          <strong>${loc}</strong>: <span style="color: var(--danger); font-weight: 700;">${qty} ${item.unit}</span>
        </div>
      `).join('');

  let statusClass = 'in-stock', statusText = 'In Stock (Healthy)';
  if (item.status === 'out-of-stock') { statusClass = 'out-of-stock'; statusText = 'Out of Stock'; }
  else if (item.status === 'low-stock') { statusClass = 'low-stock'; statusText = 'Low Stock Alert'; }

  // Check if any purchase has an invoice link
  const purchaseWithLink = purchases.find(p => !!getEffectiveItemPoLink(p));
  let latestPoLink = purchaseWithLink ? getEffectiveItemPoLink(purchaseWithLink) : '';
  if (latestPoLink && latestPoLink.startsWith('idb:')) {
    const key = latestPoLink.replace('idb:', '');
    const idbData = (await InvoiceStorage.getInvoice(key)) || (purchaseWithLink ? await InvoiceStorage.getInvoice(makePurchaseKey(purchaseWithLink)) : null);
    if (idbData) latestPoLink = idbData;
  }
  const pdfViewerHtml = renderDocumentViewerHtml(latestPoLink);

  let purchasesRowsHtml = '';
  if (purchases.length === 0) {
    purchasesRowsHtml = `<tr><td colspan="8" class="empty-state">No purchase receipts logged.</td></tr>`;
  } else {
    const isAdmin = state.currentUser !== 'staff';
    purchases.forEach((p, pIdx) => {
      const link = getEffectiveItemPoLink(p);
      const invBtn = link
        ? `<button class="btn btn-secondary btn-view-mat-inv" data-pindex="${pIdx}" style="padding: 3px 8px; font-size: 0.75rem; color: #818cf8; background: rgba(99, 102, 241, 0.12); border-color: rgba(99, 102, 241, 0.3);"><i data-lucide="file-text" style="width: 12px; height: 12px; margin-right: 2px;"></i> Invoice</button>`
        : `<span class="kpi-subtext">—</span>`;

      const realIndex = state.purchases.indexOf(p);
      const makeVal = p["Make"] ? p["Make"].toString().trim() : '';
      const makeDisplay = makeVal
        ? (isAdmin
            ? `<button type="button" class="make-badge clickable btn-matdetail-edit-make" data-realindex="${realIndex}" title="Click to edit Make / Brand" style="border:none; cursor:pointer;">${makeVal} <i data-lucide="edit-2" style="width:10px;height:10px;margin-left:3px;opacity:0.75;"></i></button>`
            : `<span class="make-badge" style="border:none;">${makeVal}</span>`)
        : (isAdmin
            ? `<button type="button" class="btn btn-secondary btn-matdetail-edit-make" data-realindex="${realIndex}" title="Give Make / Brand" style="padding: 2px 7px; font-size: 0.72rem; border: 1px dashed rgba(99,102,241,0.35); color: #a5b4fc; background: rgba(99,102,241,0.08); border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; width: auto;"><i data-lucide="tag" style="width: 10px; height: 10px;"></i> + Set Make</button>`
            : `<span style="font-size: 0.78rem; color: var(--text-muted);">—</span>`);

      purchasesRowsHtml += `
        <tr>
          <td style="font-family: monospace; font-size: 0.8rem; font-weight: 600;">${p["Indent No"] || 'N/A'}</td>
          <td style="font-size: 0.82rem; color: var(--text-secondary);">${p["Received Date"] || '—'}</td>
          <td>${makeDisplay}</td>
          <td style="font-weight: 700; color: #34d399;">+${p["Quantity"]} <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 400;">${p["Unit"] || item.unit}</span></td>
          <td style="font-size: 0.82rem;">₹${Number(p["Rate"] || 0).toLocaleString('en-IN')}</td>
          <td style="font-weight: 600; font-size: 0.82rem;">₹${Number(p["Amount"] || 0).toLocaleString('en-IN')}</td>
          <td><span class="status-badge ${getSourceBadgeClass(p["Source"])}" style="font-size: 0.7rem;">${p["Source"] || 'GEM'}</span></td>
          <td>${invBtn}</td>
        </tr>
      `;
    });
  }

  let usagesRowsHtml = '';
  if (usages.length === 0) {
    usagesRowsHtml = `<tr><td colspan="4" class="empty-state">No usage recorded.</td></tr>`;
  } else {
    usages.forEach(u => {
      usagesRowsHtml += `
        <tr>
          <td style="font-size: 0.82rem; color: var(--text-secondary);">${u["Date"] || '—'}</td>
          <td style="font-weight: 700; color: var(--danger);">-${u["Quantity"]} <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 400;">${item.unit}</span></td>
          <td style="font-weight: 600; color: var(--text-primary);"><i data-lucide="map-pin" style="width: 12px; height: 12px; margin-right: 4px; color: #818cf8;"></i>${u["Where Used"]}</td>
          <td class="kpi-subtext">${u["Remarks"] || '—'}</td>
        </tr>
      `;
    });
  }

  body.innerHTML = `
    <!-- Top Summary Metrics Cards -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px;">
      <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 12px;">
        <span class="kpi-subtext" style="display: block;">Current Available Stock</span>
        <span style="font-size: 1.4rem; font-weight: 800; color: var(--success);">${Math.round(item.available * 100) / 100} <span style="font-size: 0.85rem; font-weight: 400; color: var(--text-muted);">${item.unit}</span></span>
      </div>
      <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 12px;">
        <span class="kpi-subtext" style="display: block;">Total Purchased Quantity</span>
        <span style="font-size: 1.4rem; font-weight: 800; color: var(--text-primary);">${item.totalPurchased} <span style="font-size: 0.85rem; font-weight: 400; color: var(--text-muted);">${item.unit}</span></span>
      </div>
      <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 12px;">
        <span class="kpi-subtext" style="display: block;">Total Quantity Used</span>
        <span style="font-size: 1.4rem; font-weight: 800; color: var(--danger);">${item.totalUsed} <span style="font-size: 0.85rem; font-weight: 400; color: var(--text-muted);">${item.unit}</span></span>
      </div>
      <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 12px; display: flex; flex-direction: column; justify-content: center;">
        <span class="kpi-subtext" style="display: block; margin-bottom: 4px;">Stock Health Status</span>
        <div><span class="status-badge ${statusClass}">${statusText}</span></div>
      </div>
      <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 12px; display: flex; flex-direction: column; justify-content: space-between;">
        <span class="kpi-subtext" style="display: block; margin-bottom: 4px;">Make / Brand</span>
        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          ${Array.from(item.makes || []).length > 0
            ? Array.from(item.makes).map(m => `<span class="make-badge">${m}</span>`).join(' ')
            : '<span class="kpi-subtext" style="font-size:0.85rem;">Not Specified</span>'
          }
          <button type="button" class="btn btn-secondary btn-mat-edit-make-global" data-material="${materialName}" title="Set or change Make / Brand for ${materialName}" style="padding: 2px 8px; font-size: 0.74rem; color: #a5b4fc; border: 1px dashed rgba(99,102,241,0.35); background: rgba(99,102,241,0.08); border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; width: auto;">
            <i data-lucide="tag" style="width: 11px; height: 11px;"></i> Set Make
          </button>
        </div>
      </div>
    </div>

    <!-- Indent-wise Quantity Splitting -->
    <div style="margin-bottom: 20px;">
      ${renderMaterialIndentSplitHtml(item.name, item.unit)}
    </div>

    <!-- Where Used Location Breakdown Pills -->
    <div style="margin-bottom: 20px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border-color); border-radius: 12px; padding: 14px 16px;">
      <h3 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
        <i data-lucide="map-pin" style="color: var(--primary); width: 16px; height: 16px;"></i>
        Where Used — Location Breakdown
      </h3>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        ${locationPillsHtml}
      </div>
    </div>

    <!-- Purchased Receipts History Table -->
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
        <i data-lucide="shopping-cart" style="color: var(--success); width: 16px; height: 16px;"></i>
        Purchase Receipts &amp; Invoices (${purchases.length})
      </h3>
      <div style="max-height: 180px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 10px;">
        <table class="data-table" style="font-size: 0.82rem; width: 100%;">
          <thead>
            <tr>
              <th>Indent No</th>
              <th>Date Received</th>
              <th>Make</th>
              <th>Purchased Qty</th>
              <th>Rate</th>
              <th>Amount</th>
              <th>Source</th>
              <th>Invoice</th>
            </tr>
          </thead>
          <tbody>
            ${purchasesRowsHtml}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Embedded Invoice PDF Preview Section -->
    ${pdfViewerHtml}

    <!-- Usage History Log Table -->
    <div style="margin-top: 20px;">
      <h3 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
        <i data-lucide="activity" style="color: var(--warning); width: 16px; height: 16px;"></i>
        Maintenance Usage Logs (${usages.length})
      </h3>
      <div style="max-height: 180px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 10px;">
        <table class="data-table" style="font-size: 0.82rem; width: 100%;">
          <thead>
            <tr>
              <th>Date Used</th>
              <th>Quantity Used</th>
              <th>Where Used (Location)</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            ${usagesRowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Wire invoice buttons inside purchase rows
  body.querySelectorAll('.btn-view-mat-inv').forEach(btn => {
    btn.onclick = () => {
      const pIdx = parseInt(btn.getAttribute('data-pindex'), 10);
      if (purchases[pIdx]) openInvoiceViewerModal(purchases[pIdx]);
    };
  });

  // Wire Edit Make button on individual purchase receipt rows
  body.querySelectorAll('.btn-matdetail-edit-make').forEach(btn => {
    btn.onclick = () => {
      const realIndex = parseInt(btn.getAttribute('data-realindex'), 10);
      if (!isNaN(realIndex) && state.purchases[realIndex]) {
        openEditMakeModal('purchase', realIndex);
      }
    };
  });

  // Wire Set Make button on top material summary card
  body.querySelectorAll('.btn-mat-edit-make-global').forEach(btn => {
    btn.onclick = () => {
      const mat = btn.getAttribute('data-material');
      if (mat) openEditMakeForMaterial(mat);
    };
  });

  lucide.createIcons();
  modal.classList.add('active');
}

/** Close Material 360 Traceability Modal */
function closeMaterialDetailModal() {
  const modal = document.getElementById('material-detail-modal');
  if (modal) modal.classList.remove('active');
}

// ─────────────────────────────────────────────────────────────────
// Reupload / Change Invoice Modal & Handling Functions
// ─────────────────────────────────────────────────────────────────

let currentReuploadState = { record: null, type: 'purchase', selectedFile: null, mode: 'file' };

/** Open Reupload / Change Invoice Modal specifically for an Indent */
function openReuploadInvoiceModalForIndent(indentNo) {
  if (!indentNo) return;
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can upload or edit PO / Invoices.', 'error');
    return;
  }
  const rows = state.purchases.filter(p =>
    (p['Indent No'] || '').toString().trim() === indentNo.toString().trim()
  );

  currentReuploadState = {
    record: null,
    type: 'indent',
    indentNo: indentNo,
    rows: rows,
    selectedFile: null,
    mode: 'url'
  };

  const modal = document.getElementById('reupload-invoice-modal');
  if (!modal) return;

  const titleText = document.getElementById('reupload-modal-title-text');
  const scopeLabel = document.getElementById('reupload-scope-label');
  const matNameEl = document.getElementById('reupload-mat-name');
  const indentNoEl = document.getElementById('reupload-indent-no');
  const fileInput = document.getElementById('reupload-file-input');
  const urlInput = document.getElementById('reupload-url-input');
  const fileInfo = document.getElementById('reupload-file-info');
  const fileNameSpan = document.getElementById('reupload-file-name');

  if (titleText) titleText.textContent = `Attach PO / Invoice for Indent ${indentNo}`;
  if (scopeLabel) scopeLabel.textContent = `Target Indent:`;
  if (matNameEl) matNameEl.textContent = `All ${rows.length} material item${rows.length !== 1 ? 's' : ''} in Indent`;
  if (indentNoEl) indentNoEl.textContent = `Indent: ${indentNo}`;

  const currentLink = findIndentPoLink(indentNo, rows);
  if (urlInput) urlInput.value = (currentLink && !currentLink.startsWith('data:') && !currentLink.startsWith('idb:')) ? currentLink : '';
  if (fileInput) fileInput.value = '';
  if (fileInfo) fileInfo.style.display = 'none';
  if (fileNameSpan) fileNameSpan.textContent = '';

  switchReuploadTab('url');
  modal.classList.add('active');
  lucide.createIcons();
}

/** Open Reupload / Change Invoice Modal */
function openReuploadInvoiceModal(p, type = 'purchase') {
  if (!p) return;
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can upload or edit PO / Invoices.', 'error');
    return;
  }
  
  currentReuploadState = { record: p, type: type, indentNo: p["Indent No"] || p.indentNo || '', selectedFile: null, mode: 'url' };

  const modal = document.getElementById('reupload-invoice-modal');
  if (!modal) return;

  const titleText = document.getElementById('reupload-modal-title-text');
  const scopeLabel = document.getElementById('reupload-scope-label');
  const matNameEl = document.getElementById('reupload-mat-name');
  const indentNoEl = document.getElementById('reupload-indent-no');
  const fileInput = document.getElementById('reupload-file-input');
  const urlInput = document.getElementById('reupload-url-input');
  const fileInfo = document.getElementById('reupload-file-info');
  const fileNameSpan = document.getElementById('reupload-file-name');

  if (titleText) titleText.textContent = 'Attach / Upload PO or Invoice Document';
  if (scopeLabel) scopeLabel.textContent = 'Target Material:';
  if (matNameEl) matNameEl.textContent = p["Material Name"] || p.name || 'N/A';
  if (indentNoEl) indentNoEl.textContent = `Indent: ${p["Indent No"] || p.indentNo || 'N/A'}`;

  const currentLink = getEffectiveItemPoLink(p);
  if (urlInput) urlInput.value = (currentLink && !currentLink.startsWith('data:') && !currentLink.startsWith('idb:')) ? currentLink : '';
  if (fileInput) fileInput.value = '';
  if (fileInfo) fileInfo.style.display = 'none';
  if (fileNameSpan) fileNameSpan.textContent = '';

  // Set default active tab (Google Drive URL)
  switchReuploadTab('url');

  modal.classList.add('active');
  lucide.createIcons();
}

/** Close Reupload / Change Invoice Modal */
function closeReuploadInvoiceModal() {
  const modal = document.getElementById('reupload-invoice-modal');
  if (modal) modal.classList.remove('active');
  currentReuploadState = { record: null, type: 'purchase', selectedFile: null, mode: 'file' };
}

/** Switch between File upload tab and URL tab */
function switchReuploadTab(mode) {
  currentReuploadState.mode = mode;

  const fileTab = document.getElementById('tab-mode-file');
  const urlTab = document.getElementById('tab-mode-url');
  const fileContainer = document.getElementById('reupload-file-container');
  const urlContainer = document.getElementById('reupload-url-container');

  if (mode === 'file') {
    if (fileTab) {
      fileTab.classList.add('active');
      fileTab.style.background = 'rgba(99,102,241,0.15)';
      fileTab.style.borderColor = 'rgba(99,102,241,0.4)';
      fileTab.style.color = '#818cf8';
    }
    if (urlTab) {
      urlTab.classList.remove('active');
      urlTab.style.background = 'none';
      urlTab.style.borderColor = 'var(--border-color)';
      urlTab.style.color = 'var(--text-secondary)';
    }
    if (fileContainer) fileContainer.style.display = 'block';
    if (urlContainer) urlContainer.style.display = 'none';
  } else {
    if (urlTab) {
      urlTab.classList.add('active');
      urlTab.style.background = 'rgba(99,102,241,0.15)';
      urlTab.style.borderColor = 'rgba(99,102,241,0.4)';
      urlTab.style.color = '#818cf8';
    }
    if (fileTab) {
      fileTab.classList.remove('active');
      fileTab.style.background = 'none';
      fileTab.style.borderColor = 'var(--border-color)';
      fileTab.style.color = 'var(--text-secondary)';
    }
    if (urlContainer) urlContainer.style.display = 'block';
    if (fileContainer) fileContainer.style.display = 'none';
  }
}

/** Initialize Reupload Invoice Modal Event Listeners */
function setupReuploadInvoiceModalEvents() {
  const closeBtn = document.getElementById('close-reupload-modal-btn');
  const cancelBtn = document.getElementById('cancel-reupload-btn');
  const detachBtn = document.getElementById('reupload-detach-btn');
  const form = document.getElementById('reupload-invoice-form');
  const fileTab = document.getElementById('tab-mode-file');
  const urlTab = document.getElementById('tab-mode-url');
  const dropzone = document.getElementById('reupload-dropzone');
  const fileInput = document.getElementById('reupload-file-input');
  const removeFileBtn = document.getElementById('remove-selected-file-btn');

  if (closeBtn) closeBtn.onclick = closeReuploadInvoiceModal;
  if (cancelBtn) cancelBtn.onclick = closeReuploadInvoiceModal;

  if (fileTab) fileTab.onclick = () => switchReuploadTab('file');
  if (urlTab) urlTab.onclick = () => switchReuploadTab('url');

  if (dropzone && fileInput) {
    dropzone.onclick = () => fileInput.click();

    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    };
    dropzone.ondragleave = () => dropzone.classList.remove('dragover');
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleReuploadFileSelected(e.dataTransfer.files[0]);
      }
    };

    fileInput.onchange = () => {
      if (fileInput.files && fileInput.files[0]) {
        handleReuploadFileSelected(fileInput.files[0]);
      }
    };
  }

  if (removeFileBtn) {
    removeFileBtn.onclick = (e) => {
      e.stopPropagation();
      currentReuploadState.selectedFile = null;
      if (fileInput) fileInput.value = '';
      const fileInfo = document.getElementById('reupload-file-info');
      if (fileInfo) fileInfo.style.display = 'none';
    };
  }

  if (detachBtn) {
    detachBtn.onclick = () => {
      if (currentReuploadState.type === 'indent') {
        const indent = currentReuploadState.indentNo;
        deleteIndentInvoice(indent);
        closeReuploadInvoiceModal();
      } else {
        if (!currentReuploadState.record) return;
        deleteItemInvoice(currentReuploadState.record);
        closeReuploadInvoiceModal();
      }
    };
  }

  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      submitReuploadInvoice();
    };
  }
}

function handleReuploadFileSelected(file) {
  if (file.size > 10 * 1024 * 1024) {
    showToast('Selected file exceeds 10MB limit. Please choose a smaller PDF or image.', 'error');
    return;
  }
  currentReuploadState.selectedFile = file;

  const fileInfo = document.getElementById('reupload-file-info');
  const fileNameSpan = document.getElementById('reupload-file-name');
  if (fileNameSpan) fileNameSpan.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  if (fileInfo) {
    fileInfo.style.display = 'flex';
    lucide.createIcons();
  }
}

/** Save updated invoice link or file to local state & cloud */
function submitReuploadInvoice() {
  if (state.currentUser === 'staff') {
    showToast('Staff users have read-only access. Only administrators can upload or edit PO / Invoices.', 'error');
    return;
  }
  if (currentReuploadState.type === 'indent') {
    const indentNo = currentReuploadState.indentNo;
    if (!indentNo) return;

    if (currentReuploadState.mode === 'file' && currentReuploadState.selectedFile) {
      const file = currentReuploadState.selectedFile;
      const reader = new FileReader();
      reader.onload = function (e) {
        const dataUrl = e.target.result;
        if (state.appMode === 'cloud' && state.sheetUrl) {
          uploadIndentFileToCloudAndSave(indentNo, file.name, dataUrl);
        } else {
          saveIndentInvoiceUpdate(indentNo, dataUrl, file.name);
        }
      };
      reader.onerror = function () {
        showToast('Failed to read file.', 'error');
      };
      reader.readAsDataURL(file);
    } else {
      const urlInput = document.getElementById('reupload-url-input');
      const newUrl = urlInput ? urlInput.value.trim() : '';
      saveIndentInvoiceUpdate(indentNo, newUrl);
    }
    return;
  }

  const p = currentReuploadState.record;
  if (!p) return;

  if (currentReuploadState.mode === 'file' && currentReuploadState.selectedFile) {
    const file = currentReuploadState.selectedFile;
    const reader = new FileReader();
    reader.onload = function (e) {
      const dataUrl = e.target.result;
      
      // If Cloud connection is active, also trigger Apps Script upload
      if (state.appMode === 'cloud' && state.sheetUrl) {
        uploadFileToCloudAndSave(p, file.name, dataUrl);
      } else {
        saveInvoiceLinkUpdate(dataUrl);
      }
    };
    reader.onerror = function () {
      showToast('Failed to read file.', 'error');
    };
    reader.readAsDataURL(file);
  } else {
    // URL Mode
    const urlInput = document.getElementById('reupload-url-input');
    const newUrl = urlInput ? urlInput.value.trim() : '';
    saveInvoiceLinkUpdate(newUrl);
  }
}

/** Upload Indent-level file via POST to Google Apps Script and update PO Link for all items in that Indent */
function uploadIndentFileToCloudAndSave(indentNo, fileName, base64DataUrl) {
  setSyncingAnimation(true);
  const oldDocUrl = findIndentPoLink(indentNo) || '';
  const payload = {
    action: 'updateInvoice',
    indentNo: indentNo,
    materialName: '',
    fileName: fileName,
    fileData: base64DataUrl,
    oldFileUrl: oldDocUrl
  };

  const indentKey = 'indent_' + indentNo;
  // Save locally in IndexedDB immediately so it is available right away without holding base64 in memory
  InvoiceStorage.saveInvoice(indentKey, base64DataUrl, fileName).then(() => {
    saveIndentInvoiceUpdate(indentNo, 'idb:' + indentKey, fileName);
  });

  fetch(state.sheetUrl, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
      return res.json();
    })
    .then(data => {
      setSyncingAnimation(false);
      if (data && data.status === 'success' && data.fileUrl) {
        saveIndentInvoiceUpdate(indentNo, data.fileUrl, fileName);
        showToast(`PO / Invoice uploaded to Google Drive & linked to Indent ${indentNo}! Visible on all PCs.`, 'success');
        syncWithCloud();
      } else {
        const msg = (data && data.message) ? data.message : 'Google Drive upload did not return a valid URL.';
        saveIndentInvoiceUpdate(indentNo, 'idb:' + indentKey, fileName);
        showToast(`Drive upload warning: ${msg} (Saved locally on this PC as fallback).`, 'warning');
      }
    })
    .catch(err => {
      console.error('Cloud indent file upload failed:', err);
      setSyncingAnimation(false);
      saveIndentInvoiceUpdate(indentNo, 'idb:' + indentKey, fileName);
      showToast(`Drive upload failed (${err.message || 'Network/CORS error'}). Saved on this PC only as fallback. Check Google Sheet setup.`, 'error');
    });
}

/** Save updated indent invoice link or file to local state & cloud */
async function saveIndentInvoiceUpdate(indentNo, newUrl, fileName = 'invoice.pdf') {
  if (!indentNo) return;
  const overrides = JSON.parse(localStorage.getItem('electrastock_invoice_overrides') || '{}');
  const indentKey = 'indent_' + indentNo;
  const cleanIndentKey = 'indent_' + indentNo.toLowerCase();
  let targetLink = newUrl || '';

  if (targetLink) {
    if (targetLink.startsWith('data:')) {
      await InvoiceStorage.saveInvoice(indentKey, targetLink, fileName);
      targetLink = 'idb:' + indentKey;
      overrides[indentKey] = targetLink;
    } else {
      overrides[indentKey] = targetLink;
      delete overrides[cleanIndentKey];
      if (!targetLink.startsWith('idb:')) {
        await InvoiceStorage.deleteInvoice(indentKey);
        await InvoiceStorage.deleteInvoice(cleanIndentKey);
      }
    }
  } else {
    overrides[indentKey] = '__DELETED__';
    overrides[cleanIndentKey] = '__DELETED__';
    await InvoiceStorage.deleteInvoice(indentKey);
    await InvoiceStorage.deleteInvoice(cleanIndentKey);
  }

  // Apply to all purchases matching this indent
  state.purchases.forEach(p => {
    if ((p["Indent No"] || p.indentNo || '').toString().trim().toLowerCase() === indentNo.toLowerCase().trim()) {
      p["PO Link"] = targetLink;
      p["poLink"] = targetLink;
      p["fileUrl"] = targetLink;
      const key = makePurchaseKey(p);
      if (targetLink) {
        overrides[key] = targetLink;
      } else {
        overrides[key] = '__DELETED__';
        InvoiceStorage.deleteInvoice(key);
      }
    }
  });

  try {
    localStorage.setItem('electrastock_invoice_overrides', JSON.stringify(overrides));
  } catch (e) {
    console.warn('LocalStorage quota warning:', e);
  }

  savePurchasesToLocalStorage();

  // If in cloud mode, sync update or delete to Cloud
  if (state.appMode === 'cloud' && state.sheetUrl) {
    if (targetLink.startsWith('https://') || targetLink.startsWith('http://')) {
      const query = new URLSearchParams({
        action: 'updateInvoice',
        indentNo: indentNo,
        materialName: '',
        poLink: targetLink,
        deleteAllForIndent: 'true',
        _t: Date.now().toString()
      });
      fetch(`${state.sheetUrl}?${query.toString()}`, { method: 'GET', mode: 'cors', redirect: 'follow' })
        .then(() => syncWithCloud())
        .catch(err => console.error('Cloud indent invoice update warning:', err));
    } else if (!targetLink) {
      const query = new URLSearchParams({
        action: 'deleteInvoice',
        indentNo: indentNo,
        materialName: '',
        deleteAllForIndent: 'true',
        _t: Date.now().toString()
      });
      fetch(`${state.sheetUrl}?${query.toString()}`, { method: 'GET', mode: 'cors', cache: 'no-cache', redirect: 'follow' })
        .then(() => syncWithCloud())
        .catch(err => console.error('Cloud indent invoice delete warning:', err));
    }
  }

  closeReuploadInvoiceModal();
  updateUI();

  // Re-render Indent No lookup if open
  const indentSelect = document.getElementById('dashboard-indent-lookup-select');
  if (indentSelect && indentSelect.value === indentNo) {
    renderIndentLookupResult(indentNo);
  }

  showToast(targetLink ? `PO / Invoice attached successfully to Indent ${indentNo}!` : `Invoice detached from Indent ${indentNo}.`, 'success');

  // Automatically open document viewer if a file or URL was provided
  if (targetLink) {
    openIndentInvoiceViewerModal(indentNo);
  }
}

/** Save updated invoice link or file to local state & cloud */
async function saveInvoiceLinkUpdate(newUrl) {
  const p = currentReuploadState.record;
  if (!p) return;

  const indentNo = p["Indent No"] || p.indentNo || '';
  const matName = p["Material Name"] || p.name || '';
  const key = makePurchaseKey(p);
  let targetLink = newUrl || '';

  // 1. Update in-memory record (never hold raw base64 data URLs)
  if (targetLink.startsWith('data:')) {
    await InvoiceStorage.saveInvoice(key, targetLink, currentReuploadState.selectedFile ? currentReuploadState.selectedFile.name : 'invoice.pdf');
    targetLink = 'idb:' + key;
  }
  p["PO Link"] = targetLink;
  p["poLink"] = targetLink;
  p["fileUrl"] = targetLink;

  // 2. Update dedicated invoice override store & IndexedDB
  let overrides = {};
  try {
    overrides = JSON.parse(localStorage.getItem('electrastock_invoice_overrides') || '{}');
  } catch (e) {
    overrides = {};
  }

  if (targetLink) {
    overrides[key] = targetLink;
    if (!targetLink.startsWith('idb:')) {
      await InvoiceStorage.deleteInvoice(key);
    }
  } else {
    overrides[key] = '__DELETED__';
    await InvoiceStorage.deleteInvoice(key);
  }

  try {
    localStorage.setItem('electrastock_invoice_overrides', JSON.stringify(overrides));
  } catch (e) {
    console.warn('LocalStorage quota warning:', e);
  }

  // 3. If this was a prev stock entry, update in electrastock_prev_stocks
  if (p['_prevId']) {
    let prevStocks = [];
    try {
      prevStocks = JSON.parse(localStorage.getItem('electrastock_prev_stocks') || '[]');
    } catch (e) {}
    const rec = prevStocks.find(r => r.id === p['_prevId']);
    if (rec) {
      rec.poLink = targetLink;
      try {
        localStorage.setItem('electrastock_prev_stocks', JSON.stringify(prevStocks));
      } catch (e) {}
    }
  }

  // Save purchases array safely to localStorage
  savePurchasesToLocalStorage();

  // 4. Send to Cloud if connected
  if (state.appMode === 'cloud' && state.sheetUrl) {
    if (targetLink.startsWith('https://') || targetLink.startsWith('http://')) {
      const query = new URLSearchParams({
        action: 'updateInvoice',
        indentNo: indentNo,
        materialName: matName,
        poLink: targetLink,
        _t: Date.now().toString()
      });
      fetch(`${state.sheetUrl}?${query.toString()}`, { method: 'GET', mode: 'cors', redirect: 'follow' })
        .then(() => syncWithCloud())
        .catch(err => console.error('Cloud invoice update warning:', err));
    } else if (!targetLink) {
      const query = new URLSearchParams({
        action: 'deleteInvoice',
        indentNo: indentNo,
        materialName: matName,
        _t: Date.now().toString()
      });
      fetch(`${state.sheetUrl}?${query.toString()}`, { method: 'GET', mode: 'cors', cache: 'no-cache', redirect: 'follow' })
        .then(() => syncWithCloud())
        .catch(err => console.error('Cloud invoice delete warning:', err));
    }
  }

  closeReuploadInvoiceModal();
  updateUI();

  // Re-render Indent No lookup if open
  const indentSelect = document.getElementById('dashboard-indent-lookup-select');
  if (indentSelect && indentSelect.value === indentNo) {
    renderIndentLookupResult(indentNo);
  }

  showToast(targetLink ? `Invoice document updated successfully for "${matName}"!` : `Invoice detached successfully from "${matName}".`, 'success');

  // Refresh Invoice Viewer Modal if currently active
  const invoiceModal = document.getElementById('invoice-viewer-modal');
  if (invoiceModal && invoiceModal.classList.contains('active')) {
    if (currentViewerContext && currentViewerContext.type === 'indent' && currentViewerContext.indentNo) {
      openIndentInvoiceViewerModal(currentViewerContext.indentNo);
    } else {
      openInvoiceViewerModal(p);
    }
  }
}

/** Upload file via POST to Google Apps Script and update PO Link */
function uploadFileToCloudAndSave(p, fileName, base64DataUrl) {
  setSyncingAnimation(true);
  const oldDocUrl = getEffectiveItemPoLink(p) || '';
  const payload = {
    action: 'updateInvoice',
    indentNo: p["Indent No"] || p.indentNo || '',
    materialName: p["Material Name"] || p.name || '',
    fileName: fileName,
    fileData: base64DataUrl,
    oldFileUrl: oldDocUrl
  };

  // Save locally into IndexedDB immediately so it never disappears
  const key = makePurchaseKey(p);
  InvoiceStorage.saveInvoice(key, base64DataUrl, fileName).then(() => {
    saveInvoiceLinkUpdate('idb:' + key);
  });

  fetch(state.sheetUrl, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
      return res.json();
    })
    .then(data => {
      setSyncingAnimation(false);
      if (data && data.status === 'success' && data.fileUrl) {
        saveInvoiceLinkUpdate(data.fileUrl);
        showToast('PO / Invoice uploaded to Google Drive & linked successfully! Visible on all PCs.', 'success');
        syncWithCloud();
      } else {
        const msg = (data && data.message) ? data.message : 'Google Drive upload did not return a valid URL.';
        saveInvoiceLinkUpdate('idb:' + key);
        showToast(`Drive upload warning: ${msg} (Saved locally on this PC as fallback).`, 'warning');
      }
    })
    .catch(err => {
      console.error('Cloud file upload failed:', err);
      setSyncingAnimation(false);
      saveInvoiceLinkUpdate('idb:' + key);
      showToast(`Drive upload failed (${err.message || 'Network/CORS error'}). Saved on this PC only as fallback. Check Google Sheet setup.`, 'error');
    });
}

/**
 * Scan all purchases for locally-trapped invoices in IndexedDB (idb:)
 * and push them directly to Google Drive so they become permanently visible across all PCs!
 */
async function syncLocalInvoicesToDrive() {
  if (state.appMode !== 'cloud' || !state.sheetUrl) {
    showToast('Please connect to Google Sheets in Settings before syncing to Google Drive.', 'warning');
    return;
  }

  setSyncingAnimation(true);
  showToast('Scanning for local invoices to upload to Google Drive...', 'info');

  const itemsToUpload = [];
  const processedKeys = new Set();

  for (let i = 0; i < state.purchases.length; i++) {
    const p = state.purchases[i];
    const key = makePurchaseKey(p);
    const link = (p["PO Link"] || p.poLink || p.fileUrl || '').toString().trim();
    const indentNo = (p["Indent No"] || p.indentNo || '').toString().trim();
    const indentKey = 'indent_' + indentNo;

    let targetStoreKey = null;
    if (link.startsWith('idb:')) {
      targetStoreKey = link.replace('idb:', '');
    } else if (!link || !link.startsWith('http')) {
      if (await InvoiceStorage.hasInvoice(key)) {
        targetStoreKey = key;
      } else if (indentNo && await InvoiceStorage.hasInvoice(indentKey)) {
        targetStoreKey = indentKey;
      }
    }

    if (targetStoreKey && !processedKeys.has(targetStoreKey)) {
      processedKeys.add(targetStoreKey);
      const fileData = await InvoiceStorage.getInvoice(targetStoreKey);
      if (fileData) {
        itemsToUpload.push({
          record: p,
          storeKey: targetStoreKey,
          fileData: fileData,
          fileName: targetStoreKey.startsWith('indent_') ? `PO_${indentNo}.pdf` : `Invoice_${(p["Material Name"] || 'item').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`
        });
      }
    }
  }

  if (itemsToUpload.length === 0) {
    setSyncingAnimation(false);
    showToast('All invoices are already uploaded to Google Drive! No local-only invoices found.', 'success');
    return;
  }

  showToast(`Found ${itemsToUpload.length} local invoice(s). Uploading to Google Drive now...`, 'info');

  let successCount = 0;
  let failCount = 0;
  const failureReasons = [];

  for (const item of itemsToUpload) {
    try {
      const isIndent = item.storeKey.startsWith('indent_');
      const payload = {
        action: 'updateInvoice',
        indentNo: item.record["Indent No"] || item.record.indentNo || '',
        materialName: isIndent ? '' : (item.record["Material Name"] || item.record.name || ''),
        fileName: item.fileName,
        fileData: item.fileData
      };

      const res = await fetch(state.sheetUrl, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });

      const rawText = await res.text();
      let data = null;
      try {
        data = JSON.parse(rawText);
      } catch (jsonErr) {
        throw new Error(`Google returned non-JSON response (likely authorization or HTML error): ${rawText.substring(0, 150)}`);
      }

      if (data && data.status === 'success' && data.fileUrl) {
        successCount++;
        const driveUrl = data.fileUrl;
        
        // Update local state and override store
        if (isIndent) {
          await saveIndentInvoiceUpdate(payload.indentNo, driveUrl, item.fileName);
        } else {
          currentReuploadState.record = item.record;
          await saveInvoiceLinkUpdate(driveUrl);
        }
        await InvoiceStorage.deleteInvoice(item.storeKey);
      } else {
        const errorMsg = (data && data.message) ? data.message : 'No Google Drive URL returned';
        failureReasons.push(errorMsg);
        failCount++;
      }
    } catch (e) {
      console.error('Error uploading local invoice to Drive:', item.storeKey, e);
      failureReasons.push(e.message || 'Network/CORS error');
      failCount++;
    }
  }

  setSyncingAnimation(false);
  if (successCount > 0) {
    showToast(`Successfully uploaded ${successCount} PO/invoice document(s) to Google Drive! They are now visible on all PCs.`, 'success');
    syncWithCloud();
  }
  
  if (failCount > 0) {
    const uniqueErrors = Array.from(new Set(failureReasons)).join('; ');
    console.error('Drive upload errors:', uniqueErrors);
    showToast(`Upload issue: ${uniqueErrors}`, 'error', 9000);
    alert(`Google Drive Upload Notice:\n\n${uniqueErrors}\n\nHow to Fix in 1 minute:\n1. Open your Google Sheet -> Extensions -> Apps Script.\n2. Copy the updated code from 'google-apps-script.js' and paste it in the editor.\n3. In the toolbar function dropdown, select 'testDrivePermissions' and click 'Run'.\n4. Click 'Review permissions' -> Select your Google Account -> Advanced -> Allow.\n5. Click 'Deploy' -> 'Manage deployments' -> Edit (pencil icon) -> choose 'New version' -> click 'Deploy'.`);
  }
}



