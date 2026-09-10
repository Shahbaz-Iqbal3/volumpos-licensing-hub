'use strict'

const STORAGE_KEY = 'volumpos-hub-admin'

function el(id) {
  return document.getElementById(id)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function showError(message) {
  const box = el('error')
  if (!message) {
    box.classList.add('hidden')
    return
  }
  box.textContent = message
  box.classList.remove('hidden')
}

function config() {
  return {
    baseUrl: (el('baseUrl').value || '').trim().replace(/\/+$/, ''),
    secret: el('adminSecret').value || ''
  }
}

function persistConfig() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(config()))
  } catch {}
}

function restoreConfig() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
    if (saved?.baseUrl) el('baseUrl').value = saved.baseUrl
    if (saved?.secret) el('adminSecret').value = saved.secret
  } catch {}
}

async function call(action, payload = {}) {
  const { baseUrl, secret } = config()
  if (!baseUrl || !secret) throw new Error('Set the hub base URL and admin secret first.')
  persistConfig()
  const res = await fetch(`${baseUrl}/admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify({ action, ...payload })
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`)
  return json
}

function statCard(label, value) {
  return `<div class="card rounded-lg p-3">
    <div class="text-xs text-slate-400">${escapeHtml(label)}</div>
    <div class="text-lg font-semibold text-slate-100 mt-1">${escapeHtml(value)}</div>
  </div>`
}

async function loadStats() {
  showError(null)
  try {
    const data = await call('stats')
    el('stats').innerHTML = [
      statCard('Customers', data.customers),
      statCard('Licenses', data.licenses),
      statCard('Active licenses', data.active_licenses),
      statCard('Active subscriptions', data.active_subscriptions),
      statCard('Fabric', data.by_product?.FABRIC_POS ?? 0),
      statCard('Restaurant', data.by_product?.RESTAURANT_POS ?? 0)
    ].join('')
    await loadLicenses()
  } catch (e) {
    showError(String(e.message || e))
  }
}

async function loadLicenses() {
  const data = await call('list-licenses')
  const rows = data.licenses || []
  const body = el('licenses')
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="p-3 text-slate-500">No licenses issued.</td></tr>'
    return
  }
  body.innerHTML = rows.map((l) => `<tr class="hover:bg-slate-800/50">
    <td class="p-3 font-mono text-xs">${escapeHtml(l.id)}</td>
    <td class="p-3">${escapeHtml(l.customer_id)}</td>
    <td class="p-3">${escapeHtml(l.product)}</td>
    <td class="p-3">${escapeHtml(l.license_type)}${l.tier ? ` · ${escapeHtml(l.tier)}` : ''}</td>
    <td class="p-3">${escapeHtml(l.status)}</td>
    <td class="p-3">${l.expires_at ? new Date(l.expires_at).toLocaleDateString() : 'never'}</td>
    <td class="p-3">${escapeHtml(l.activation_limit)}</td>
  </tr>`).join('')
}

el('loadStats').addEventListener('click', loadStats)

el('createCustomer').addEventListener('click', async () => {
  showError(null)
  try {
    const result = await call('create-customer', {
      name: el('custName').value.trim(),
      phone: el('custPhone').value.trim() || undefined,
      email: el('custEmail').value.trim() || undefined
    })
    el('custName').value = ''
    el('custPhone').value = ''
    el('custEmail').value = ''
    alert(`Created ${result.customer_id}`)
    await loadStats()
  } catch (e) {
    showError(String(e.message || e))
  }
})

el('createLicense').addEventListener('click', async () => {
  showError(null)
  const box = el('licenseResult')
  box.classList.add('hidden')
  try {
    const tier = el('licTier').value
    const expiry = el('licExpiry').value
    const result = await call('create-license', {
      customer_id: el('licCustomer').value.trim(),
      product: el('licProduct').value,
      license_type: el('licType').value,
      tier: tier || undefined,
      expires_at: expiry || undefined,
      activation_limit: Number(el('licLimit').value) || 1
    })
    el('licenseKey').textContent = result.license_key
    box.classList.remove('hidden')
    await loadStats()
  } catch (e) {
    showError(String(e.message || e))
  }
})

el('copyLicense').addEventListener('click', () => {
  navigator.clipboard.writeText(el('licenseKey').textContent || '')
})

restoreConfig()
