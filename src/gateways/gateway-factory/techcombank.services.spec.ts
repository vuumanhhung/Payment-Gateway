import { EventEmitter2 } from '@nestjs/event-emitter';
import { GateConfig, GateType } from '../gate.interface';
import { CaptchaSolverService } from 'src/captcha-solver/captcha-solver.service';
import { ProxyService } from 'src/proxy/proxy.service';
import { TechcombankService } from './techcombank.services';

describe('TechcombankService', () => {
  let service: TechcombankService;

  const config: GateConfig = {
    name: 'techcombank_1',
    type: GateType.TECHCOMBANK,
    account: '1234567890',
    account_name: 'VU MANH HUNG',
    bank_id: '970407',
    repeat_interval_in_sec: 10,
    get_transaction_day_limit: 14,
    get_transaction_count_limit: 100,
  };

  beforeEach(() => {
    service = new TechcombankService(
      config,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as CaptchaSolverService,
      {} as ProxyService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    service.destroy();
  });

  it('maps Techcombank credit transactions for the configured account', () => {
    const payments = service.mapTransactions(
      [
        {
          id: 'tx-1',
          arrangementId: 'arrangement-1',
          reference: 'FT26164940582071\\BNK',
          description: 'VU MANH HUNG CHUYEN KHOAN PAYABC123',
          creditDebitIndicator: 'CRDT',
          transactionAmountCurrency: {
            amount: '11568',
            currencyCode: 'VND',
          },
          creationTime: '2026-06-13T16:18:32+07:00',
          additions: {
            additionalInfo:
              '{"PAY.DETAILS":"VU MANH HUNG CHUYEN KHOAN PAYABC123"}',
          },
        },
      ],
      [
        {
          id: 'arrangement-1',
          BBAN: '1234567890',
        },
      ],
    );

    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      transaction_id: 'techcombank-tx-1',
      amount: 11568,
      content:
        'VU MANH HUNG CHUYEN KHOAN PAYABC123 VU MANH HUNG CHUYEN KHOAN PAYABC123 FT26164940582071\\BNK',
      account_receiver: '1234567890',
      gate: GateType.TECHCOMBANK,
    });
    expect(payments[0].date.toISOString()).toBe('2026-06-13T09:18:32.000Z');
  });

  it('ignores debit transactions and credits for another account', () => {
    const payments = service.mapTransactions(
      [
        {
          id: 'tx-1',
          arrangementId: 'arrangement-1',
          description: 'PAYABC123',
          creditDebitIndicator: 'DBIT',
          transactionAmountCurrency: { amount: '1000' },
        },
        {
          id: 'tx-2',
          arrangementId: 'arrangement-2',
          description: 'PAYABC123',
          creditDebitIndicator: 'CRDT',
          transactionAmountCurrency: { amount: '1000' },
        },
      ],
      [
        { id: 'arrangement-1', BBAN: '1234567890' },
        { id: 'arrangement-2', BBAN: '9988776655' },
      ],
    );

    expect(payments).toEqual([]);
  });

  it('treats a date-only transaction from today as newly observed', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-13T10:20:00.000Z'));

    const date = service.parseTransactionDate({
      bookingDate: '2026-06-13',
    });

    expect(date.toISOString()).toBe('2026-06-13T10:20:00.000Z');
  });
});
