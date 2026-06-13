import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_VCB_USER_AGENT,
  GateConfig,
  GateType,
} from 'src/gateways/gate.interface';
import { GatesManagerService } from 'src/gateways/gates-manager.services';
import { PaymentConfigService } from 'src/payment-config/payment-config.services';
import { PaymentService } from 'src/payments/payments.services';

type CreateBankInput = {
  name: string;
  type: GateType;
  enabled?: boolean;
  loginId?: string;
  password?: string;
  account: string;
  accountName?: string;
  bankId?: string;
  deviceId?: string;
  userAgent?: string;
};

type UpdateBankInput = Partial<Omit<CreateBankInput, 'name'>>;

@Injectable()
export class AdminService {
  private readonly supportedBankTypes = [
    GateType.ACBBANK,
    GateType.MBBANK,
    GateType.TPBANK,
    GateType.VCBBANK,
    GateType.TECHCOMBANK,
  ];

  constructor(
    private readonly paymentConfigService: PaymentConfigService,
    private readonly gatesManagerService: GatesManagerService,
    private readonly paymentService: PaymentService,
  ) {}

  async getOverview() {
    const banks = await this.getBanks();
    const payments = this.paymentService.getPayments();
    const today = new Date();
    const paymentsToday = payments.filter((payment) => {
      const date = new Date(payment.date);
      return (
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate()
      );
    });

    return {
      banks: {
        total: banks.length,
        enabled: banks.filter((bank) => bank.enabled).length,
        ready: banks.filter((bank) => bank.status.state === 'ready').length,
        errors: banks.filter((bank) => bank.status.state === 'error').length,
      },
      transactions: {
        total: payments.length,
        today: paymentsToday.length,
        todayAmount: paymentsToday.reduce(
          (total, payment) => total + payment.amount,
          0,
        ),
      },
      recentTransactions: payments.slice(0, 5),
    };
  }

  async getBanks() {
    const gateways = await this.paymentConfigService.getConfigPath<GateConfig>(
      'gateways',
    );

    return gateways
      .filter((gateway) => this.supportedBankTypes.includes(gateway.type))
      .map((gateway) => ({
        name: gateway.name,
        type: gateway.type,
        enabled: gateway.enabled !== false,
        account: gateway.account,
        accountName: gateway.account_name || '',
        bankId: gateway.bank_id || this.getDefaultBankId(gateway.type),
        maskedLoginId: this.maskValue(gateway.login_id),
        deviceIdConfigured: Boolean(gateway.device_id),
        userAgent: gateway.user_agent || '',
        passwordConfigured: Boolean(gateway.password),
        status: this.gatesManagerService.getGateStatus(gateway.name),
      }));
  }

  async createBank(input: CreateBankInput) {
    if (!this.supportedBankTypes.includes(input.type)) {
      throw new BadRequestException('Ngân hàng không được hỗ trợ');
    }
    if (await this.paymentConfigService.getGateway(input.name)) {
      throw new ConflictException('Tên gateway đã tồn tại');
    }

    const config = this.gatesManagerService.validateBanksConfig([
      {
        name: input.name,
        type: input.type,
        enabled: input.enabled !== false,
        login_id: input.loginId?.trim() || undefined,
        password: input.password || undefined,
        account: input.account,
        account_name: input.accountName || '',
        bank_id: input.bankId || this.getDefaultBankId(input.type),
        device_id: input.deviceId || undefined,
        user_agent:
          input.userAgent?.trim() ||
          (input.type === GateType.VCBBANK
            ? DEFAULT_VCB_USER_AGENT
            : undefined),
        repeat_interval_in_sec: 10,
        get_transaction_day_limit: 14,
        get_transaction_count_limit: 100,
        token: undefined,
      },
    ])[0];

    const { name, ...storedConfig } = config;
    await this.paymentConfigService.upsertGateway(name, storedConfig);
    await this.gatesManagerService.applyGatewayConfig(config);
    return this.getBank(name);
  }

  async toggleBank(name: string, enabled: boolean) {
    const existing = await this.paymentConfigService.getGateway(name);
    if (!existing) throw new NotFoundException('Không tìm thấy gateway');

    const config = this.gatesManagerService.validateBanksConfig([
      { name, ...existing, enabled },
    ])[0];
    await this.paymentConfigService.setGatewayEnabled(name, enabled);
    await this.gatesManagerService.applyGatewayConfig(config);
    return this.getBank(name);
  }

  async updateBank(name: string, input: UpdateBankInput) {
    const existing = await this.paymentConfigService.getGateway(name);
    if (!existing) throw new NotFoundException('Không tìm thấy gateway');

    const type = input.type || existing.type;
    if (!this.supportedBankTypes.includes(type)) {
      throw new BadRequestException('Ngân hàng không được hỗ trợ');
    }

    const config = this.gatesManagerService.validateBanksConfig([
      {
        name,
        ...existing,
        type,
        enabled:
          input.enabled === undefined
            ? existing.enabled !== false
            : input.enabled,
        login_id: input.loginId?.trim() || existing.login_id,
        password: input.password || existing.password,
        account: input.account?.trim() || existing.account,
        account_name:
          input.accountName === undefined
            ? existing.account_name
            : input.accountName.trim(),
        bank_id:
          input.bankId?.trim() ||
          existing.bank_id ||
          this.getDefaultBankId(type),
        device_id: input.deviceId?.trim() || existing.device_id,
        user_agent:
          input.userAgent?.trim() ||
          existing.user_agent ||
          (type === GateType.VCBBANK ? DEFAULT_VCB_USER_AGENT : undefined),
      },
    ])[0];

    const { name: gatewayName, ...storedConfig } = config;
    await this.paymentConfigService.upsertGateway(gatewayName, storedConfig);
    await this.gatesManagerService.applyGatewayConfig(config);
    return this.getBank(name);
  }

  getTransactions(query?: string, gate?: string, limit = 200) {
    const normalizedQuery = (query || '').trim().toLowerCase();
    return this.paymentService
      .getPayments()
      .filter((payment) => !gate || payment.gate === gate)
      .filter((payment) => {
        if (!normalizedQuery) return true;
        return [
          payment.transaction_id,
          payment.content,
          payment.account_receiver,
        ].some((value) =>
          String(value || '')
            .toLowerCase()
            .includes(normalizedQuery),
        );
      })
      .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500));
  }

  private async getBank(name: string) {
    const bank = (await this.getBanks()).find((item) => item.name === name);
    if (!bank) throw new NotFoundException('Không tìm thấy gateway');
    return bank;
  }

  private getDefaultBankId(type: GateType) {
    return {
      [GateType.MBBANK]: '970422',
      [GateType.ACBBANK]: '970416',
      [GateType.TPBANK]: '970423',
      [GateType.VCBBANK]: '970436',
      [GateType.TECHCOMBANK]: '970407',
    }[type];
  }

  private maskValue(value?: string) {
    if (!value) return '';
    if (value.length <= 4) return value;
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
}
