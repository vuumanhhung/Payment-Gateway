import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import * as Joi from 'joi';
import { CaptchaSolverService } from 'src/captcha-solver/captcha-solver.service';
import { Gate } from 'src/gateways/gates.services';
import { PaymentConfigService } from 'src/payment-config/payment-config.services';
import { ProxyService } from '../proxy/proxy.service';
import { GateConfig, GateType } from './gate.interface';
import { GateFactory } from './gateway-factory/gate.factory';

@Injectable()
export class GatesManagerService implements OnApplicationBootstrap {
  private gates: Gate[] = [];
  private gateScans = new Map<string, ReturnType<Gate['getHistory']>>();
  private gateStatuses = new Map<
    string,
    {
      state:
        | 'idle'
        | 'connecting'
        | 'ready'
        | 'scanning'
        | 'error'
        | 'disabled';
      message?: string;
      updatedAt: Date;
    }
  >();
  private logger = new Logger(GatesManagerService.name);
  constructor(
    private readonly paymentConfigService: PaymentConfigService,
    private readonly gateFactory: GateFactory,
    private eventEmitter: EventEmitter2,
    private readonly captchaSolverService: CaptchaSolverService,
    private readonly proxyService: ProxyService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    const banksConfigInput =
      await this.paymentConfigService.getConfigPath<GateConfig>('gateways');

    const banksConfigValidated = this.validateBanksConfig(banksConfigInput);

    this.createGates(banksConfigValidated);

    if (this.configService.get('GATEWAY_PRELOGIN') === 'true') {
      await this.warmUpGates();
    }

    if (this.configService.get('GATEWAY_AUTO_CRON') === 'true') {
      this.startAllCron();
    }
  }

  createGates(banksConfig: GateConfig[]) {
    this.gates.forEach((gate) => gate.destroy());
    this.gates = [];

    for (const bankConfig of banksConfig) {
      if (bankConfig.enabled === false) {
        this.setGateStatus(bankConfig.name, 'disabled');
        continue;
      }

      const gate = this.createGate(bankConfig);
      this.gates.push(gate);
      this.setGateStatus(bankConfig.name, 'idle');
    }
  }

  async warmUpGates() {
    this.logger.log('Pre-login ngân hàng, chưa lấy lịch sử giao dịch...');

    for (const gate of this.gates) {
      await this.warmUpGate(gate);
    }

    this.logger.log('Hoàn tất pre-login. Service đang chờ lệnh đối chiếu.');
  }

  validateBanksConfig(banksConfig: GateConfig[]): GateConfig[] {
    const gateConfigSchema = Joi.object({
      name: Joi.string().required(),
      type: Joi.valid(...Object.values(GateType)).required(),
      enabled: Joi.boolean().default(true),
      repeat_interval_in_sec: Joi.number().min(1).max(120).required(),
      password: Joi.string().when('type', {
        is: [
          GateType.MBBANK,
          GateType.ACBBANK,
          GateType.TPBANK,
          GateType.VCBBANK,
        ],
        then: Joi.required(),
      }),
      login_id: Joi.string().when('type', {
        is: [
          GateType.MBBANK,
          GateType.ACBBANK,
          GateType.TPBANK,
          GateType.VCBBANK,
        ],
        then: Joi.required(),
      }),
      device_id: Joi.string().when('type', {
        is: [GateType.VCBBANK, GateType.TPBANK],
        then: Joi.required(),
      }),
      user_agent: Joi.string().max(500).allow(''),
      token: Joi.string(),
      account: Joi.string().required(),
      account_name: Joi.string().max(50).allow(''),
      bank_id: Joi.string().max(20).allow(''),
      proxy: Joi.string(),
      get_transaction_day_limit: Joi.number().min(1).max(100).default(14),
      get_transaction_count_limit: Joi.number().min(1).max(100).default(100),
    });

    const banksConfigRes: GateConfig[] = [];
    for (const bankConfig of banksConfig) {
      const { error, value } = gateConfigSchema.validate(bankConfig);

      if (error) {
        throw new Error(
          `config.yml is invalid: ${error.message} on ${bankConfig.name}`,
        );
      }
      banksConfigRes.push(value);
    }
    return banksConfigRes;
  }

  getGateStatus(name: string) {
    return (
      this.gateStatuses.get(name) || {
        state: 'disabled' as const,
        updatedAt: new Date(),
      }
    );
  }

  async applyGatewayConfig(config: GateConfig) {
    const existingIndex = this.gates.findIndex(
      (gate) => gate.getName() === config.name,
    );
    if (existingIndex >= 0) {
      this.gates[existingIndex].destroy();
      this.gates.splice(existingIndex, 1);
    }

    if (config.enabled === false) {
      this.setGateStatus(config.name, 'disabled');
      return;
    }

    const gate = this.createGate(config);
    this.gates.push(gate);
    this.setGateStatus(config.name, 'idle');

    if (this.configService.get('GATEWAY_PRELOGIN') === 'true') {
      void this.warmUpGate(gate).finally(() => {
        if (this.configService.get('GATEWAY_AUTO_CRON') === 'true') {
          gate.startCron();
        }
      });
    } else if (this.configService.get('GATEWAY_AUTO_CRON') === 'true') {
      gate.startCron();
    }
  }

  getPaymentTargets() {
    const bankDetails = {
      [GateType.MBBANK]: { bankId: '970422', bankName: 'MB Bank' },
      [GateType.ACBBANK]: { bankId: '970416', bankName: 'ACB' },
      [GateType.TPBANK]: { bankId: '970423', bankName: 'TPBank' },
      [GateType.VCBBANK]: { bankId: '970436', bankName: 'Vietcombank' },
      [GateType.TECHCOMBANK]: {
        bankId: '970407',
        bankName: 'Techcombank',
      },
    };

    return this.gates
      .map((gate) => {
        const config = gate.getConfig();
        const bank = bankDetails[config.type];
        if (!bank) return null;

        return {
          gatewayName: config.name,
          type: config.type,
          bankId: config.bank_id || bank.bankId,
          bankName: bank.bankName,
          accountNo: config.account,
          accountName: config.account_name || '',
        };
      })
      .filter(Boolean);
  }

  scanGateOnce(name: string) {
    const gate = this.gates.find((item) => item.getName() === name);
    if (!gate) throw new NotFoundException({ error: 'Gate not found' });

    const runningScan = this.gateScans.get(name);
    if (runningScan) return runningScan;

    this.setGateStatus(name, 'scanning');
    const scan = gate
      .scanOnce()
      .then((payments) => {
        this.setGateStatus(name, 'ready');
        return payments;
      })
      .catch((error) => {
        this.setGateStatus(
          name,
          'error',
          error instanceof Error ? error.message : 'Unknown scan error',
        );
        throw error;
      })
      .finally(() => {
        this.gateScans.delete(name);
      });
    this.gateScans.set(name, scan);
    return scan;
  }

  stopCron(name: string, timeInSec: number) {
    const gate = this.gates.find((gate) => gate.getName() === name);
    if (!gate) throw new NotFoundException({ error: 'Gate not found' });

    gate.stopCron();
    setTimeout(() => {
      gate.startCron();
    }, timeInSec * 1000);
  }
  stopAllCron(timeInMinutes: number = 5) {
    this.logger.log(`Stop all cron jobs in ${timeInMinutes} minutes`);
    this.gates.forEach((gate) => gate.stopCron());
    setTimeout(() => {
      this.startAllCron();
    }, timeInMinutes * 60000);
  }
  startAllCron() {
    this.logger.log(`Start all cron jobs`);
    this.gates.forEach((gate) => gate.startCron());
  }

  private createGate(config: GateConfig) {
    return this.gateFactory.create(
      config,
      this.eventEmitter,
      this.captchaSolverService,
      this.proxyService,
    );
  }

  private async warmUpGate(gate: Gate) {
    const name = gate.getName();
    try {
      this.setGateStatus(name, 'connecting');
      this.logger.log(`[${name}] Đang đăng nhập...`);
      await gate.warmUp();
      this.setGateStatus(name, 'ready');
      this.logger.log(`[${name}] Đăng nhập sẵn thành công`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown login error';
      this.setGateStatus(name, 'error', message);
      this.logger.error(`[${name}] Đăng nhập sẵn thất bại: ${message}`);
    }
  }

  private setGateStatus(
    name: string,
    state: 'idle' | 'connecting' | 'ready' | 'scanning' | 'error' | 'disabled',
    message?: string,
  ) {
    this.gateStatuses.set(name, {
      state,
      message,
      updatedAt: new Date(),
    });
  }
}
