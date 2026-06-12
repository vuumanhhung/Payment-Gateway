const secretPath = window.location.pathname.split('/').filter(Boolean)[0];
const apiBase = `/api/admin/${encodeURIComponent(secretPath)}`;
const loginScreen = document.querySelector('#login-screen');
const adminShell = document.querySelector('#admin-shell');
const loginForm = document.querySelector('#login-form');
const bankModal = document.querySelector('#bank-modal');
const bankForm = document.querySelector('#bank-form');
const toast = document.querySelector('#admin-toast');

const pageMeta = {
  overview: ['TỔNG QUAN', 'Tổng quan hệ thống'],
  banks: ['NGÂN HÀNG', 'Quản lý ngân hàng'],
  transactions: ['GIAO DỊCH', 'Lịch sử giao dịch'],
};

let banks = [];
let overview = null;
let transactionSearchTimer;

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await response.json().catch(() => ({}));

  if (response.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('Phiên đăng nhập đã hết hạn');
  }
  if (!response.ok) {
    const message = Array.isArray(data.message)
      ? data.message.join(', ')
      : data.message || 'Yêu cầu thất bại';
    throw new Error(message);
  }
  return data;
}

async function bootstrap() {
  try {
    const session = await api('/session');
    if (session.authenticated) {
      await showDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showLogin() {
  adminShell.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  window.setTimeout(() => document.querySelector('#admin-password').focus(), 0);
}

async function showDashboard() {
  loginScreen.classList.add('hidden');
  adminShell.classList.remove('hidden');
  await refreshAll();
}

async function refreshAll() {
  const activePage =
    document.querySelector('.nav-item.active')?.dataset.page || 'overview';
  try {
    [overview, banks] = await Promise.all([api('/overview'), api('/banks')]);
    renderOverview();
    renderBanks();
    if (activePage === 'transactions') await loadTransactions();
  } catch (error) {
    showToast(error.message);
  }
}

function renderOverview() {
  document.querySelector('#metric-banks').textContent = overview.banks.total;
  document.querySelector(
    '#metric-banks-caption',
  ).textContent = `${overview.banks.enabled} đang bật`;
  document.querySelector('#metric-ready').textContent = overview.banks.ready;
  document.querySelector('#metric-today').textContent =
    overview.transactions.today;
  document.querySelector('#metric-today-amount').textContent = `${formatMoney(
    overview.transactions.todayAmount,
  )} VND`;
  document.querySelector('#metric-errors').textContent = overview.banks.errors;
  document.querySelector('#bank-count').textContent = overview.banks.total;

  const bankSummary = document.querySelector('#bank-summary');
  bankSummary.innerHTML = banks.length
    ? banks
        .slice(0, 5)
        .map(
          (bank) => `
            <div class="summary-bank">
              <span class="bank-avatar">${bankShortName(bank.type)}</span>
              <div>
                <strong>${escapeHtml(bankName(bank.type))}</strong>
                <small>${escapeHtml(bank.account)} · ${escapeHtml(
                  bank.name,
                )}</small>
              </div>
              ${statusBadge(bank.status)}
            </div>
          `,
        )
        .join('')
    : emptyState('Chưa cấu hình ngân hàng.');

  const recentList = document.querySelector('#recent-list');
  recentList.innerHTML = overview.recentTransactions.length
    ? overview.recentTransactions
        .map(
          (payment) => `
            <div class="recent-item">
              <span class="bank-avatar">${bankShortName(payment.gate)}</span>
              <div>
                <strong title="${escapeHtml(payment.content)}">${escapeHtml(
                  payment.content,
                )}</strong>
                <small>${formatDate(payment.date)} · ${escapeHtml(
                  payment.account_receiver,
                )}</small>
              </div>
              <span class="amount">+${formatMoney(payment.amount)}</span>
            </div>
          `,
        )
        .join('')
    : emptyState('Chưa có giao dịch được ghi nhận.');
}

function renderBanks() {
  const grid = document.querySelector('#banks-grid');
  grid.innerHTML = banks.length
    ? banks
        .map(
          (bank) => `
            <article class="bank-card">
              <div class="bank-card-top">
                <div class="bank-identity">
                  <span class="bank-avatar">${bankShortName(bank.type)}</span>
                  <div>
                    <h3>${escapeHtml(bankName(bank.type))}</h3>
                    <p>${escapeHtml(bank.name)}</p>
                  </div>
                </div>
                <label class="switch" title="Bật hoặc tắt gateway">
                  <input
                    type="checkbox"
                    data-bank-toggle="${escapeHtml(bank.name)}"
                    ${bank.enabled ? 'checked' : ''}
                  />
                  <span></span>
                </label>
              </div>
              <div class="bank-meta">
                <div>
                  <span>SỐ TÀI KHOẢN</span>
                  <strong>${escapeHtml(bank.account)}</strong>
                </div>
                <div>
                  <span>CHỦ TÀI KHOẢN</span>
                  <strong>${escapeHtml(
                    bank.accountName || 'Chưa cấu hình',
                  )}</strong>
                </div>
                <div>
                  <span>TÊN ĐĂNG NHẬP</span>
                  <strong>${escapeHtml(
                    bank.maskedLoginId || 'Chưa cấu hình',
                  )}</strong>
                </div>
                <div>
                  <span>BANK BIN</span>
                  <strong>${escapeHtml(bank.bankId || '-')}</strong>
                </div>
              </div>
              <div class="bank-card-footer">
                ${statusBadge(bank.status)}
                <p class="bank-error" title="${escapeHtml(
                  bank.status.message || '',
                )}">${escapeHtml(bank.status.message || '')}</p>
              </div>
            </article>
          `,
        )
        .join('')
    : emptyState('Chưa có ngân hàng. Bấm “Thêm ngân hàng” để bắt đầu.');

  document.querySelectorAll('[data-bank-toggle]').forEach((input) => {
    input.addEventListener('change', () => toggleBank(input));
  });
}

async function toggleBank(input) {
  input.disabled = true;
  try {
    await api(`/banks/${encodeURIComponent(input.dataset.bankToggle)}/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: input.checked }),
    });
    showToast(input.checked ? 'Đã bật ngân hàng' : 'Đã tắt ngân hàng');
    await refreshAll();
  } catch (error) {
    input.checked = !input.checked;
    showToast(error.message);
  } finally {
    input.disabled = false;
  }
}

async function loadTransactions() {
  const query = document.querySelector('#transaction-search').value.trim();
  const gate = document.querySelector('#transaction-bank-filter').value;
  const params = new URLSearchParams({ limit: '500' });
  if (query) params.set('query', query);
  if (gate) params.set('gate', gate);

  try {
    const transactions = await api(`/transactions?${params}`);
    const body = document.querySelector('#transactions-body');
    const empty = document.querySelector('#transactions-empty');
    body.innerHTML = transactions
      .map(
        (payment) => `
          <tr>
            <td>${formatDate(payment.date)}</td>
            <td><span class="status ready">${escapeHtml(
              bankName(payment.gate),
            )}</span></td>
            <td class="content-cell" title="${escapeHtml(
              payment.content,
            )}">${escapeHtml(payment.content)}</td>
            <td>${escapeHtml(payment.account_receiver)}</td>
            <td>${escapeHtml(payment.transaction_id)}</td>
            <td class="align-right">+${formatMoney(payment.amount)} VND</td>
          </tr>
        `,
      )
      .join('');
    empty.classList.toggle('hidden', transactions.length > 0);
  } catch (error) {
    showToast(error.message);
  }
}

function setPage(page) {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach((section) => {
    section.classList.toggle('active', section.id === `page-${page}`);
  });
  document.querySelector('#page-label').textContent = pageMeta[page][0];
  document.querySelector('#page-title').textContent = pageMeta[page][1];
  document.querySelector('.sidebar').classList.remove('open');
  if (page === 'transactions') loadTransactions();
}

function openBankModal() {
  document.querySelector('#bank-form-error').classList.add('hidden');
  bankModal.classList.remove('hidden');
  document.querySelector('#bank-form [name="name"]').focus();
}

function closeBankModal() {
  bankModal.classList.add('hidden');
  bankForm.reset();
  updateBankFields();
}

function updateBankFields() {
  const type = document.querySelector('#bank-type').value;
  const defaults = {
    MBBANK: '970422',
    ACBBANK: '970416',
    TPBANK: '970423',
    VCBBANK: '970436',
  };
  document.querySelector('#bank-id').value = defaults[type];
  const requiresDevice = type === 'TPBANK' || type === 'VCBBANK';
  document
    .querySelector('#device-id-field')
    .classList.toggle('hidden', !requiresDevice);
  document.querySelector('#device-id').required = requiresDevice;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorElement = document.querySelector('#login-error');
  const button = loginForm.querySelector('button[type="submit"]');
  errorElement.classList.add('hidden');
  button.disabled = true;

  try {
    await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        password: document.querySelector('#admin-password').value,
      }),
    });
    loginForm.reset();
    await showDashboard();
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

bankForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorElement = document.querySelector('#bank-form-error');
  const submitButton = bankForm.querySelector('button[type="submit"]');
  const formData = new FormData(bankForm);
  errorElement.classList.add('hidden');
  submitButton.disabled = true;

  try {
    await api('/banks', {
      method: 'POST',
      body: JSON.stringify({
        name: formData.get('name'),
        type: formData.get('type'),
        loginId: formData.get('loginId'),
        password: formData.get('password'),
        account: formData.get('account'),
        accountName: formData.get('accountName'),
        bankId: formData.get('bankId'),
        deviceId: formData.get('deviceId'),
        enabled: formData.get('enabled') === 'on',
      }),
    });
    closeBankModal();
    showToast('Đã thêm ngân hàng. Hệ thống đang đăng nhập nền.');
    await refreshAll();
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.classList.remove('hidden');
  } finally {
    submitButton.disabled = false;
  }
});

document
  .querySelector('#toggle-password')
  .addEventListener('click', (event) => {
    const input = document.querySelector('#admin-password');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    event.currentTarget.textContent = visible ? 'Hiện' : 'Ẩn';
  });

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => setPage(button.dataset.page));
});

document.querySelectorAll('[data-open-page]').forEach((button) => {
  button.addEventListener('click', () => setPage(button.dataset.openPage));
});

document.querySelector('#refresh-button').addEventListener('click', refreshAll);
document
  .querySelector('#add-bank-button')
  .addEventListener('click', openBankModal);
document
  .querySelector('#close-bank-modal')
  .addEventListener('click', closeBankModal);
document
  .querySelector('#cancel-bank-modal')
  .addEventListener('click', closeBankModal);
document
  .querySelector('#bank-type')
  .addEventListener('change', updateBankFields);
document.querySelector('#mobile-menu').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('open');
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } finally {
    showLogin();
  }
});

document.querySelector('#transaction-search').addEventListener('input', () => {
  clearTimeout(transactionSearchTimer);
  transactionSearchTimer = setTimeout(loadTransactions, 250);
});
document
  .querySelector('#transaction-bank-filter')
  .addEventListener('change', loadTransactions);

bankModal.addEventListener('click', (event) => {
  if (event.target === bankModal) closeBankModal();
});

function statusBadge(status) {
  const labels = {
    ready: 'Sẵn sàng',
    connecting: 'Đang đăng nhập',
    scanning: 'Đang kiểm tra',
    error: 'Có lỗi',
    disabled: 'Đã tắt',
    idle: 'Chờ đăng nhập',
  };
  return `<span class="status ${status.state}">${
    labels[status.state] || status.state
  }</span>`;
}

function bankName(type) {
  return (
    {
      MBBANK: 'MB Bank',
      ACBBANK: 'ACB',
      TPBANK: 'TPBank',
      VCBBANK: 'Vietcombank',
    }[type] || type
  );
}

function bankShortName(type) {
  return (
    {
      MBBANK: 'MB',
      ACBBANK: 'ACB',
      TPBANK: 'TP',
      VCBBANK: 'VCB',
    }[type] || '?'
  );
}

function formatMoney(value) {
  return new Intl.NumberFormat('vi-VN').format(Number(value) || 0);
}

function formatDate(value) {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function emptyState(message) {
  return `<div class="empty-table">${escapeHtml(message)}</div>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  window.setTimeout(() => toast.classList.add('hidden'), 2200);
}

updateBankFields();
bootstrap();
