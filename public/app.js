const form = document.querySelector('#payment-form');
const amountInput = document.querySelector('#amount');
const gatewaySelect = document.querySelector('#gateway');
const emptyState = document.querySelector('#empty-state');
const paymentContent = document.querySelector('#payment-content');
const confirmButton = document.querySelector('#confirm-button');
const statusPill = document.querySelector('#status-pill');
const overlay = document.querySelector('#result-overlay');
const dialog = overlay.querySelector('.result-dialog');
const toast = document.querySelector('#toast');

let currentRequest = null;
let targets = [];

const money = new Intl.NumberFormat('vi-VN');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    const message = Array.isArray(data.message)
      ? data.message.join(', ')
      : data.message || 'Có lỗi xảy ra';
    throw new Error(message);
  }
  return data;
}

async function loadTargets() {
  try {
    targets = await api('/api/payment-requests/targets');
    gatewaySelect.innerHTML = '';

    if (!targets.length) {
      gatewaySelect.innerHTML =
        '<option value="">Chưa có tài khoản ngân hàng</option>';
      form.querySelector('button[type="submit"]').disabled = true;
      return;
    }

    for (const target of targets) {
      const option = document.createElement('option');
      option.value = target.gatewayName;
      option.textContent = `${target.bankName} · ${maskAccount(
        target.accountNo,
      )}`;
      gatewaySelect.append(option);
    }
  } catch (error) {
    gatewaySelect.innerHTML =
      '<option value="">Không tải được tài khoản</option>';
    showToast(error.message);
  }
}

function maskAccount(account) {
  if (account.length <= 6) return account;
  return `${account.slice(0, 3)}•••${account.slice(-3)}`;
}

function getRawAmount() {
  return Number(amountInput.value.replace(/\D/g, ''));
}

function setAmount(value) {
  amountInput.value = value ? money.format(value) : '';
}

function renderRequest(request) {
  currentRequest = request;
  emptyState.classList.add('hidden');
  paymentContent.classList.remove('hidden');

  document.querySelector('#payment-bank').textContent = request.target.bankName;
  document.querySelector('#qr-image').src = request.qrUrl;
  document.querySelector('#payment-amount').textContent = `${money.format(
    request.amount,
  )} VND`;
  document.querySelector('#account-name').textContent =
    request.target.accountName || 'Chủ tài khoản';
  document.querySelector('#account-number').textContent =
    request.target.accountNo;
  document.querySelector('#payment-description').textContent =
    request.description;

  statusPill.textContent = 'Chờ chuyển khoản';
  statusPill.className = 'status-pill';
  confirmButton.disabled = false;
  confirmButton.classList.remove('loading');
  confirmButton.querySelector('.button-label').textContent =
    'Tôi đã chuyển tiền';
}

function setChecking(checking) {
  confirmButton.disabled = checking;
  confirmButton.classList.toggle('loading', checking);
  confirmButton.querySelector('.button-label').textContent = checking
    ? 'Đang đối chiếu giao dịch...'
    : 'Tôi đã chuyển tiền';
  statusPill.textContent = checking ? 'Đang kiểm tra' : 'Chờ chuyển khoản';
  statusPill.className = checking ? 'status-pill checking' : 'status-pill';
}

function showResult(request) {
  const success = request.status === 'success';
  dialog.classList.toggle('failed', !success);
  document.querySelector('#result-icon').textContent = success ? '✓' : '!';
  document.querySelector('#result-label').textContent = success
    ? 'THANH TOÁN THÀNH CÔNG'
    : 'GIAO DỊCH THẤT BẠI';
  document.querySelector('#result-title').textContent = success
    ? 'Đã tìm thấy giao dịch'
    : 'Giao dịch thất bại';
  document.querySelector('#result-message').textContent = success
    ? `Hệ thống đã đối chiếu thành công khoản thanh toán ${money.format(
        request.amount,
      )} VND.`
    : request.failureReason ||
      'Giao dịch thất bại, vui lòng kiểm tra lại';

  const transaction = document.querySelector('#result-transaction');
  transaction.classList.toggle('hidden', !success);
  if (success) {
    document.querySelector('#transaction-id').textContent =
      request.payment.transaction_id;
    statusPill.textContent = 'Đã thanh toán';
    statusPill.className = 'status-pill success';
  }
  overlay.classList.remove('hidden');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  window.setTimeout(() => toast.classList.add('hidden'), 1800);
}

amountInput.addEventListener('input', () => {
  setAmount(getRawAmount());
});

document.querySelectorAll('[data-amount]').forEach((button) => {
  button.addEventListener('click', () => {
    setAmount(Number(button.dataset.amount));
    amountInput.focus();
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  try {
    const request = await api('/api/payment-requests', {
      method: 'POST',
      body: JSON.stringify({
        amount: getRawAmount(),
        gatewayName: gatewaySelect.value,
      }),
    });
    renderRequest(request);
    paymentContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

confirmButton.addEventListener('click', async () => {
  if (!currentRequest) return;
  setChecking(true);

  try {
    const request = await api(
      `/api/payment-requests/${currentRequest.id}/verify`,
      { method: 'POST' },
    );
    currentRequest = request;
    showResult(request);
  } catch (error) {
    showResult({
      status: 'failed',
      failureReason: error.message,
      amount: currentRequest.amount,
    });
  } finally {
    setChecking(false);
  }
});

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const value =
      button.dataset.copy === 'account'
        ? currentRequest?.target.accountNo
        : currentRequest?.description;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    showToast('Đã sao chép');
  });
});

document.querySelector('#close-result').addEventListener('click', () => {
  overlay.classList.add('hidden');
});

document.querySelector('#new-payment').addEventListener('click', () => {
  overlay.classList.add('hidden');
  currentRequest = null;
  paymentContent.classList.add('hidden');
  emptyState.classList.remove('hidden');
  setAmount(0);
  amountInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

loadTargets();
