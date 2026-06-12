import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GatesManagerService } from 'src/gateways/gates-manager.services';
import { GateType, Payment } from 'src/gateways/gate.interface';
import { CheckoutService } from './checkout.service';

describe('CheckoutService', () => {
  const target = {
    gatewayName: 'mb_bank_1',
    type: GateType.MBBANK,
    bankId: '970422',
    bankName: 'MB Bank',
    accountNo: '123456789',
    accountName: 'NGUYEN VAN A',
  };

  const gatesManager = {
    getPaymentTargets: jest.fn(() => [target]),
    scanGateOnce: jest.fn(),
  } as unknown as GatesManagerService;

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'PAYMENT_CHECK_TIMEOUT_SEC') return 30;
      if (key === 'PAYMENT_CHECK_INTERVAL_SEC') return 0;
      if (key === 'PAYMENT_CHECK_MAX_ATTEMPTS') return 2;
      return undefined;
    }),
  } as unknown as ConfigService;

  const eventEmitter = {
    emit: jest.fn(),
  } as unknown as EventEmitter2;

  let service: CheckoutService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CheckoutService(gatesManager, configService, eventEmitter);
  });

  it('creates a qr_only VietQR request with a unique transfer description', () => {
    const request = service.create({
      amount: 125000,
      gatewayName: target.gatewayName,
    });

    expect(request.description).toMatch(/^PAY[A-Z2-9]{9}$/);
    expect(request.qrUrl).toContain(
      'https://img.vietqr.io/image/970422-123456789-qr_only.png',
    );
    expect(request.qrUrl).toContain('amount=125000');
    expect(request.qrUrl).toContain(`addInfo=${request.description}`);
    expect(request.status).toBe('pending');
  });

  it('requires a minimum payment amount of 2,000 VND', () => {
    expect(() =>
      service.create({
        amount: 1999,
        gatewayName: target.gatewayName,
      }),
    ).toThrow('Số tiền phải là số nguyên từ 2.000');

    expect(
      service.create({
        amount: 2000,
        gatewayName: target.gatewayName,
      }).amount,
    ).toBe(2000);
  });

  it('marks the request successful only when account, amount and content match', async () => {
    const request = service.create({
      amount: 125000,
      gatewayName: target.gatewayName,
    });
    const payment: Payment = {
      transaction_id: 'mbbank-test-1',
      amount: request.amount,
      content: `NAPAS TRANSFER ${request.description}`,
      account_receiver: target.accountNo,
      gate: GateType.MBBANK,
      date: new Date(),
    };
    (gatesManager.scanGateOnce as jest.Mock).mockResolvedValue([payment]);

    const result = await service.verify(request.id);

    expect(result.status).toBe('success');
    expect(result.payment).toEqual(payment);
    expect(eventEmitter.emit).toHaveBeenCalledWith('payment.history-updated', [
      payment,
    ]);
  });

  it('returns failed when no transaction matches', async () => {
    const request = service.create({
      amount: 125000,
      gatewayName: target.gatewayName,
    });
    (gatesManager.scanGateOnce as jest.Mock).mockResolvedValue([]);

    const result = await service.verify(request.id);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe(
      'Giao dịch thất bại, vui lòng kiểm tra lại',
    );
    expect(gatesManager.scanGateOnce).toHaveBeenCalledTimes(2);
  });
});
