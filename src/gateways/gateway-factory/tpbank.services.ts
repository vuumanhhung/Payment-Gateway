import { axios } from 'src/shards/helpers/axios';
import * as moment from 'moment-timezone';
import * as https from 'https';
import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';

import { GateType, Payment } from '../gate.interface';
import { Gate } from '../gates.services';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { sleep } from 'src/shards/helpers/sleep';

type TPBankTransaction = {
  id?: string;
  amount?: string | number;
  description?: string;
  creditDebitIndicator?: string;
  bookingDate?: string;
  transactionDate?: string;
  valueDate?: string;
};

const API_BASE_URL = 'https://ebank.tpb.vn';
const API_ENDPOINTS = {
  LOGIN: `${API_BASE_URL}/gateway/api/auth/login/v4/non-trust`,
  TRANSACTIONS: `${API_BASE_URL}/gateway/api/smart-search-presentation-service/v2/account-transactions/find`,
};

const DEFAULT_HEADERS = {
  APP_VERSION: '2026.01.30',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'vi',
  Connection: 'keep-alive',
  'Content-Type': 'application/json',
  DEVICE_NAME: 'Chrome',
  Origin: API_BASE_URL,
  PLATFORM_NAME: 'WEB',
  PLATFORM_VERSION: '145',
  SOURCE_APP: 'HYDRO',
  USER_NAME: 'HYD',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

@Injectable()
export class TPBankService extends Gate {
  private accessToken: string | null | undefined;

  private deviceId: string;

  private clearAccessTokenTimeout: NodeJS.Timeout | null = null;

  private clearAccessToken() {
    this.accessToken = null;
    if (this.clearAccessTokenTimeout) {
      clearTimeout(this.clearAccessTokenTimeout);
      this.clearAccessTokenTimeout = null;
    }
  }

  protected async prepareSession() {
    if (!this.accessToken) {
      await this.login();
    }
  }

  getAgent() {
    if (this.proxy != null) {
      if (this.proxy.username && this.proxy.username.length > 0) {
        return new HttpsProxyAgent(
          `${this.proxy.schema}://${this.proxy.username}:${this.proxy.password}@${this.proxy.ip}:${this.proxy.port}`,
        );
      }
      return new HttpsProxyAgent(
        `${this.proxy.schema}://${this.proxy.ip}:${this.proxy.port}`,
      );
    }
    return new https.Agent({
      secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    });
  }

  private async login() {
    this.deviceId = this.config.device_id;

    const dataSend = {
      username: this.config.login_id,
      password: this.config.password,
      step_2FA: 'VERIFY',
      deviceId: this.deviceId,
      transactionId: '',
    };
    const config = {
      headers: {
        ...DEFAULT_HEADERS,
        Authorization: 'Bearer',
        DEVICE_ID: this.deviceId,
        Referer: `${API_BASE_URL}/retail/vX/`,
      },
    };
    try {
      const response = await axios.post(
        API_ENDPOINTS.LOGIN,
        dataSend,
        { ...config, httpsAgent: this.getAgent() },
      );
      this.accessToken = response.data.access_token;

      if (!this.accessToken) {
        throw new Error('TPBank login response does not contain access_token');
      }

      if (this.clearAccessTokenTimeout) {
        clearTimeout(this.clearAccessTokenTimeout);
      }

      const expiresIn = Number(response.data.expires_in);
      if (Number.isFinite(expiresIn) && expiresIn > 10) {
        this.clearAccessTokenTimeout = setTimeout(
          () => this.clearAccessToken(),
          (expiresIn - 10) * 1000,
        );
      }

      console.log('TPBankService login success');
    } catch (error) {
      this.clearAccessToken();
      const message =
        error instanceof Error ? error.message : 'Unknown login error';
      console.error(`TPBankService login failed: ${message}`);
      throw new Error(`TPBank login failed: ${message}`);
    }
  }

  private async fetchHistory(): Promise<TPBankTransaction[]> {
    const fromDate = moment()
      .tz('Asia/Ho_Chi_Minh')
      .subtract(this.config.get_transaction_day_limit, 'days')
      .format('YYYYMMDD');
    const toDate = moment().tz('Asia/Ho_Chi_Minh').format('YYYYMMDD');

    const config = {
      headers: {
        ...DEFAULT_HEADERS,
        'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
        Authorization: `Bearer ${this.accessToken}`,
        DEVICE_ID: this.deviceId,
      },
    };

    const dataSend = {
      pageNumber: 1,
      pageSize: this.config.get_transaction_count_limit,
      accountNo: this.config.account,
      currency: 'VND',
      maxAcentrysrno: '',
      fromDate: fromDate,
      toDate: toDate,
      keyword: '',
    };

    const response = await axios.post(API_ENDPOINTS.TRANSACTIONS, dataSend, {
      ...config,
      httpsAgent: this.getAgent(),
    });

    return response.data.transactionInfos || [];
  }

  private parseTransactionDate(transaction: TPBankTransaction): Date {
    const rawDate =
      transaction.transactionDate ||
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

  private mapTransactions(
    transactionInfosList: TPBankTransaction[],
  ): Payment[] {
    return transactionInfosList
      .filter(
        (transactionInfo) =>
          transactionInfo.creditDebitIndicator === 'CRDT',
      )
      .map((transactionInfo) => ({
        transaction_id: 'tpbank-' + transactionInfo.id,
        amount: Number(transactionInfo.amount),
        content: transactionInfo.description || '',
        date: this.parseTransactionDate(transactionInfo),
        account_receiver: this.config.account,
        gate: GateType.TPBANK,
      }));
  }

  private getErrorStatus(error: unknown): number | undefined {
    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      typeof error.response === 'object' &&
      error.response !== null &&
      'status' in error.response
    ) {
      return Number(error.response.status);
    }
    return undefined;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Unknown transaction history error';
  }

  async getHistory(): Promise<Payment[]> {
    if (!this.accessToken) await this.login();

    try {
      return this.mapTransactions(await this.fetchHistory());
    } catch (firstError) {
      if (this.getErrorStatus(firstError) === 401) {
        this.clearAccessToken();
        await this.login();

        try {
          return this.mapTransactions(await this.fetchHistory());
        } catch (retryError) {
          this.clearAccessToken();
          console.error(
            `TPBank transaction history failed after re-login: ${this.getErrorMessage(
              retryError,
            )}`,
          );
          throw new Error('Error while fetching transaction history');
        }
      }

      const message = this.getErrorMessage(firstError);
      console.error(`TPBank transaction history failed: ${message}`);
      if (
        message.includes(
          'Client network socket disconnected before secure TLS connection was established',
        )
      ) {
        await sleep(10000);
      } else {
        this.clearAccessToken();
      }

      throw new Error('Error while fetching transaction history');
    }
  }
}
