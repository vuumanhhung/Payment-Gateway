import * as https from 'https';
import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import * as moment from 'moment-timezone';

import {
  DEFAULT_VCB_USER_AGENT,
  GateType,
  Payment,
} from '../../gate.interface';
import { Gate } from '../../gates.services';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { sleep } from 'src/shards/helpers/sleep';
import { VCBLoginDto, TransactionDto } from './vcb.bank.type';
import { Encrypt } from './encrypt';
import { axios } from 'src/shards/helpers/axios';

interface VCBResponse {
  code?: string;
  des?: string;
}

@Injectable()
export class VCBBankService extends Gate {
  private encrypt = new Encrypt();
  private sessionId: string | null = null;
  private cif: string | null = null;
  private mobileId: string | null = null;
  private clientId: string | null = null;

  private getUserAgent() {
    return this.config.user_agent?.trim() || DEFAULT_VCB_USER_AGENT;
  }

  private getBrowserMetadata() {
    const userAgent = this.getUserAgent();
    const edge = userAgent.match(/Edg\/([\d.]+)/);
    const chrome = userAgent.match(/(?:Chrome|CriOS)\/([\d.]+)/);
    const firefox = userAgent.match(/(?:Firefox|FxiOS)\/([\d.]+)/);
    const safari = userAgent.match(/Version\/([\d.]+).*Safari/);

    let browserName = 'Chrome';
    let browserVersion = chrome?.[1] || '';
    if (edge) {
      browserName = 'Microsoft Edge';
      browserVersion = edge[1];
    } else if (firefox) {
      browserName = 'Firefox';
      browserVersion = firefox[1];
    } else if (safari) {
      browserName = 'Safari';
      browserVersion = safari[1];
    }

    let deviceType = 'WINDOWS_WEB';
    if (/Macintosh|Mac OS X/i.test(userAgent)) {
      deviceType = 'MACOS_WEB';
    } else if (/Linux/i.test(userAgent) && !/Android/i.test(userAgent)) {
      deviceType = 'LINUX_WEB';
    }

    return {
      DT: deviceType,
      PM: browserName,
      OV: browserVersion,
    };
  }

  protected async prepareSession() {
    if (!this.sessionId) {
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

  private async makeRequest<T extends VCBResponse>(path: string, body: any) {
    const { data } = await axios.post(
      'https://digiapp.vietcombank.com.vn' + path,
      this.encrypt.encryptRequest(body),
      {
        headers: {
          'X-Request-ID':
            String(new Date().getTime()) +
            String(parseInt((100 * Math.random()).toString())),
          'X-Channel': 'Web',
          'X-Lim-ID': this.encrypt.sha256(this.config.login_id + '1236q93-@u9'),
          'User-Agent': this.getUserAgent(),
          Accept: 'application/json',
          'Accept-Language': 'vi',
          'Content-Type': 'application/json',
          Referer: 'https://vcbdigibank.vietcombank.com.vn/',
        },
        httpsAgent: this.getAgent(),
      },
    );

    try {
      return JSON.parse(this.encrypt.decryptResponse(data)) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`VCB response error for ${path}: ${message}`);
    }
  }

  private async login() {
    // get captcha image and convert to base64
    const captchaToken = uuidv4();
    const captcha = await axios.get(
      'https://digiapp.vietcombank.com.vn/utility-service/v2/captcha/MASS/' +
        captchaToken,
      {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': this.getUserAgent(),
          Referer: 'https://vcbdigibank.vietcombank.com.vn/',
        },
      },
    );
    const captchaBase64 = Buffer.from(captcha.data, 'binary').toString(
      'base64',
    );
    const captchaValue = await this.captchaSolver.solveCaptcha(captchaBase64);
    if (captchaValue.length !== 5) {
      throw new Error('Captcha value is invalid');
    }

    const loginRes = await this.makeRequest<VCBLoginDto>(
      '/authen-service/v1/login',
      {
        captchaToken,
        captchaValue,
        password: this.config.password,
        user: this.config.login_id,
        browserId: this.config.device_id,
        mid: 6,
        lang: 'vi',
        E: null,
        sessionId: null,
        ...this.getBrowserMetadata(),
        appVersion: '',
      },
    );
    if (loginRes.code == '00' && loginRes.sessionId && loginRes.userInfo) {
      this.sessionId = loginRes.sessionId;
      this.cif = loginRes.userInfo?.cif;
      this.mobileId = loginRes.userInfo?.mobileId;
      this.clientId = loginRes.userInfo?.clientId;
      return;
    }

    const description = loginRes.des || 'Unknown login error';
    const deviceHint =
      loginRes.code === '20231'
        ? '. device_id chưa được VCB xác thực; lấy lại device_id ngay trên trang VCB theo hướng dẫn trong README'
        : '';
    throw new Error(
      `VCB login failed (${
        loginRes.code || 'UNKNOWN'
      }): ${description}${deviceHint}`,
    );
  }

  async getHistory(): Promise<Payment[]> {
    if (!this.sessionId) await this.login();

    try {
      const fromDate = moment()
        .tz('Asia/Ho_Chi_Minh')
        .subtract(this.config.get_transaction_day_limit, 'days')
        .format('DD/MM/YYYY');
      const toDate = moment().tz('Asia/Ho_Chi_Minh').format('DD/MM/YYYY');

      const data = await this.makeRequest<TransactionDto>(
        '/bank-service/v1/transaction-history',
        {
          accountNo: this.config.account,
          accountType: 'D',
          fromDate,
          toDate,
          pageIndex: 0,
          lengthInPage: this.config.get_transaction_count_limit,
          mid: 14,
          lang: 'vi',
          user: this.config.login_id,
          cif: this.cif,
          mobileId: this.mobileId,
          clientId: this.clientId,
          browserId: this.config.device_id,
          E: null,
          sessionId: this.sessionId,
          ...this.getBrowserMetadata(),
          appVersion: '',
        },
      );

      if (data.code !== '00') {
        throw new Error(
          `VCB transaction history failed (${data.code || 'UNKNOWN'}): ${
            data.des || 'Unknown error'
          }`,
        );
      }
      if (!Array.isArray(data.transactions)) {
        throw new Error('VCB transaction history response has no transactions');
      }

      // PostingDate: '2024-06-28',
      // PostingTime: '050359',
      const getDate = (PostingDate: string, PostingTime: string): Date => {
        const time = PostingTime.match(/.{1,2}/g);
        return moment
          .tz(
            PostingDate + ' ' + time.join(':'),
            'YYYY-MM-DD HH:mm:ss',
            'Asia/Ho_Chi_Minh',
          )
          .toDate();
      };

      const payments = data.transactions
        .filter((t) => t.CD === '+')
        .map((t) => ({
          transaction_id: 'vcbbank-' + t.Reference,
          content: t.Description,
          amount: parseFloat(t.Amount.replaceAll(',', '')),
          date: getDate(t.PostingDate, t.PostingTime),
          gate: GateType.VCBBANK,
          account_receiver: this.config.account,
        }));

      return payments;
    } catch (error) {
      console.error('Error while fetching transaction history:', error);

      if (
        error.message.includes(
          'Client network socket disconnected before secure TLS connection was established',
        )
      ) {
        await sleep(10000);
      } else {
        this.sessionId = null;
      }

      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error while fetching transaction history');
    }
  }
}
