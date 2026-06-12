import { EventEmitter2 } from '@nestjs/event-emitter';
import { GateConfig, GateType } from '../gate.interface';
import { CaptchaSolverService } from 'src/captcha-solver/captcha-solver.service';
import { ProxyService } from 'src/proxy/proxy.service';
import { TPBankService } from './tpbank.services';

describe('TPBankService', () => {
  let service: TPBankService;

  const config: GateConfig = {
    name: 'tpbank_1',
    type: GateType.TPBANK,
    account: '123456789',
    login_id: 'test-login',
    password: 'test-password',
    device_id: 'test-device',
    repeat_interval_in_sec: 10,
    get_transaction_day_limit: 14,
    get_transaction_count_limit: 100,
  };

  beforeEach(() => {
    service = new TPBankService(
      config,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as CaptchaSolverService,
      {} as ProxyService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps the transaction time when TPBank returns a timestamp', () => {
    const payments = service['mapTransactions']([
      {
        id: 'tx-1',
        amount: '20000',
        description: 'PAYB8CS59XQP',
        creditDebitIndicator: 'CRDT',
        bookingDate: '2026-06-12T21:13:20+07:00',
      },
    ]);

    expect(payments[0]).toMatchObject({
      transaction_id: 'tpbank-tx-1',
      amount: 20000,
      content: 'PAYB8CS59XQP',
      account_receiver: '123456789',
      gate: GateType.TPBANK,
    });
    expect(payments[0].date.toISOString()).toBe('2026-06-12T14:13:20.000Z');
  });

  it('treats a date-only transaction from today as newly observed', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-12T14:15:00.000Z'));

    const payments = service['mapTransactions']([
      {
        id: 'tx-2',
        amount: 20000,
        description: 'PAYB8CS59XQP',
        creditDebitIndicator: 'CRDT',
        bookingDate: '2026-06-12',
      },
    ]);

    expect(payments[0].date.toISOString()).toBe('2026-06-12T14:15:00.000Z');
  });

  it('logs in again and retries once when transaction history returns 401', async () => {
    service['accessToken'] = 'expired-token';
    const fetchHistory = jest
      .spyOn(
        service as unknown as {
          fetchHistory: () => Promise<unknown[]>;
        },
        'fetchHistory',
      )
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce([]);
    const login = jest
      .spyOn(
        service as unknown as {
          login: () => Promise<void>;
        },
        'login',
      )
      .mockImplementation(async () => {
        service['accessToken'] = 'fresh-token';
      });

    await expect(service.getHistory()).resolves.toEqual([]);
    expect(login).toHaveBeenCalledTimes(1);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });
});
