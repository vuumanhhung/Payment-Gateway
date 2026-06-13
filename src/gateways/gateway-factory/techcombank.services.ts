import * as moment from 'moment-timezone';
import * as path from 'path';
import * as playwright from 'playwright';

import { GateType, Payment } from '../gate.interface';
import { Gate } from '../gates.services';

type TCBApiResult<T> = {
  status: number;
  ok: boolean;
  data: T | string;
};

type TCBArrangement = {
  id?: string;
  BBAN?: string;
  number?: string;
  accountHolderNames?: string;
  additions?: {
    creditAcctNo?: string;
  };
};

type TCBTransaction = {
  id?: string;
  arrangementId?: string;
  reference?: string;
  description?: string;
  type?: string;
  category?: string;
  bookingDate?: string;
  valueDate?: string;
  creationTime?: string;
  creditDebitIndicator?: string;
  transactionAmountCurrency?: {
    amount?: string | number;
    currencyCode?: string;
  };
  additions?: {
    creditAcctNo?: string;
    additionalInfo?: string;
  };
};

const TECHCOMBANK_BASE_URL = 'https://onlinebanking.techcombank.com.vn';
const TECHCOMBANK_DASHBOARD_URL = `${TECHCOMBANK_BASE_URL}/dashboard`;

export class TechcombankService extends Gate {
  private context?: playwright.BrowserContext;
  private page?: playwright.Page;
  private loginPromise?: Promise<void>;

  protected async prepareSession() {
    await this.login();
  }

  destroy() {
    super.destroy();
    void this.closeBrowser();
  }

  getBrowserDataDir() {
    return path.join(
      process.cwd(),
      '.browser-data',
      `techcombank-${this.config.name}`,
    );
  }

  getChromProxy() {
    if (!this.proxy) {
      return undefined;
    }

    return {
      server: `${this.proxy.ip}:${this.proxy.port}`,
      username: this.proxy.username,
      password: this.proxy.password,
    };
  }

  async login() {
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = this.performLogin().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async performLogin() {
    const page = await this.ensurePage();

    await page.goto(TECHCOMBANK_DASHBOARD_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    try {
      await this.waitForAccessToken(this.getLoginTimeoutMs());
    } catch {
      throw new Error(
        `Techcombank login requires a browser session. Complete login and mobile approval in the opened Chromium window, then keep the service running. Browser data: ${this.getBrowserDataDir()}`,
      );
    }

    console.log('TechcombankService login success');
  }

  private async ensurePage() {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    await this.closeBrowser();
    this.context = await playwright.chromium.launchPersistentContext(
      this.getBrowserDataDir(),
      {
        headless: this.isHeadless(),
        userAgent: this.config.user_agent?.trim() || undefined,
        locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh',
        viewport: {
          width: 1365,
          height: 768,
        },
        proxy: this.getChromProxy(),
      },
    );

    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(30000);
    return this.page;
  }

  private async closeBrowser() {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    if (context) {
      await context.close().catch(() => undefined);
    }
  }

  private isHeadless() {
    return process.env.TECHCOMBANK_HEADLESS === 'true';
  }

  private getLoginTimeoutMs() {
    const value = Number(process.env.TECHCOMBANK_LOGIN_TIMEOUT_MS);
    if (Number.isFinite(value) && value > 0) return value;
    return this.isHeadless() ? 30000 : 5 * 60 * 1000;
  }

  private async waitForAccessToken(timeout: number) {
    const page = await this.ensurePage();
    await page.waitForFunction(
      () => Boolean(window.sessionStorage.getItem('access_token')),
      undefined,
      { timeout },
    );
  }

  private async hasAccessToken() {
    const page = await this.ensurePage();
    return page
      .evaluate(() => Boolean(window.sessionStorage.getItem('access_token')))
      .catch(() => false);
  }

  private async refreshSession() {
    const page = await this.ensurePage();
    await page.goto(TECHCOMBANK_DASHBOARD_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await this.waitForAccessToken(this.getLoginTimeoutMs());
  }

  private async apiGet<T>(pathUrl: string): Promise<T> {
    if (!(await this.hasAccessToken())) {
      await this.login();
    }

    const firstResult = await this.pageFetch<T>('GET', pathUrl);
    if (firstResult.ok) return firstResult.data as T;

    if (firstResult.status === 401) {
      await this.refreshSession();
      const retryResult = await this.pageFetch<T>('GET', pathUrl);
      if (retryResult.ok) return retryResult.data as T;
      throw new Error(this.getApiErrorMessage(pathUrl, retryResult));
    }

    throw new Error(this.getApiErrorMessage(pathUrl, firstResult));
  }

  private async pageFetch<T>(
    method: 'GET' | 'POST',
    pathUrl: string,
    body?: unknown,
  ): Promise<TCBApiResult<T>> {
    const page = await this.ensurePage();

    return page.evaluate(
      async ({ method, pathUrl, body }) => {
        const token = window.sessionStorage.getItem('access_token');
        if (!token) {
          return {
            status: 0,
            ok: false,
            data: 'Techcombank access_token is missing',
          };
        }

        const response = await fetch(pathUrl, {
          method,
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        let data: unknown = text;
        try {
          data = JSON.parse(text);
        } catch {
          // Some Techcombank errors are empty responses.
        }

        return {
          status: response.status,
          ok: response.ok,
          data,
        };
      },
      { method, pathUrl, body },
    ) as Promise<TCBApiResult<T>>;
  }

  private getApiErrorMessage<T>(pathUrl: string, result: TCBApiResult<T>) {
    const data =
      typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data);
    return `Techcombank API ${pathUrl} failed (${result.status}): ${
      data || 'empty response'
    }`;
  }

  private async fetchArrangements() {
    const params = new URLSearchParams({
      businessFunction: 'Product Summary',
      resourceName: 'Product Summary',
      privilege: 'view',
      productKindName: 'Current Account',
      from: '0',
      size: '1000000',
    });

    return this.apiGet<TCBArrangement[]>(
      `/api/arrangement-manager/client-api/v2/productsummary/context/arrangements?${params.toString()}`,
    );
  }

  private async fetchTransactions() {
    const fromDate = moment()
      .tz('Asia/Ho_Chi_Minh')
      .subtract(this.config.get_transaction_day_limit, 'days')
      .format('YYYY-MM-DD');
    const toDate = moment().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
    const params = new URLSearchParams({
      bookingDateGreaterThan: fromDate,
      bookingDateLessThan: toDate,
      from: '0',
      size: String(this.config.get_transaction_count_limit),
      orderBy: 'bookingDate',
      direction: 'DESC',
    });

    return this.apiGet<TCBTransaction[]>(
      `/api/transaction-manager/client-api/v3/transactions?${params.toString()}`,
    );
  }

  parseTransactionDate(transaction: TCBTransaction): Date {
    const rawDate =
      transaction.creationTime ||
      transaction.valueDate ||
      transaction.bookingDate;
    if (!rawDate) return new Date();

    const parsed = moment.tz(rawDate, 'Asia/Ho_Chi_Minh');
    if (!parsed.isValid()) return new Date();

    const hasTime = /(?:T|\s)\d{1,2}:\d{2}/.test(rawDate);
    const today = moment().tz('Asia/Ho_Chi_Minh');
    if (!hasTime && parsed.isSame(today, 'day')) {
      return today.toDate();
    }

    return parsed.toDate();
  }

  mapTransactions(
    transactions: TCBTransaction[],
    arrangements: TCBArrangement[],
  ): Payment[] {
    const arrangementAccounts = new Map(
      arrangements
        .filter((arrangement) => arrangement.id)
        .map((arrangement) => [
          arrangement.id,
          this.getArrangementAccount(arrangement),
        ]),
    );
    const expectedAccount = this.normalizeAccount(this.config.account);

    return transactions
      .filter((transaction) => this.isCreditTransaction(transaction))
      .filter((transaction) => {
        const account = this.getTransactionAccount(
          transaction,
          arrangementAccounts,
        );
        return this.normalizeAccount(account) === expectedAccount;
      })
      .map((transaction) => ({
        transaction_id:
          'techcombank-' +
          (transaction.id || transaction.reference || cryptoRandomId()),
        amount: Number(transaction.transactionAmountCurrency?.amount || 0),
        content: this.getTransactionContent(transaction),
        date: this.parseTransactionDate(transaction),
        account_receiver: this.config.account,
        gate: GateType.TECHCOMBANK,
      }));
  }

  private isCreditTransaction(transaction: TCBTransaction) {
    return (
      transaction.creditDebitIndicator === 'CRDT' ||
      transaction.type === 'CRDT' ||
      transaction.category === 'Income'
    );
  }

  private getArrangementAccount(arrangement: TCBArrangement) {
    return (
      arrangement.BBAN ||
      arrangement.number ||
      arrangement.additions?.creditAcctNo ||
      ''
    );
  }

  private getTransactionAccount(
    transaction: TCBTransaction,
    arrangementAccounts: Map<string, string>,
  ) {
    if (transaction.additions?.creditAcctNo) {
      return transaction.additions.creditAcctNo;
    }
    if (transaction.arrangementId) {
      return arrangementAccounts.get(transaction.arrangementId) || '';
    }
    return '';
  }

  private getTransactionContent(transaction: TCBTransaction) {
    const additionalInfo = this.parseAdditionalInfo(
      transaction.additions?.additionalInfo,
    );
    return [
      transaction.description,
      additionalInfo?.['PAY.DETAILS'],
      transaction.reference,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private parseAdditionalInfo(value?: string) {
    if (!value) return undefined;
    try {
      return JSON.parse(value) as Record<string, string>;
    } catch {
      return undefined;
    }
  }

  private normalizeAccount(value?: string) {
    return String(value || '').replace(/\D/g, '');
  }

  async getHistory(): Promise<Payment[]> {
    try {
      const [arrangements, transactions] = await Promise.all([
        this.fetchArrangements(),
        this.fetchTransactions(),
      ]);

      return this.mapTransactions(transactions, arrangements);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown history error';
      console.error(
        `TechcombankService transaction history failed: ${message}`,
      );
      throw new Error('Error while fetching Techcombank transaction history');
    }
  }
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2);
}
