import { parse } from 'node-html-parser';
import * as moment from 'moment-timezone';
import * as playwright from 'playwright';
import * as _request from 'request-promise';
import * as path from 'path';
import { GateType, Payment } from '../gate.interface';

import { Gate } from '../gates.services';
import { sleep } from 'src/shards/helpers/sleep';
import { axios } from 'src/shards/helpers/axios';

type BufferedOutput = {
  stream: 'stdout' | 'stderr';
  args: unknown[];
};

class ProcessOutputBuffer {
  private readonly stdoutWrite = process.stdout.write;
  private readonly stderrWrite = process.stderr.write;
  private readonly output: BufferedOutput[] = [];
  private active = false;

  start() {
    if (this.active) return;
    this.active = true;

    process.stdout.write = ((...args: unknown[]) => {
      this.output.push({ stream: 'stdout', args });
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((...args: unknown[]) => {
      this.output.push({ stream: 'stderr', args });
      return true;
    }) as typeof process.stderr.write;
  }

  writePrompt(text: string) {
    this.stdoutWrite.call(process.stdout, text);
  }

  release(prefix?: string) {
    if (!this.active) return;
    this.active = false;
    process.stdout.write = this.stdoutWrite;
    process.stderr.write = this.stderrWrite;

    if (prefix) {
      this.stdoutWrite.call(process.stdout, prefix);
    }

    for (const entry of this.output) {
      const stream =
        entry.stream === 'stdout' ? process.stdout : process.stderr;
      const write =
        entry.stream === 'stdout' ? this.stdoutWrite : this.stderrWrite;
      Reflect.apply(write, stream, entry.args);
    }
    this.output.length = 0;
  }
}

export class ACBBankService extends Gate {
  private jar: _request.CookieJar | undefined;
  private request: _request.RequestPromiseAPI | undefined = undefined;
  private dse_sessionId: string | undefined;
  private dse_processorId: string | undefined;
  private user_agent: string | undefined;

  protected async prepareSession() {
    if (!this.dse_sessionId) {
      await this.login();
    }
  }

  getBrowserDataDir() {
    return path.join(process.cwd(), '.browser-data', `acb-${this.config.name}`);
  }

  getProxyString() {
    if (this.proxy) {
      if (this.proxy.username && this.proxy.username.length > 0) {
        return `${this.proxy.schema}://${this.proxy.username}:${this.proxy.password}@${this.proxy.ip}:${this.proxy.port}`;
      }
      return `${this.proxy.schema}://${this.proxy.ip}:${this.proxy.port}`;
    }
    return undefined;
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

  async randomUserAgent(): Promise<string> {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
  }

  async promptSafekeyCode(
    writeOutput: (text: string) => void = (text) => {
      process.stdout.write(text);
    },
  ): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'ACB Safekey requires an interactive terminal. Run the service attached to a terminal or use browser verification.',
      );
    }

    return new Promise((resolve, reject) => {
      const input = process.stdin;
      const wasRaw = input.isRaw;
      let code = '';
      let settled = false;

      const cleanup = () => {
        input.off('data', onData);
        input.setRawMode(wasRaw);
        input.pause();
        writeOutput('\n');
      };

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve(code);
      };

      const onData = (chunk: Buffer | string) => {
        for (const char of chunk.toString()) {
          if (char === '\u0003') {
            settled = true;
            cleanup();
            process.kill(process.pid, 'SIGINT');
            return;
          }

          if (char === '\r' || char === '\n') {
            if (code.length === 6) {
              finish();
              return;
            }
            writeOutput('\u0007');
            continue;
          }

          if (char === '\u007f' || char === '\b') {
            if (code.length > 0) {
              code = code.slice(0, -1);
              writeOutput('\b \b');
            }
            continue;
          }

          if (/^\d$/.test(char) && code.length < 6) {
            code += char;
            writeOutput('*');
          }
        }
      };

      writeOutput('Nhập mã ACB Safekey gồm 6 số, rồi nhấn Enter: ');
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
    });
  }

  parseAcbHistory(html: string): Payment[] {
    const document = parse(html);
    const table = document.getElementById('table1');
    if (!table) {
      throw new Error(
        'ACB transaction history table was not found; the session may have expired',
      );
    }
    const rows = table.querySelectorAll('tr');

    const payments: Payment[] = [];

    // Skip header row
    for (let i = 1; i < rows.length - 1; i += 2) {
      try {
        const transactionRow = rows[i];
        const contentRow = rows[i + 1];

        const tds = transactionRow.querySelectorAll('td');

        // Check if this is a valid transaction row (should have 6 columns)
        if (tds.length === 6) {
          const date = tds[1].text.trim();

          const debitAmount = tds[3].text.trim();
          const creditAmount = tds[4].text.trim();

          // Get content from the next row (colspan=4)
          const contentCell = contentRow.querySelector('td[colspan="4"]');
          const content = contentCell ? contentCell.text.trim() : '';

          const transactionId = tds[2].text.trim();

          // Determine amount - credit
          const amount = parseInt(creditAmount.replace(/\./g, ''));

          // Only add if we have a valid date and amount
          if (date && !debitAmount && !isNaN(amount)) {
            payments.push({
              // 01/11/2024 23:37:01
              date: moment
                .tz(date, 'DD/MM/YYYY HH:mm:ss', 'Asia/Ho_Chi_Minh')
                .toDate(),
              transaction_id: 'acbbank-' + transactionId,
              amount: amount,
              content: content,
              gate: GateType.ACBBANK,
              account_receiver: this.config.account,
            });
          }
        }
      } catch (error) {
        console.error('Error processing row:', error);
        // Continue processing other rows even if one fails
        continue;
      }
    }

    return payments;
  }

  async login() {
    const safekeyConsole = process.env.ACB_SAFEKEY_CONSOLE === 'true';
    const manualLogin =
      process.env.ACB_MANUAL_LOGIN === 'true' || safekeyConsole;
    const showBrowser = manualLogin && !safekeyConsole;
    let outputBuffer: ProcessOutputBuffer | undefined;
    this.user_agent = await this.randomUserAgent();
    const context = await playwright.chromium.launchPersistentContext(
      this.getBrowserDataDir(),
      {
        headless: false,
        args: showBrowser ? [] : ['--headless=new'],
        userAgent: this.user_agent,
        locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh',
        viewport: {
          width: 1365,
          height: 768,
        },
        proxy: this.getChromProxy(),
      },
    );
    try {
      const page = context.pages()[0] || (await context.newPage());

      // Tiết kiệm băng thông
      if (this.proxy)
        await page.route('**/*', async (route) => {
          const url = route.request().url();
          const resourceType = route.request().resourceType();

          if (url.includes('Captcha.jpg')) {
            return route.continue();
          }
          if (['image', 'media'].includes(resourceType)) {
            return route.abort();
          }

          if (![`xhr`, `fetch`, `document`].includes(resourceType)) {
            try {
              const response = await axios.get(url, {
                responseType: 'arraybuffer',
              });
              return route.fulfill({
                status: response.status,
                headers: {},
                body: response.data,
              });
            } catch (error) {
              return route.abort();
            }
          }
          route.continue();
        });

      const waitForCaptcha = () =>
        page.waitForResponse(
          (response) =>
            response.url().includes('/Captcha.jpg') &&
            response.status() === 200,
          { timeout: 30000 },
        );

      let getCaptchaWaitResponse = waitForCaptcha();
      await page.goto('https://online.acb.com.vn/acbib/Request');

      let loginSucceeded = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const getCaptchaBuffer = await getCaptchaWaitResponse.then((d) =>
          d.body(),
        );
        const captchaBase64 = getCaptchaBuffer.toString('base64');
        const captchaText = await this.captchaSolver.solveCaptcha(
          captchaBase64,
        );

        await page.locator('#user-name').fill(this.config.login_id);
        await page.locator('#password').fill(this.config.password);
        await page.locator('#security-code').fill(captchaText);

        const nextCaptchaResponse = waitForCaptcha().catch(() => null);
        await Promise.allSettled([
          page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          }),
          page.locator('#security-code').press('Enter'),
        ]);

        if ((await page.getByText(this.config.account).count()) > 0) {
          loginSucceeded = true;
          break;
        }

        const pageText = await page.locator('body').innerText();
        if (pageText.includes('thiết bị hoặc trình duyệt mới')) {
          if (!manualLogin) {
            throw new Error(
              'ACB requires new-device verification. Restart once with ACB_MANUAL_LOGIN=true or ACB_SAFEKEY_CONSOLE=true',
            );
          }

          await page.locator('#safekey').check();
          await Promise.allSettled([
            page.waitForNavigation({
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            }),
            page.locator('#button').click(),
          ]);

          if (safekeyConsole) {
            await page
              .locator('#digit-1')
              .waitFor({ state: 'visible', timeout: 30000 });
            outputBuffer = new ProcessOutputBuffer();
            outputBuffer.start();
            const safekeyCode = await this.promptSafekeyCode((text) =>
              outputBuffer.writePrompt(text),
            );

            for (
              let digitIndex = 0;
              digitIndex < safekeyCode.length;
              digitIndex++
            ) {
              await page
                .locator(`#digit-${digitIndex + 1}`)
                .fill(safekeyCode[digitIndex]);
            }
            await page.evaluate((code) => {
              const otpInput =
                document.querySelector<HTMLInputElement>('#EdtOtp');
              if (otpInput) otpInput.value = code;
            }, safekeyCode);

            await Promise.allSettled([
              page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: 30000,
              }),
              page.locator('#button').click(),
            ]);
          } else {
            console.log(
              'Complete ACB Safekey verification in the opened browser window',
            );
          }

          try {
            await page
              .getByText(this.config.account)
              .first()
              .waitFor({
                state: 'visible',
                timeout: safekeyConsole ? 30000 : 5 * 60 * 1000,
              });
          } catch {
            const verificationPageText = await page.locator('body').innerText();
            const verificationError = verificationPageText
              .split('\n')
              .map((line) => line.trim())
              .find((line) =>
                [
                  'không đúng',
                  'không hợp lệ',
                  'hết hiệu lực',
                  'hết hạn',
                  'quá thời gian',
                ].some((message) => line.toLowerCase().includes(message)),
              );
            throw new Error(
              `ACB Safekey verification failed${
                verificationError ? `: ${verificationError}` : ''
              }`,
            );
          }
          loginSucceeded = true;
          break;
        }

        if (pageText.includes('Sai mã xác thực')) {
          if (attempt === 3) {
            throw new Error('ACB login failed: captcha is invalid');
          }

          const captchaResponse = await nextCaptchaResponse;
          if (!captchaResponse) {
            throw new Error('ACB login failed: captcha was not refreshed');
          }
          getCaptchaWaitResponse = Promise.resolve(captchaResponse);
          continue;
        }

        const loginError =
          pageText
            .split('\n')
            .map((line) => line.trim())
            .find(
              (line) =>
                line.includes('không đúng') ||
                line.includes('không hợp lệ') ||
                line.includes('bị khóa'),
            ) || 'Unknown login error';
        throw new Error(`ACB login failed: ${loginError}`);
      }

      if (!loginSucceeded) {
        throw new Error('ACB login failed');
      }

      const linkMyAccount = page.getByText(this.config.account).first();
      const linkMyAccountHref = await linkMyAccount.getAttribute('href');
      if (!linkMyAccountHref) {
        throw new Error('ACB account link was not found after login');
      }

      const cookie = await context.cookies();
      this.jar = _request.jar();
      for (const c of cookie) {
        this.jar.setCookie(`${c.name}=${c.value}`, 'https://' + c.domain);
      }
      this.request = _request.defaults({
        jar: this.jar,
        headers: {
          'User-Agent': this.user_agent,
        },
        followRedirect: true,
        followAllRedirects: true,
      });

      const dashboardPageHtml = await this.request(
        `https://online.acb.com.vn/acbib/${linkMyAccountHref}`,
        { proxy: this.getProxyString() },
      );

      this.dse_sessionId =
        /<input type="hidden" name="dse_sessionId" value="(.*?)"/gm.exec(
          dashboardPageHtml,
        )?.[1];
      this.dse_processorId =
        /<input type="hidden" name="dse_processorId" value="(.*?)"/gm.exec(
          dashboardPageHtml,
        )?.[1];

      if (outputBuffer) {
        outputBuffer.release('ACBBankService login success\n');
        outputBuffer = undefined;
      } else {
        console.log('ACBBankService login success');
      }
      await context.close();
    } catch (error) {
      outputBuffer?.release();
      await context.close();
      console.error('ACBBankService login error', error);
      throw error;
    }
  }

  async getHistory(): Promise<Payment[]> {
    if (!this.dse_sessionId) {
      await this.login();
      await sleep(1000);
    }

    try {
      return await this.fetchHistory();
    } catch (firstError) {
      const message =
        firstError instanceof Error ? firstError.message : String(firstError);
      console.warn(
        `ACBBankService history request failed, refreshing session: ${message}`,
      );
      this.clearSession();

      try {
        await this.login();
        await sleep(1000);
        return await this.fetchHistory();
      } catch (retryError) {
        console.error('ACBBankService history retry failed', retryError);
        this.clearSession();
        throw retryError;
      }
    }
  }

  private async fetchHistory(): Promise<Payment[]> {
    if (!this.request || !this.dse_sessionId || !this.dse_processorId) {
      throw new Error('ACB session is not initialized');
    }

    const fromDate = moment()
      .tz('Asia/Ho_Chi_Minh')
      .subtract(this.config.get_transaction_day_limit, 'days')
      .format('DD/MM/YYYY');
    const toDate = moment()
      .add(1, 'day')
      .tz('Asia/Ho_Chi_Minh')
      .format('DD/MM/YYYY');

    const dataSend = {
      dse_sessionId: this.dse_sessionId,
      dse_applicationId: '-1',
      dse_operationName: 'ibkacctDetailProc',
      dse_pageId: '4',
      dse_processorState: 'acctDetailPage',
      dse_processorId: this.dse_processorId,
      dse_errorPage: '/ibk/acctinquiry/trans.jsp',
      AccountNbr: this.config.account,
      virtualAccount: '',
      storeName: '',
      CheckRef: 'false',
      EdtRef: '',
      activeDatetimeYN: 'N',
      dse_nextEventName: 'byDate',
      FromDate: fromDate,
      ToDate: toDate,
    };

    const historyPageHtml = await this.request({
      uri: 'https://online.acb.com.vn/acbib/Request',
      method: 'POST',
      form: dataSend,
      proxy: this.getProxyString(),
    });

    return this.parseAcbHistory(historyPageHtml);
  }

  private clearSession() {
    this.request = undefined;
    this.jar = undefined;
    this.dse_sessionId = undefined;
    this.dse_processorId = undefined;
  }
}
