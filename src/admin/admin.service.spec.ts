import { NotFoundException } from '@nestjs/common';
import { DEFAULT_VCB_USER_AGENT, GateType } from 'src/gateways/gate.interface';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  const existingGateway = {
    type: GateType.VCBBANK,
    enabled: true,
    login_id: 'old-login',
    password: 'old-password',
    account: '123456789',
    account_name: 'OLD NAME',
    bank_id: '970436',
    device_id: 'old-device',
    user_agent: 'old-user-agent',
    repeat_interval_in_sec: 10,
    get_transaction_day_limit: 14,
    get_transaction_count_limit: 100,
  };

  const paymentConfigService = {
    getGateway: jest.fn(),
    upsertGateway: jest.fn(),
    getConfigPath: jest.fn(),
  };
  const gatesManagerService = {
    validateBanksConfig: jest.fn((configs) => configs),
    applyGatewayConfig: jest.fn(),
    getGateStatus: jest.fn(() => ({ state: 'ready' })),
  };
  const paymentService = {
    getPayments: jest.fn(() => []),
  };

  const service = new AdminService(
    paymentConfigService as any,
    gatesManagerService as any,
    paymentService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    paymentConfigService.getGateway.mockResolvedValue(existingGateway);
    paymentConfigService.getConfigPath.mockResolvedValue([
      { name: 'vcb_1', ...existingGateway, account_name: 'NEW NAME' },
    ]);
  });

  it('updates editable fields and keeps blank credentials', async () => {
    await service.updateBank('vcb_1', {
      loginId: '',
      password: '',
      deviceId: '',
      userAgent: '',
      accountName: 'NEW NAME',
    });

    expect(paymentConfigService.upsertGateway).toHaveBeenCalledWith(
      'vcb_1',
      expect.objectContaining({
        login_id: 'old-login',
        password: 'old-password',
        device_id: 'old-device',
        user_agent: 'old-user-agent',
        account_name: 'NEW NAME',
      }),
    );
    expect(gatesManagerService.applyGatewayConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'vcb_1',
        login_id: 'old-login',
        password: 'old-password',
        device_id: 'old-device',
        user_agent: 'old-user-agent',
      }),
    );
  });

  it('updates the VCB user agent', async () => {
    await service.updateBank('vcb_1', {
      userAgent: 'new-user-agent',
    });

    expect(paymentConfigService.upsertGateway).toHaveBeenCalledWith(
      'vcb_1',
      expect.objectContaining({
        user_agent: 'new-user-agent',
      }),
    );
  });

  it('uses the default user agent when creating a VCB gateway', async () => {
    paymentConfigService.getGateway.mockResolvedValue(undefined);
    paymentConfigService.getConfigPath.mockResolvedValue([
      {
        name: 'vcb_new',
        ...existingGateway,
        login_id: 'new-login',
        password: 'new-password',
        account: '987654321',
        device_id: 'new-device',
        user_agent: DEFAULT_VCB_USER_AGENT,
      },
    ]);

    await service.createBank({
      name: 'vcb_new',
      type: GateType.VCBBANK,
      loginId: 'new-login',
      password: 'new-password',
      account: '987654321',
      deviceId: 'new-device',
    });

    expect(paymentConfigService.upsertGateway).toHaveBeenCalledWith(
      'vcb_new',
      expect.objectContaining({
        user_agent: DEFAULT_VCB_USER_AGENT,
      }),
    );
  });

  it('creates a Techcombank gateway without login credentials', async () => {
    paymentConfigService.getGateway.mockResolvedValue(undefined);
    paymentConfigService.getConfigPath.mockResolvedValue([
      {
        name: 'techcombank_1',
        type: GateType.TECHCOMBANK,
        enabled: true,
        account: '1234567890',
        account_name: 'VU MANH HUNG',
        bank_id: '970407',
        repeat_interval_in_sec: 10,
        get_transaction_day_limit: 14,
        get_transaction_count_limit: 100,
      },
    ]);

    await service.createBank({
      name: 'techcombank_1',
      type: GateType.TECHCOMBANK,
      account: '1234567890',
      accountName: 'VU MANH HUNG',
    });

    expect(paymentConfigService.upsertGateway).toHaveBeenCalledWith(
      'techcombank_1',
      expect.objectContaining({
        type: GateType.TECHCOMBANK,
        bank_id: '970407',
        account: '1234567890',
      }),
    );
  });

  it('rejects an unknown gateway', async () => {
    paymentConfigService.getGateway.mockResolvedValue(undefined);

    await expect(service.updateBank('missing', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
