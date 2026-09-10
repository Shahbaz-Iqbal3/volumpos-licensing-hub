'use strict'

const STORAGE_KEY = 'volumpos-hub-admin-v2'
const DEFAULT_BASE_URL = (window.VOLUMPOS_HUB && window.VOLUMPOS_HUB.baseUrl) || ''
const el = (id) => document.getElementById(id)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const date = (v) => v ? new Date(v).toLocaleDateString() : 'never'
let state = { baseUrl: DEFAULT_BASE_URL, secret: '' }

function showError(message) { const box = el('error'); box.textContent = message || ''; box.classList.toggle('hidden', !message) }
function showLoginError(message) { const box = el('loginError'); box.textContent = message || ''; box.classList.toggle('hidden', !message) }
function saveSession() { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)) }
function clearSession() { state = { baseUrl: DEFAULT_BASE_URL, secret: '' }; sessionStorage.removeItem(STORAGE_KEY) }

async function api(action, payload = {}) {
  if (!state.baseUrl || !state.secret) throw new Error('Authentication required')
  const response = await fetch(`${state.baseUrl.replace(/\/+$/, '')}/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': state.secret }, body: JSON.stringify({ action, ...payload }) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

async function authenticate(baseUrl, secret) {
  state = { baseUrl: baseUrl.trim().replace(/\/+$/, ''), secret }
  await api('stats')
  saveSession(); el('login').classList.add('hidden'); el('dashboard').classList.remove('hidden'); await refreshAll()
}

function renderStats(data) {
  const cards = [['Customers', data.customers], ['Licenses', data.licenses], ['Active', data.active_licenses], ['Subscriptions', data.active_subscriptions], ['Fabric', data.by_product?.FABRIC_POS || 0], ['Restaurant', data.by_product?.RESTAURANT_POS || 0]]
  el('stats').innerHTML = cards.map(([label, value]) => `<div class="panel rounded-xl p-4"><div class="text-xs text-slate-400">${label}</div><div class="text-2xl font-semibold text-white mt-1">${esc(value)}</div></div>`).join('')
}

async function refreshAll() {
  showError('')
  try { renderStats(await api('stats')); await Promise.all([loadCustomers(), loadLicenses(), loadSubscriptions()]) } catch (error) { showError(error.message); if (/Forbidden|Authentication required/.test(error.message)) signOut() }
}

async function loadCustomers() {
  const data = await api('list-customers')
  el('customers').innerHTML = (data.customers || []).map((c) => `<tr class="border-b border-slate-800 hover:bg-slate-900/60"><td class="p-3 font-mono text-xs">${esc(c.id)}</td><td class="p-3">${esc(c.name)}</td><td class="p-3">${esc(c.phone)}</td><td class="p-3">${esc(c.email)}</td><td class="p-3"><button class="text-teal-300 hover:text-teal-100 mr-3" data-edit-customer="${esc(c.id)}">Edit</button><button class="text-red-300 hover:text-red-100" data-delete-customer="${esc(c.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="p-4 text-slate-500">No customers.</td></tr>'
}

async function loadLicenses() {
  const data = await api('list-licenses')
  el('licenses').innerHTML = (data.licenses || []).map((l) => `<tr class="border-b border-slate-800 hover:bg-slate-900/60"><td class="p-3 font-mono text-xs">${esc(l.id)}</td><td class="p-3">${esc(l.customer_id)}</td><td class="p-3">${esc(l.product)}</td><td class="p-3">${esc(l.license_type)}${l.tier ? ` · ${esc(l.tier)}` : ''}</td><td class="p-3">${esc(l.status)}</td><td class="p-3">${date(l.expires_at)}</td><td class="p-3">${esc(l.activation_limit)}</td><td class="p-3"><button class="text-teal-300 mr-3" data-edit-license="${esc(l.id)}">Edit</button><button class="text-red-300" data-delete-license="${esc(l.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="8" class="p-4 text-slate-500">No licenses.</td></tr>'
}

async function loadSubscriptions() {
  const data = await api('list-subscriptions')
  el('subscriptions').innerHTML = (data.subscriptions || []).map((s) => `<tr class="border-b border-slate-800 hover:bg-slate-900/60"><td class="p-3 font-mono text-xs">${esc(s.id)}</td><td class="p-3">${esc(s.customer_id)}</td><td class="p-3">${esc(s.product)}</td><td class="p-3">${esc(s.status)}</td><td class="p-3">${esc(s.billing_cycle_months)} month(s)</td><td class="p-3">${esc(s.next_billing_date || 'not set')}</td><td class="p-3"><button class="text-teal-300 mr-3" data-edit-subscription="${esc(s.id)}">Edit</button><button class="text-red-300" data-delete-subscription="${esc(s.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="p-4 text-slate-500">No subscriptions.</td></tr>'
}

function signOut() { clearSession(); el('dashboard').classList.add('hidden'); el('login').classList.remove('hidden'); el('loginSecret').value = '' }

el('loginUrl').value = DEFAULT_BASE_URL
el('loginButton').addEventListener('click', async () => { showLoginError(''); el('loginButton').disabled = true; try { await authenticate(el('loginUrl').value, el('loginSecret').value) } catch (error) { showLoginError(error.message) } finally { el('loginButton').disabled = false } })
el('loginSecret').addEventListener('keydown', (event) => { if (event.key === 'Enter') el('loginButton').click() })
el('refresh').addEventListener('click', refreshAll)
el('signOut').addEventListener('click', signOut)

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active')); document.querySelectorAll('.tab-page').forEach((p) => p.classList.add('hidden')); button.classList.add('active'); el(`${button.dataset.tab}Tab`).classList.remove('hidden') }))

el('customerForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('create-customer', { name: el('customerName').value.trim(), phone: el('customerPhone').value.trim(), email: el('customerEmail').value.trim() }); event.target.reset(); await refreshAll() } catch (error) { showError(error.message) } })
el('licenseForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await api('create-license', { customer_id: el('licenseCustomer').value.trim(), product: el('licenseProduct').value, license_type: el('licenseType').value, tier: el('licenseTier').value || undefined, duration_months: Number(el('licenseMonths').value) || undefined, subscription_id: el('licenseSubscription').value.trim() || undefined, activation_limit: Number(el('licenseLimit').value) || 1 }); el('issuedKeyValue').textContent = result.license_key; el('issuedKey').classList.remove('hidden'); event.target.reset(); el('licenseLimit').value = '1'; await refreshAll() } catch (error) { showError(error.message) } })
el('subscriptionForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('create-subscription', { customer_id: el('subscriptionCustomer').value.trim(), product: el('subscriptionProduct').value, billing_cycle_months: Number(el('subscriptionMonths').value), price_minor: Number(el('subscriptionPrice').value) || undefined }); event.target.reset(); el('subscriptionMonths').value = '1'; await refreshAll() } catch (error) { showError(error.message) } })

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button'); if (!target) return
  try {
    if (target.dataset.editCustomer) { const name = prompt('Customer name:'); if (name === null) return; await api('update-customer', { customer_id: target.dataset.editCustomer, name }); await refreshAll() }
    else if (target.dataset.deleteCustomer && confirm('Delete this customer?')) { await api('delete-customer', { customer_id: target.dataset.deleteCustomer }); await refreshAll() }
    else if (target.dataset.editLicense) { const status = prompt('Status: unactivated, active, suspended, expired, revoked'); if (status === null) return; const limit = prompt('Activation limit (machines):', '1'); if (limit === null) return; await api('update-license', { license_id: target.dataset.editLicense, status, activation_limit: Number(limit) }); await refreshAll() }
    else if (target.dataset.deleteLicense && confirm('Delete this license permanently?')) { await api('delete-license', { license_id: target.dataset.deleteLicense }); await refreshAll() }
    else if (target.dataset.editSubscription) { const status = prompt('Status: active, past_due, cancelled, paused'); if (status === null) return; const nextBilling = prompt('Next billing date (YYYY-MM-DD), blank to clear:'); await api('update-subscription', { subscription_id: target.dataset.editSubscription, status, next_billing_date: nextBilling || null }); await refreshAll() }
    else if (target.dataset.deleteSubscription && confirm('Delete this subscription? Linked licenses will become unlinked.')) { await api('delete-subscription', { subscription_id: target.dataset.deleteSubscription }); await refreshAll() }
  } catch (error) { showError(error.message) }
})

try { const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); if (saved?.baseUrl && saved?.secret) authenticate(saved.baseUrl, saved.secret).catch(() => clearSession()) } catch { clearSession() }
