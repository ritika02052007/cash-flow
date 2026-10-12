'use strict';

/* =====================================================================
   CASH-FLOW  |  Salary & Expense Tracker  (Vanilla JS)
   ---------------------------------------------------------------------
   How it works:
   1. ONE state object holds everything (salary, expenses, currency).
   2. Any change -> update state -> saveState() -> render().
   3. render() redraws the whole UI from state, so the screen can never
      drift out of sync with the data.
   4. Money is ALWAYS stored in the base currency (INR). The selected
      currency only changes how numbers are shown (and what the user
      types), by multiplying / dividing with an exchange rate.
   ===================================================================== */

/* ---------- Constants ---------- */
const STORAGE_KEY = 'cashflow:state:v1';     // salary + expenses + currency
const RATE_KEY = 'cashflow:rates:v1';        // cached exchange rates
const BASE_CURRENCY = 'INR';                 // all stored amounts are in INR
const RATE_TTL_MS = 60 * 60 * 1000;          // reuse cached rates for 1 hour
const ALERT_THRESHOLD = 0.10;                // alert below 10% of salary
const MAX_AMOUNT = 1e12;                     // sanity limit for inputs

// Free, keyless API (second URL is the newer home of the same service)
const RATE_ENDPOINTS = [
  'https://api.frankfurter.app/latest',
  'https://api.frankfurter.dev/v1/latest'
];

// locale decides number formatting, decimals decides rounding
const CURRENCIES = {
  INR: { locale: 'en-IN', decimals: 2 },
  USD: { locale: 'en-US', decimals: 2 },
  EUR: { locale: 'en-IE', decimals: 2 },
  GBP: { locale: 'en-GB', decimals: 2 },
  JPY: { locale: 'en-US', decimals: 0 }
};

const COLOR_REMAINING = '#0f766e';
const COLOR_EXPENSE = '#d9822b';
const COLOR_EMPTY = '#cbd6d4';

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>' +
  '<path d="M10 11v6M14 11v6"/></svg>';

/* ---------- App state ---------- */
let state = {
  salary: 0,                 // in BASE_CURRENCY
  expenses: [],              // [{ id, name, amount }]  amount in BASE_CURRENCY
  currency: BASE_CURRENCY    // currency currently displayed
};

let rates = { [BASE_CURRENCY]: 1 };  // how many units of X equal 1 INR
let rateDate = null;                 // date the rates were published
let chart = null;                    // single Chart.js instance (never duplicated)
let chartIsEmpty = true;             // used by the tooltip
let toastTimer = null;

/* ---------- Small helpers ---------- */
const $ = (id) => document.getElementById(id);

const getRate = () => rates[state.currency] || 1;
const toDisplay = (baseAmount) => baseAmount * getRate();   // INR -> shown currency
const toBase = (shownAmount) => shownAmount / getRate();    // typed value -> INR

// Format a number that is ALREADY in the displayed currency
function formatShown(shownAmount) {
  const cfg = CURRENCIES[state.currency];
  return shownAmount.toLocaleString(cfg.locale, {
    style: 'currency',
    currency: state.currency,
    minimumFractionDigits: cfg.decimals,
    maximumFractionDigits: cfg.decimals
  });
}

// Format a stored (INR) amount in the displayed currency
const formatMoney = (baseAmount) => formatShown(toDisplay(baseAmount));

// Plain-text version for the PDF (default PDF fonts cannot draw symbols like the rupee sign)
function formatPlain(baseAmount) {
  const cfg = CURRENCIES[state.currency];
  const number = toDisplay(baseAmount).toLocaleString('en-US', {
    minimumFractionDigits: cfg.decimals,
    maximumFractionDigits: cfg.decimals
  });
  return `${state.currency} ${number}`;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

/* =====================================================================
   VALIDATION
   ===================================================================== */

// Convert raw input text to a number. DOM inputs return STRINGS, so we
// must use Number() before doing any math (otherwise 10 + 10 = "1010").
function parseAmount(raw, label) {
  const text = String(raw).trim();
  if (text === '') return { error: `${label} is required.` };

  const value = Number(text);
  if (!Number.isFinite(value)) return { error: `${label} must be a valid number.` };
  if (value < 0) return { error: `${label} cannot be negative.` };
  if (value === 0) return { error: `${label} must be greater than 0.` };
  if (value > MAX_AMOUNT) return { error: `${label} is too large.` };

  return { value };
}

// Show (or clear) validation errors for one form.
// problems = [{ input, message }]. Empty array = everything is valid.
function applyValidation(errorEl, inputs, problems) {
  inputs.forEach((input) => {
    const bad = problems.some((p) => p.input === input);
    if (bad) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  });

  errorEl.textContent = problems.map((p) => p.message).join('\n');
  errorEl.hidden = problems.length === 0;

  if (problems.length > 0) problems[0].input.focus();
}

/* =====================================================================
   PERSISTENCE (localStorage)
   ===================================================================== */

// localStorage only stores strings -> JSON.stringify on save, JSON.parse on load
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Could not save to localStorage:', err);
  }
}

function loadState() {
  const fallback = { salary: 0, expenses: [], currency: BASE_CURRENCY };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;                    // first visit

    const data = JSON.parse(raw);

    // Validate everything: corrupted or edited storage must never break the app
    const salary = Number.isFinite(data.salary) && data.salary >= 0 ? data.salary : 0;
    const expenses = Array.isArray(data.expenses)
      ? data.expenses.filter((e) =>
          e && typeof e.id === 'string' && typeof e.name === 'string' &&
          Number.isFinite(e.amount) && e.amount > 0)
      : [];
    const currency = CURRENCIES[data.currency] ? data.currency : BASE_CURRENCY;

    return { salary, expenses, currency };
  } catch (err) {
    console.error('Corrupted saved data, starting fresh:', err);
    return fallback;
  }
}

/* =====================================================================
   CORE LOGIC
   ===================================================================== */

// Total Salary - Total Expenses = Remaining Balance
function calculateTotals() {
  const totalExpenses = state.expenses.reduce((sum, e) => sum + e.amount, 0);
  // round to 6 decimals so floating-point noise never shows as "-0.00"
  const remaining = Math.round((state.salary - totalExpenses) * 1e6) / 1e6;
  return { salary: state.salary, totalExpenses, remaining };
}

function isCritical(totals) {
  return totals.salary > 0 && totals.remaining < totals.salary * ALERT_THRESHOLD;
}

function setSalary(event) {
  if (event) event.preventDefault();
  const input = $('salary-input');

  const result = parseAmount(input.value, 'Total salary');
  if (result.error) {
    applyValidation($('salary-error'), [input], [{ input, message: result.error }]);
    return;
  }

  applyValidation($('salary-error'), [input], []);   // valid -> clear error
  state.salary = toBase(result.value);               // store in INR
  input.value = '';
  saveState();
  render();
}

function addExpense(event) {
  if (event) event.preventDefault();
  const nameInput = $('expense-name');
  const amountInput = $('expense-amount');
  const problems = [];

  const name = nameInput.value.trim();
  if (name === '') problems.push({ input: nameInput, message: 'Expense name is required.' });

  const result = parseAmount(amountInput.value, 'Expense amount');
  if (result.error) problems.push({ input: amountInput, message: result.error });

  applyValidation($('expense-error'), [nameInput, amountInput], problems);
  if (problems.length > 0) return;                   // block the action

  state.expenses.push({ id: makeId(), name, amount: toBase(result.value) });
  nameInput.value = '';
  amountInput.value = '';
  nameInput.focus();
  saveState();
  render();
}

function deleteExpense(id) {
  state.expenses = state.expenses.filter((e) => e.id !== id);
  saveState();
  render();
}

/* =====================================================================
   CURRENCY (exchange-rate API)
   ===================================================================== */

function readRateCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(RATE_KEY));
    if (cached && cached.rates && cached.fetchedAt) return cached;
  } catch (err) { /* ignore corrupted cache */ }
  return null;
}

function applyRates(payload) {
  rates = { [BASE_CURRENCY]: 1 };
  Object.keys(CURRENCIES).forEach((code) => {
    const value = payload.rates[code];
    if (Number.isFinite(value) && value > 0) rates[code] = value;
  });
  rateDate = payload.date || null;
}

// Returns true when usable rates are loaded (fresh, cached, or stale-cached)
async function fetchRate() {
  const cached = readRateCache();

  // Cache hit: no network call needed
  if (cached && Date.now() - cached.fetchedAt < RATE_TTL_MS) {
    applyRates(cached);
    return true;
  }

  const targets = Object.keys(CURRENCIES).filter((c) => c !== BASE_CURRENCY).join(',');

  for (const endpoint of RATE_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}?from=${BASE_CURRENCY}&to=${targets}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (!data || typeof data.rates !== 'object') throw new Error('Unexpected response');

      const payload = { rates: data.rates, date: data.date, fetchedAt: Date.now() };
      try { localStorage.setItem(RATE_KEY, JSON.stringify(payload)); } catch (e) { /* ignore */ }
      applyRates(payload);
      return true;
    } catch (err) {
      console.error(`Rate fetch failed (${endpoint}):`, err);
    }
  }

  // All requests failed: fall back to an older cached rate if we have one
  if (cached) {
    applyRates(cached);
    return true;
  }
  return false;
}

async function onCurrencyChange(event) {
  const select = event.target;
  const next = select.value;
  const previous = state.currency;

  select.disabled = true;
  const ok = next === BASE_CURRENCY ? true : await fetchRate();
  select.disabled = false;

  if (!ok || (next !== BASE_CURRENCY && !rates[next])) {
    select.value = previous;                          // revert the dropdown
    showToast("Couldn't load exchange rates. Check your connection and try again.");
    return;
  }

  state.currency = next;
  saveState();
  render();
}

/* =====================================================================
   RENDERING  (everything on screen is redrawn from state)
   ===================================================================== */

function render() {
  const totals = calculateTotals();
  renderSummary(totals);
  renderAlert(totals);
  renderExpenseList();
  renderCurrencyUI();
  updateChart(totals);
}

function renderSummary(totals) {
  const balanceEl = $('balance');
  balanceEl.textContent = formatMoney(totals.remaining);
  balanceEl.classList.toggle('is-critical', isCritical(totals));

  $('salary-display').textContent = formatMoney(totals.salary);
  $('expenses-display').textContent = formatMoney(totals.totalExpenses);

  // Show the math so it is easy to verify
  $('equation').textContent =
    `${formatMoney(totals.salary)} \u2212 ${formatMoney(totals.totalExpenses)} = ${formatMoney(totals.remaining)}`;

  // Sub-line under the balance
  let sub;
  if (totals.salary <= 0) {
    sub = 'Set your total salary to start tracking.';
  } else if (totals.remaining < 0) {
    sub = 'Overspent: expenses are higher than your salary.';
  } else {
    // floor() so "9%" always matches the "below 10%" alert rule
    sub = `${Math.floor((totals.remaining / totals.salary) * 100)}% of your salary is left.`;
  }
  $('balance-sub').textContent = sub;
}

function renderAlert(totals) {
  const banner = $('alert-banner');
  const critical = isCritical(totals);
  banner.hidden = !critical;

  if (critical) {
    $('alert-text').textContent = totals.remaining < 0
      ? `You have overspent by ${formatMoney(-totals.remaining)}.`
      : `Only ${formatMoney(totals.remaining)} left, which is under 10% of your salary.`;
  }
}

function renderExpenseList() {
  const list = $('expense-list');
  list.innerHTML = '';                                 // wipe, then rebuild

  state.expenses.forEach((expense) => {
    const li = document.createElement('li');
    li.className = 'expense-item';

    const name = document.createElement('span');
    name.className = 'expense-name';
    name.textContent = expense.name;                   // textContent = safe from HTML injection
    name.title = expense.name;

    const amount = document.createElement('span');
    amount.className = 'expense-amount';
    amount.textContent = formatMoney(expense.amount);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete-btn';
    del.dataset.id = expense.id;                       // which expense to delete
    del.setAttribute('aria-label', `Delete ${expense.name}`);
    del.innerHTML = TRASH_ICON;                        // static markup only

    li.append(name, amount, del);
    list.appendChild(li);
  });

  const count = state.expenses.length;
  $('expense-count').textContent = count === 1 ? '1 item' : `${count} items`;
  $('empty-state').hidden = count > 0;
}

function renderCurrencyUI() {
  $('currency').value = state.currency;
  $('currency-hint').textContent = `Amounts you type are in ${state.currency}.`;

  if (state.currency !== BASE_CURRENCY && rates[state.currency]) {
    const rate = rates[state.currency];
    const digits = rate < 1 ? 4 : 2;
    const when = rateDate ? ` (rates from ${rateDate})` : '';
    $('rate-note').textContent =
      `1 ${BASE_CURRENCY} = ${rate.toFixed(digits)} ${state.currency}${when}. Your data is stored in ${BASE_CURRENCY}.`;
  } else {
    $('rate-note').textContent = '';
  }
}

/* =====================================================================
   CHART (Chart.js)
   ===================================================================== */

function updateChart(totals) {
  const canvas = $('chart');

  if (typeof Chart === 'undefined') {                  // CDN blocked / offline
    $('chart-note').textContent = 'Chart unavailable: Chart.js could not be loaded.';
    return;
  }

  const hasData = totals.salary > 0 || totals.totalExpenses > 0;
  chartIsEmpty = !hasData;

  // Chart values are shown in the selected currency.
  // A negative balance cannot be a pie slice, so it is clamped to 0.
  let labels, data, colors;
  if (hasData) {
    labels = ['Remaining Balance', 'Total Expenses'];
    data = [Math.max(0, toDisplay(totals.remaining)), toDisplay(totals.totalExpenses)];
    colors = [COLOR_REMAINING, COLOR_EXPENSE];
  } else {
    labels = ['No data yet'];
    data = [1];
    colors = [COLOR_EMPTY];
  }

  $('chart-note').textContent = totals.remaining < 0 && hasData
    ? `Overspent by ${formatMoney(-totals.remaining)}. The chart shows expenses only.`
    : (hasData ? '' : 'Set a salary and add expenses to see the chart.');

  // Create the chart ONCE, then only mutate its data (prevents duplicates)
  if (!chart) {
    chart = new Chart(canvas, {
      type: 'pie',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 2 }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (ctx) => chartIsEmpty
                ? ' No data yet'
                : ` ${ctx.label}: ${formatShown(ctx.parsed)}`
            }
          }
        }
      }
    });
    return;
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = data;
  chart.data.datasets[0].backgroundColor = colors;
  chart.update();
}

/* =====================================================================
   PDF REPORT (jsPDF)
   ===================================================================== */

// Helvetica cannot draw some Unicode spaces, so normalise them
const pdfSafe = (text) => String(text).replace(/[\u00a0\u202f]/g, ' ');

function downloadPDF() {
  if (!window.jspdf) {
    showToast('PDF library could not be loaded. Check your connection and reload.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const totals = calculateTotals();
  const left = 18;
  const right = 192;
  const pageBottom = 275;
  let y = 22;

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(20, 37, 44);
  doc.text('Cash-Flow Report', left, y);

  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(91, 110, 117);
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  doc.text(pdfSafe(`Generated ${today}  |  Currency: ${state.currency}`), left, y);

  // Summary
  y += 12;
  doc.setTextColor(20, 37, 44);
  doc.setFontSize(12);
  doc.text('Total salary', left, y);
  doc.text(pdfSafe(formatPlain(totals.salary)), right, y, { align: 'right' });

  // Expense table
  y += 14;
  doc.setFont('helvetica', 'bold');
  doc.text('Expenses', left, y);
  y += 3;
  doc.setDrawColor(203, 214, 212);
  doc.line(left, y, right, y);
  y += 7;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);

  if (state.expenses.length === 0) {
    doc.setTextColor(91, 110, 117);
    doc.text('No expenses recorded.', left, y);
    y += 7;
  }

  state.expenses.forEach((expense, index) => {
    // wrap long names so they never overlap the amount column
    const lines = doc.splitTextToSize(pdfSafe(`${index + 1}. ${expense.name}`), 120);
    const rowHeight = lines.length * 5.5;

    if (y + rowHeight > pageBottom) {                  // start a new page when full
      doc.addPage();
      y = 22;
    }

    doc.setTextColor(20, 37, 44);
    doc.text(lines, left, y);
    doc.text(pdfSafe(formatPlain(expense.amount)), right, y, { align: 'right' });
    y += rowHeight + 1.5;
  });

  // Totals
  if (y + 40 > pageBottom) {
    doc.addPage();
    y = 22;
  }
  y += 2;
  doc.line(left, y, right, y);
  y += 8;

  doc.setFontSize(12);
  doc.text('Total expenses', left, y);
  doc.text(pdfSafe(formatPlain(totals.totalExpenses)), right, y, { align: 'right' });

  y += 9;
  const critical = isCritical(totals);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  if (critical) doc.setTextColor(179, 32, 42);         // red when below the threshold
  doc.text('Remaining balance', left, y);
  doc.text(pdfSafe(formatPlain(totals.remaining)), right, y, { align: 'right' });

  if (critical) {
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('Warning: remaining balance is below 10% of total salary.', left, y);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`cash-flow-report-${stamp}.pdf`);
}

/* =====================================================================
   INIT
   ===================================================================== */

function bindEvents() {
  // Buttons use "click" (not the form "submit" event) so they also work inside
  // sandboxed frames where form submission is blocked.
  $('set-salary-btn').addEventListener('click', setSalary);
  $('add-expense-btn').addEventListener('click', addExpense);

  // Pressing Enter inside a field triggers the same action
  $('salary-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setSalary(e);
  });
  $('expense-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addExpense(e);
  });

  // Never let a form do a real page submit/reload
  ['salary-form', 'expense-form'].forEach((id) =>
    $(id).addEventListener('submit', (e) => e.preventDefault()));
  $('currency').addEventListener('change', onCurrencyChange);
  $('download-btn').addEventListener('click', downloadPDF);

  // Event delegation: one listener handles every delete button
  $('expense-list').addEventListener('click', (event) => {
    const button = event.target.closest('.delete-btn');
    if (button) deleteExpense(button.dataset.id);
  });

  // Remove the red highlight as soon as the user edits a field
  ['salary-input', 'expense-name', 'expense-amount'].forEach((id) => {
    $(id).addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));
  });
}

async function init() {
  state = loadState();                                 // 1. restore saved data
  bindEvents();

  // 2. If the saved currency is not INR we need a rate before the first render
  if (state.currency !== BASE_CURRENCY) {
    const ok = await fetchRate();
    if (!ok) {
      state.currency = BASE_CURRENCY;
      saveState();
      showToast('Exchange rates unavailable, showing INR instead.');
    }
  }

  render();                                            // 3. draw everything
}

init();
