import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes, randomUUID } from 'crypto';
import { GatesManagerService } from 'src/gateways/gates-manager.services';
import { Payment } from 'src/gateways/gate.interface';
import { PAYMENT_HISTORY_UPDATED } from 'src/shards/events';
import { sleep } from 'src/shards/helpers/sleep';

type CheckoutStatus = 'pending' | 'checking' | 'success' | 'failed' | 'expired';

type PaymentTarget = {
  gatewayName: string;
  type: string;
  bankId: string;
  bankName: string;
  accountNo: string;
  accountName: string;
};

type CheckoutRequest = {
  id: string;
  amount: number;
  description: string;
  status: CheckoutStatus;
  target: PaymentTarget;
  qrUrl: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  failureReason?: string;
  payment?: Payment;
};

@Injectable()
export class CheckoutService {
  private readonly requests = new Map<string, CheckoutRequest>();
  private readonly verifications = new Map<string, Promise<CheckoutRequest>>();

  constructor(
    private readonly gatesManager: GatesManagerService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  getTargets(): PaymentTarget[] {
    return this.gatesManager.getPaymentTargets() as PaymentTarget[];
  }

  create(input: { amount: number; gatewayName: string }): CheckoutRequest {
    const amount = Number(input.amount);
    if (
      !Number.isSafeInteger(amount) ||
      amount < 2000 ||
      amount > 9999999999999
    ) {
      throw new BadRequestException(
        'Số tiền phải là số nguyên từ 2.000 đến 9.999.999.999.999 VND',
      );
    }

    const target = this.getTargets().find(
      (item) => item.gatewayName === input.gatewayName,
    );
    if (!target) {
      throw new BadRequestException('Tài khoản nhận tiền không hợp lệ');
    }

    const now = new Date();
    const description = this.generateDescription();
    const request: CheckoutRequest = {
      id: randomUUID(),
      amount,
      description,
      status: 'pending',
      target,
      qrUrl: this.buildQrUrl(target, amount, description),
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    };

    this.removeOldRequests();
    this.requests.set(request.id, request);
    return request;
  }

  getById(id: string): CheckoutRequest {
    const request = this.requests.get(id);
    if (!request)
      throw new NotFoundException('Không tìm thấy yêu cầu thanh toán');

    if (
      request.status !== 'success' &&
      request.expiresAt.getTime() < Date.now()
    ) {
      request.status = 'expired';
      request.updatedAt = new Date();
      request.failureReason = 'Yêu cầu thanh toán đã hết hạn';
    }

    return request;
  }

  verify(id: string): Promise<CheckoutRequest> {
    const running = this.verifications.get(id);
    if (running) return running;

    const verification = this.verifyRequest(id).finally(() => {
      this.verifications.delete(id);
    });
    this.verifications.set(id, verification);
    return verification;
  }

  private async verifyRequest(id: string): Promise<CheckoutRequest> {
    const request = this.getById(id);
    if (request.status === 'success' || request.status === 'expired') {
      return request;
    }

    request.status = 'checking';
    request.failureReason = undefined;
    request.updatedAt = new Date();

    const timeoutSeconds = Number(
      this.configService.get('PAYMENT_CHECK_TIMEOUT_SEC') ?? 30,
    );
    const intervalSeconds = Number(
      this.configService.get('PAYMENT_CHECK_INTERVAL_SEC') ?? 15,
    );
    const maxAttempts = Number(
      this.configService.get('PAYMENT_CHECK_MAX_ATTEMPTS') ?? 2,
    );
    const deadline = Date.now() + timeoutSeconds * 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptDeadline = Math.min(
        deadline,
        Date.now() + intervalSeconds * 1000,
      );

      try {
        const scanPromise = this.gatesManager
          .scanGateOnce(request.target.gatewayName)
          .then((payments) => ({ payments, timedOut: false }));
        const attemptTimeLeft = Math.max(0, attemptDeadline - Date.now());
        const result =
          attemptTimeLeft > 0
            ? await Promise.race([
                scanPromise,
                sleep(attemptTimeLeft).then(() => ({
                  payments: [] as Payment[],
                  timedOut: true,
                })),
              ])
            : await scanPromise;

        const matched = result.payments.find((payment) =>
          this.isMatchingPayment(request, payment),
        );

        if (matched) {
          request.status = 'success';
          request.payment = matched;
          request.updatedAt = new Date();
          this.eventEmitter.emit(PAYMENT_HISTORY_UPDATED, [matched]);
          return request;
        }
      } catch (error) {
        request.status = 'failed';
        request.updatedAt = new Date();
        request.failureReason =
          error instanceof Error
            ? `Không thể lấy lịch sử giao dịch: ${error.message}`
            : 'Không thể lấy lịch sử giao dịch';
        return request;
      }

      const remainingAttemptTime = attemptDeadline - Date.now();
      if (remainingAttemptTime > 0) {
        await sleep(remainingAttemptTime);
      }

      if (Date.now() >= deadline) break;
    }

    request.status = 'failed';
    request.updatedAt = new Date();
    request.failureReason = 'Giao dịch thất bại, vui lòng kiểm tra lại';
    return request;
  }

  private isMatchingPayment(
    request: CheckoutRequest,
    payment: Payment,
  ): boolean {
    const createdThreshold = request.createdAt.getTime() - 2 * 60 * 1000;

    return (
      payment.amount === request.amount &&
      this.normalize(payment.account_receiver) ===
        this.normalize(request.target.accountNo) &&
      this.normalize(payment.content).includes(
        this.normalize(request.description),
      ) &&
      new Date(payment.date).getTime() >= createdThreshold
    );
  }

  private buildQrUrl(
    target: PaymentTarget,
    amount: number,
    description: string,
  ) {
    const path = `${encodeURIComponent(target.bankId)}-${encodeURIComponent(
      target.accountNo,
    )}-qr_only.png`;
    const params = new URLSearchParams({
      amount: String(amount),
      addInfo: description,
    });
    if (target.accountName) {
      params.set('accountName', target.accountName);
    }
    return `https://img.vietqr.io/image/${path}?${params.toString()}`;
  }

  private generateDescription() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(9);
    let value = 'PAY';
    for (const byte of bytes) {
      value += alphabet[byte % alphabet.length];
    }
    return value;
  }

  private normalize(value: string | undefined) {
    return (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  private removeOldRequests() {
    const retention = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, request] of this.requests) {
      if (request.createdAt.getTime() < retention) {
        this.requests.delete(id);
      }
    }
  }
}
